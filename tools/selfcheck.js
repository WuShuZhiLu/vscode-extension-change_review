'use strict';

/**
 * 在真实 git 仓库里验证 gitService / diffParser 的核心逻辑。
 * 运行：node tools/selfcheck.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const git = require('../src/gitService');
const { parseDiff } = require('../src/diffParser');

const ROOT = path.join(os.tmpdir(), `cr-selfcheck-${Date.now()}`);
let failures = 0;

function check(name, cond, extra) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`);
  }
}

function g(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
}

function write(rel, content) {
  const p = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

async function main() {
  fs.mkdirSync(ROOT, { recursive: true });
  console.log(`临时仓库：${ROOT}`);

  g(['init', '-q']);
  g(['config', 'user.email', 'self@check.local']);
  g(['config', 'user.name', 'Self Check']);
  g(['config', 'commit.gpgsign', 'false']);
  g(['config', 'core.autocrlf', 'false']); // 避免换行符干扰断言

  const orig = [];
  for (let i = 1; i <= 20; i += 1) { orig.push(`line ${i}`); }
  write('a.txt', orig.join('\n') + '\n');
  write('c.txt', 'to be deleted\n');
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'init']);

  // 制造改动：a.txt 两处修改（两个 hunk），b.txt 新文件，c.txt 删除
  const modified = orig.slice();
  modified[1] = 'line 2 CHANGED';
  modified[11] = 'line 12 CHANGED';
  write('a.txt', modified.join('\n') + '\n');
  fs.unlinkSync(path.join(ROOT, 'c.txt'));
  write('b.txt', 'b1\nb2\nb3\nb4\nb5\n');

  console.log('\n[1] getChanges');
  const changes = await git.getChanges(ROOT);
  const byPath = new Map(changes.map((f) => [f.relPath, f]));
  console.log('   ', changes.map((f) => `${f.relPath}(${f.kind} +${f.added} -${f.removed})`).join(', '));
  check('识别出 3 个改动文件', changes.length === 3, JSON.stringify(changes.map((f) => f.relPath)));
  check('a.txt 为 modified 且 +2 -2', byPath.get('a.txt') && byPath.get('a.txt').kind === 'modified' && byPath.get('a.txt').added === 2 && byPath.get('a.txt').removed === 2,
    JSON.stringify(byPath.get('a.txt')));
  check('b.txt 为 untracked 且 +5', byPath.get('b.txt') && byPath.get('b.txt').kind === 'untracked' && byPath.get('b.txt').added === 5,
    JSON.stringify(byPath.get('b.txt')));
  check('c.txt 为 deleted 且 -1', byPath.get('c.txt') && byPath.get('c.txt').kind === 'deleted' && byPath.get('c.txt').removed === 1,
    JSON.stringify(byPath.get('c.txt')));

  console.log('\n[2] getDiff + parseDiff');
  const diffA = await git.getDiff(ROOT, byPath.get('a.txt'), 3);
  const parsedA = parseDiff(diffA);
  check('a.txt 解析出 1 个文件', parsedA.length === 1);
  check('a.txt 解析出 2 个改动块', parsedA[0].hunks.length === 2, `实际 ${parsedA[0] && parsedA[0].hunks.length}`);
  check('第 1 块 +1 -1', parsedA[0].hunks[0].added === 1 && parsedA[0].hunks[0].removed === 1);
  const diffB = await git.getDiff(ROOT, byPath.get('b.txt'), 3);
  const parsedB = parseDiff(diffB);
  check('未跟踪文件也能拿到 diff（+5）', parsedB[0] && parsedB[0].hunks.length === 1 && parsedB[0].hunks[0].added === 5,
    parsedB[0] ? JSON.stringify({ h: parsedB[0].hunks.length }) : 'no parse');
  const diffC = await git.getDiff(ROOT, byPath.get('c.txt'), 3);
  check('删除文件也能拿到 diff', parseDiff(diffC)[0].hunks[0].removed === 1);

  console.log('\n[3] revertHunk（只还原第 1 块）');
  await git.revertHunk(ROOT, byPath.get('a.txt'), 0, 3);
  const afterRevert = read('a.txt').split('\n');
  check('line 2 已还原', afterRevert[1] === 'line 2', afterRevert[1]);
  check('line 12 仍保留改动', afterRevert[11] === 'line 12 CHANGED', afterRevert[11]);
  const revertDiff = parseDiff(await git.getDiff(ROOT, (await git.getChanges(ROOT)).find((f) => f.relPath === 'a.txt'), 3));
  check('剩余 1 个改动块', revertDiff[0].hunks.length === 1, `实际 ${revertDiff[0].hunks.length}`);

  console.log('\n[4] acceptFile（暂存）');
  await git.acceptFile(ROOT, (await git.getChanges(ROOT)).find((f) => f.relPath === 'b.txt'));
  const statusAfterAdd = g(['status', '--porcelain']);
  check('b.txt 已暂存为 A', /^A\s+b\.txt$/m.test(statusAfterAdd), statusAfterAdd);

  console.log('\n[5] rejectFile（还原到 HEAD）');
  await git.rejectFile(ROOT, (await git.getChanges(ROOT)).find((f) => f.relPath === 'a.txt'));
  check('a.txt 内容回到初始提交', read('a.txt') === orig.join('\n') + '\n');
  await git.rejectFile(ROOT, { relPath: 'c.txt', absPath: path.join(ROOT, 'c.txt'), kind: 'deleted' });
  check('c.txt 已恢复', fs.existsSync(path.join(ROOT, 'c.txt')));

  console.log('\n[6] 最终状态');
  const finalChanges = await git.getChanges(ROOT);
  console.log('   ', finalChanges.map((f) => `${f.relPath}(${f.kind})`).join(', ') || '(空)');
  check('a.txt / c.txt 已不在改动列表', !finalChanges.some((f) => f.relPath === 'a.txt' || f.relPath === 'c.txt'));

  console.log('\n[7] hash 稳定性');
  const c1 = await git.getChanges(ROOT);
  const c2 = await git.getChanges(ROOT);
  check('连续两次读取 hash 一致', c1.map((f) => f.hash).join() === c2.map((f) => f.hash).join());
  if (c1.length) {
    fs.appendFileSync(path.join(ROOT, c1[0].relPath), 'touched\n', 'utf8');
    const c3 = await git.getChanges(ROOT);
    const f3 = c3.find((f) => f.relPath === c1[0].relPath);
    check('改动后 hash 发生变化（打钩会自动失效）', !!f3 && f3.hash !== c1[0].hash);
  }

  console.log('\n[8] gitignore 风格排除匹配');
  const util = require('../src/vcs/util');
  const globCases = [
    ['build/x.js', ['build/'], true, 'build/ 排除其下内容'],
    ['build', ['build/'], true, 'build/ 匹配目录本身'],
    ['a/build/x.js', ['build/'], true, 'build/ 命中任意层级'],
    ['abuild/x.js', ['build/'], false, '不能误伤同名前缀目录'],
    ['.vscode/settings.json', ['.vscode/'], true, '.vscode/ 命中'],
    ['test/t.js', ['test/'], true, 'test/ 命中'],
    ['x/.tmp.cache', ['.tmp.*'], true, '.tmp.* 命中任意层级'],
    ['src/a.tmp.1', ['.tmp.*'], false, '中间含 .tmp. 不算'],
    ['x/.clangd', ['.clangd'], true, '精确文件名'],
    ['a/b.log', ['*.log'], true, '*.log 任意层级'],
    ['build/x.js', ['**/build/**'], true, '传统 glob 仍可用'],
    ['sub/build/x.js', ['/build'], false, '/build 根锚定'],
    ['build/x.js', ['/build'], true, '/build 命中根下 build 内容'],
    ['node_modules/x/y.js', ['node_modules/'], true, 'node_modules/ 命中'],
    ['src/x.js', ['src/x.js'], true, '带斜杠精确路径']
  ];
  for (const [p, pats, want, name] of globCases) {
    check(`${name}（${p} ← ${JSON.stringify(pats)}）`, util.matchAny(p, pats) === want, `期望 ${want}`);
  }

  console.log('\n[8.1] 项目忽略文件按「规则文件所在目录」锚定（同 .gitignore 语义）');
  // 规则文件在 /proj/sub2，规则是相对 /proj/sub2 的路径；
  // 而 provider 拿到的 relPath 是相对仓库根 /proj 的（多了 sub2/ 前缀）。
  const sets = [{ base: path.posix.join('/proj', 'sub2'), rules: ['components/api/file_server_lib/web_assets/web_assets_version.csv'] }];
  const setCases = [
    [path.posix.join('/proj', 'sub2', 'components/api/file_server_lib/web_assets/web_assets_version.csv'), true, '子目录内的目标文件被命中（这正是之前失效的场景）'],
    [path.posix.join('/proj', 'other', 'components/api/file_server_lib/web_assets/web_assets_version.csv'), false, '规则文件所在目录之外的同名路径不误伤'],
    [path.posix.join('/proj', 'sub2', 'components/api/other.csv'), false, '同目录内其它文件不受影响']
  ];
  for (const [abs, want, name] of setCases) {
    check(`${name}`, util.matchExcludeSets(abs, sets) === want, `期望 ${want}`);
  }
  check('裸文件名规则按其所在目录锚定（sub2/other.txt 命中）',
    util.matchExcludeSets(path.posix.join('/proj', 'sub2', 'other.txt'), [{ base: path.posix.join('/proj', 'sub2'), rules: ['other.txt'] }]) === true);
  check('规则文件外的同名文件不被裸文件名规则命中',
    util.matchExcludeSets(path.posix.join('/proj', 'other', 'other.txt'), [{ base: path.posix.join('/proj', 'sub2'), rules: ['other.txt'] }]) === false);
  check('relFromBase：base 之下的返回 posix 相对路径',
    util.relFromBase(path.posix.join('/proj', 'sub2'), path.posix.join('/proj', 'sub2', 'a', 'b.txt')) === 'a/b.txt');
  check('relFromBase：base 之外的返回 null',
    util.relFromBase(path.posix.join('/proj', 'sub2'), path.posix.join('/proj', 'other', 'b.txt')) === null);

  console.log('\n[9] 相近的多处改动保持在同一块（0.4.3 起，不再按簇拆分）');
  const merged = [
    'diff --git a/x.js b/x.js',
    '--- a/x.js',
    '+++ b/x.js',
    '@@ -1,8 +1,9 @@',
    ' ctx0',
    ' ctx1',
    ' ctx2',
    '-old1',
    '+new1',
    ' gap',
    '+added2',
    ' tail1',
    ' tail2',
    ' tail3'
  ].join('\n');
  const pf = parseDiff(merged)[0];
  check('间隔 1 行上下文的两处改动仍是 1 个块', pf.hunks.length === 1, `实际 ${pf.hunks.length}`);
  check('块 header 保持 git 原样', pf.hunks[0].header === '@@ -1,8 +1,9 @@', pf.hunks[0].header);
  check('块内行序与 git 输出一致', pf.hunks[0].lines.length === 10
    && pf.hunks[0].lines[3].type === 'del' && pf.hunks[0].lines[4].type === 'add'
    && pf.hunks[0].lines[6].type === 'add' && pf.hunks[0].lines[9].text === 'tail3',
  JSON.stringify(pf.hunks[0].lines.map((l) => l.type)));
  check('added/removed 计数不受去拆分影响', pf.hunks[0].added === 2 && pf.hunks[0].removed === 1,
    `+${pf.hunks[0].added} -${pf.hunks[0].removed}`);

  console.log('\n[10] 块内“段”级还原（一处修改 + 两行后一处纯删除，只还原删除段）');
  const eng10 = require('../src/diffEngine');
  const { clustersOf, hunkForCluster } = require('../src/diffParser');
  const oldT10 = ['l1', 'l2', 'modA', 'modB', 'l5', 'l6', 'gone1', 'gone2', 'l9'].join('\n') + '\n';
  const newT10 = ['l1', 'l2', 'modA-2', 'modB-2', 'l5', 'l6', 'l9'].join('\n') + '\n';
  const h10 = parseDiff(eng10.makeUnifiedDiff(oldT10, newT10, 'f.txt', 3))[0].hunks[0];
  check('两处改动合并为一个块（-U3）', h10 && h10.lines.length > 0);
  const cl10 = clustersOf(h10);
  check('块内识别出 2 段连续改动', cl10.length === 2, `实际 ${cl10.length}`);
  const out10 = eng10.revertHunkInText(newT10, hunkForCluster(cl10[1])).split('\n');
  check('只还原第 2 段：删除行(gone1/gone2)加回', out10[6] === 'gone1' && out10[7] === 'gone2',
    JSON.stringify(out10));
  check('第 1 段修改原样保留（modA-2 / modB-2）', out10[2] === 'modA-2' && out10[3] === 'modB-2',
    JSON.stringify(out10.slice(0, 4)));
  check('文件其它行不受影响', out10[0] === 'l1' && out10[8] === 'l9', JSON.stringify(out10));
}

main()
  .then(() => {
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    console.log(`\n${failures === 0 ? '全部通过 ✓' : `${failures} 项失败 ✗`}`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error('自测异常：', e);
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (err) { /* ignore */ }
    process.exit(1);
  });
