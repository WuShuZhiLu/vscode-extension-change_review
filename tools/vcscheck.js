'use strict';

/**
 * 真实仓库测试：覆盖 SVN provider 与快照基准 provider。
 * 会真实调用 svnadmin / svn 创建本地仓库（file:// 协议，不需要网络）。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const vcs = require('../src/vcs');
const { parseDiff } = require('../src/diffParser');
const { diffOps, revertHunkInText } = require('../src/diffEngine');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra !== undefined ? '  ->  ' + extra : ''}`);
  }
}

function mk(n) {
  return Array.from({ length: n }, (_, i) => 'const v' + i + ' = ' + i + ';').join('\n') + '\n';
}

function write(rel, content) {
  const p = path.join.apply(path, [CWD].concat(rel.split('/')));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content.replace(/\n/g, '\n'), 'utf8');
}
function read(rel) {
  return fs.readFileSync(path.join.apply(path, [CWD].concat(rel.split('/'))), 'utf8');
}

let CWD = process.cwd();

// ---------------------------------------------------------------- SVN
async function testSvn(baseDir) {
  console.log('\n[SVN] 真实仓库');
  const root = path.join(baseDir, 'svncase');
  const repo = path.join(root, 'repo');
  const wc = path.join(root, 'wc');
  fs.mkdirSync(root, { recursive: true });
  const svn = (args, cwd) => execFileSync('svn', args, { cwd: cwd || root, encoding: 'utf8' });
  const svnadmin = (args) => execFileSync('svnadmin', args, { cwd: root, encoding: 'utf8' });

  svnadmin(['create', repo]);
  const url = 'file:///' + repo.split(path.sep).join('/').replace(/^([A-Za-z]):/, (m, d) => d.toLowerCase() + ':');
  svn(['co', url, wc]);
  CWD = wc;

  write('src/a.js', mk(20));
  write('src/del.js', 'to be deleted\nline2\n');
  write('keep.js', 'keep\n');
  svn(['add', '--force', '.'], wc);
  svn(['commit', '-m', 'init'], wc);

  // --- 改动 ---
  const lines = mk(20).split('\n');
  lines[0] = 'const v0 = 100;';
  lines[19] = 'const v19 = 200;';
  write('src/a.js', lines.join('\n'));
  try { fs.unlinkSync(path.join(wc, 'src/del.js')); } catch (e) { /* ignore */ }
  write('untracked.txt', 'u1\nu2\n');
  write('sub/deep/local.js', 'deep1\ndeep2\n');
  write('added.js', 'a1\na2\na3\n');
  svn(['add', 'added.js'], wc);

  // 1) 从深层子目录向上探测 .svn
  const deep = path.join(wc, 'sub', 'deep');
  const detected = await vcs.detectIn(deep, { searchDepth: 5, allowSnapshot: false, storageDir: baseDir });
  check('从 wc/sub/deep 向上探测到 .svn 根', detected.kind === 'svn' && detected.provider.root === wc,
    `${detected.kind} ${detected.provider && detected.provider.root}`);

  const p = new vcs.SvnProvider(wc);
  const files = await p.listChanges();
  const byRel = {};
  for (const f of files) { byRel[f.relPath] = f; }
  console.log('    改动:', files.map((f) => `${f.relPath}(${f.kind} +${f.added} -${f.removed})`).join(', '));

  check('识别出修改文件 src/a.js', !!byRel['src/a.js'] && byRel['src/a.js'].kind === 'modified');
  check('src/a.js 统计 +2 −2', byRel['src/a.js'] && byRel['src/a.js'].added === 2 && byRel['src/a.js'].removed === 2,
    byRel['src/a.js'] && `${byRel['src/a.js'].added}/${byRel['src/a.js'].removed}`);
  check('识别出缺失文件 src/del.js 为删除', byRel['src/del.js'] && byRel['src/del.js'].kind === 'deleted' && byRel['src/del.js'].removed === 2);
  check('识别出未版本化 untracked.txt', byRel['untracked.txt'] && byRel['untracked.txt'].kind === 'untracked' && byRel['untracked.txt'].added === 2);
  check('识别出深层未版本化 sub/deep/local.js', !!byRel['sub/deep/local.js']);
  check('识别出已 svn add 的 added.js', byRel['added.js'] && byRel['added.js'].kind === 'added' && byRel['added.js'].added === 3);
  check('未改动的文件不在列表里', !byRel['keep.js']);

  // 2) diff 与块级还原
  const diffText = await p.getDiff(byRel['src/a.js'], 3);
  const hunks = parseDiff(diffText)[0].hunks;
  check('src/a.js 解析出 2 个改动块', hunks.length === 2, hunks.length);

  await p.rejectHunk(byRel['src/a.js'], 0, 3);
  const after = read('src/a.js').split('\n');
  check('拒绝第 1 块后第 1 行还原', after[0] === 'const v0 = 0;', after[0]);
  check('拒绝第 1 块后第 20 行保留改动', after[19] === 'const v19 = 200;', after[19]);

  const files2 = await p.listChanges();
  const a2 = files2.find((f) => f.relPath === 'src/a.js');
  check('还原后 a.js 只剩 +1 −1', a2 && a2.added === 1 && a2.removed === 1, a2 && `${a2.added}/${a2.removed}`);

  // 3) 拿着过期的 hunk 去还原时，必须报错而不是乱改文件
  const staleHunk = parseDiff(await p.getDiff({ relPath: 'src/a.js', absPath: path.join(wc, 'src/a.js'), kind: 'modified' }, 3))[0].hunks[0];
  write('src/a.js', 'TOTALLY DIFFERENT\nsecond\n');
  let threw = false;
  let errMsg = '';
  try {
    revertHunkInText(read('src/a.js'), staleHunk);
  } catch (e) {
    threw = true;
    errMsg = e.message;
  }
  check('过期的 hunk 还原会报错而不是误改', threw && /不一致|超出|对不上/.test(errMsg), errMsg);
  check('报错后文件没有被改动', read('src/a.js') === 'TOTALLY DIFFERENT\nsecond\n');
  write('src/a.js', after.join('\n')); // 恢复成还原后的状态

  // 4) 文件级拒绝
  await p.rejectFile(Object.assign({}, byRel['src/del.js']));
  check('拒绝删除：svn revert 恢复文件', fs.existsSync(path.join(wc, 'src/del.js')) && read('src/del.js') === 'to be deleted\nline2\n');

  const untrackedFile = Object.assign({}, byRel['untracked.txt']);
  await p.rejectFile(untrackedFile);
  check('拒绝未版本化：文件被删除', !fs.existsSync(path.join(wc, 'untracked.txt')));

  const acc = await p.acceptFile(Object.assign({}, byRel['added.js']));
  check('SVN 接受文件返回“无暂存区”', acc.staged === false, JSON.stringify(acc));

  const desc = await p.describe();
  check('describe 输出包含工作副本信息', desc.some((l) => l.indexOf('SVN') !== -1));
  CWD = baseDir;
}

// 用户场景回归：svn 根 A/.svn 下并行着 prj1 / prj2 / prj1-backup(未版本化)，
// VSCode 只打开 A/prj1 时，改动列表必须只包含 prj1 下的文件。
async function testSvnSubdirScope(baseDir) {
  console.log('\n[SVN 子目录范围] 打开的目录不是 svn 根');
  const root = path.join(baseDir, 'svnscope');
  const repo = path.join(root, 'repo');
  const wc = path.join(root, 'wc'); // 模拟 A/
  fs.mkdirSync(root, { recursive: true });
  const svn = (args, cwd) => execFileSync('svn', args, { cwd: cwd || root, encoding: 'utf8' });
  const svnadmin = (args) => execFileSync('svnadmin', args, { cwd: root, encoding: 'utf8' });

  svnadmin(['create', repo]);
  const url = 'file:///' + repo.split(path.sep).join('/').replace(/^([A-Za-z]):/, (m, d) => d.toLowerCase() + ':');
  svn(['co', url, wc]);
  CWD = wc;

  const prj1 = path.join(wc, 'prj1');
  const prj2 = path.join(wc, 'prj2');
  const backup = path.join(wc, 'prj1-backup'); // 不在 svn 管理里
  for (const d of [prj1, prj2]) {
    fs.mkdirSync(path.join(d, 'src'), { recursive: true });
    write(path.basename(d) + '/src/app.js', mk(10));
    write(path.basename(d) + '/README.md', path.basename(d) + '\n');
  }
  svn(['add', 'prj1', 'prj2'], wc);
  svn(['commit', '-m', 'init'], wc);

  // 只改 prj1 里的文件；prj2 与 backup 保持（backup 是手动备份目录，含一堆“看起来像改动”的文件）
  const l1 = mk(10).split('\n');
  l1[0] = 'const v0 = 100;';
  write('prj1/src/app.js', l1.join('\n'));
  write('prj1/README.md', 'prj1 changed\n');
  write('prj2/src/app.js', 'PRJ2 UNTOUCHED\n'); // 与版本库一致才不算改动
  svn(['revert', 'prj2/src/app.js'], wc);
  write('prj2/README.md', 'prj2 CHANGED\n');
  fs.mkdirSync(path.join(backup, 'deep'), { recursive: true });
  write('prj1-backup/deep/x.js', 'backup content\n');

  // 1) 探测：从 prj1 应发现根在 A(wc)，但 provider 带 scope=prj1
  const p1 = await vcs.detectIn(prj1, { searchDepth: 5, allowSnapshot: false, storageDir: baseDir });
  check('从 A/prj1 向上探测到 svn 根 A', p1.kind === 'svn' && p1.provider.root === wc,
    `${p1.kind} ${p1.provider && p1.provider.root}`);
  check('provider 记录了 scope=A/prj1', p1.provider.scopes && p1.provider.scopes.has(prj1),
    JSON.stringify([...(p1.provider.scopes || [])]));

  const files1 = await p1.provider.listChanges();
  const rels1 = files1.map((f) => f.relPath).sort();
  console.log('    A/prj1 视角改动:', rels1.join(', '));
  check('只包含 prj1 内的改动', rels1.length === 2 && rels1.every((r) => r.startsWith('prj1/')),
    rels1.join(','));
  check('不包含 prj2 的改动', !rels1.some((r) => r.startsWith('prj2/')), rels1.join(','));
  check('不包含未版本化的 prj1-backup', !rels1.some((r) => r.startsWith('prj1-backup/')), rels1.join(','));
  check('列出 prj1/src/app.js (+1 −1)', files1.some((f) => f.relPath === 'prj1/src/app.js' && f.added === 1 && f.removed === 1),
    JSON.stringify(files1.find((f) => f.relPath === 'prj1/src/app.js')));
  check('列出 prj1/README.md', rels1.includes('prj1/README.md'), rels1.join(','));

  // 2) 无 scope 的 provider（旧行为 / 用户直接打开 A 根）仍能看到全部
  const pAll = new vcs.SvnProvider(wc);
  const filesAll = await pAll.listChanges();
  check('直接打开 A 根时能看到 prj2 改动', filesAll.some((f) => f.relPath === 'prj2/README.md'));
  check('直接打开 A 根时 prj1-backup 也展开（本来就该看到）', filesAll.some((f) => f.relPath.startsWith('prj1-backup/')));

  // 3) scope 下文件级拒绝可用：只还原 prj1/src/app.js，不碰其它
  const target = files1.find((f) => f.relPath === 'prj1/src/app.js');
  await p1.provider.rejectFile(Object.assign({}, target));
  const after = read('prj1/src/app.js').split('\n');
  check('scope 下拒绝 prj1/src/app.js 还原到 BASE', after[0] === 'const v0 = 0;', after[0]);
  const files2 = await p1.provider.listChanges();
  check('还原后 prj1/src/app.js 不再出现在列表', !files2.some((f) => f.relPath === 'prj1/src/app.js'),
    files2.map((f) => f.relPath).join(','));
  check('prj1/README.md 改动仍保留', files2.some((f) => f.relPath === 'prj1/README.md'));

  // 4) scope 下 diff 正常（基准内容来自 BASE）
  const readme = files2.find((f) => f.relPath === 'prj1/README.md');
  const d = await p1.provider.getDiff(readme, 3);
  check('scope 下 getDiff 正常输出', /README/.test(d) && d.indexOf('-prj1') !== -1 && d.indexOf('+prj1 changed') !== -1,
    JSON.stringify(String(d).slice(0, 160)));
  CWD = baseDir;
}

// ------------------------------------------------------------ SVN 探测层数上限
// 需求：.svn 最多向上找 5 层，再高就不认（当成无版本控制，走快照基准）。
async function testSvnDetectDepth(baseDir) {
  console.log('\n[SVN 探测上限] .svn 超过 5 层不接管');
  const root = path.join(baseDir, 'svndepth');
  const repo = path.join(root, 'repo');
  const wc = path.join(root, 'wc');
  fs.mkdirSync(root, { recursive: true });
  const svn = (args, cwd) => execFileSync('svn', args, { cwd: cwd || root, encoding: 'utf8' });
  const svnadmin = (args) => execFileSync('svnadmin', args, { cwd: root, encoding: 'utf8' });
  svnadmin(['create', repo]);
  const url = 'file:///' + repo.split(path.sep).join('/').replace(/^([A-Za-z]):/, (m, d) => d.toLowerCase() + ':');
  svn(['co', url, wc]);
  CWD = wc;
  write('keep.js', 'k\n');
  svn(['add', '--force', '.'], wc);
  svn(['commit', '-m', 'init'], wc);

  // wc/d1/d2/d3/d4/d5 —— .svn 在 wc（向上 5 层）→ 应命中
  const five = path.join(wc, 'd1', 'd2', 'd3', 'd4', 'd5');
  const six = path.join(wc, 'd1', 'd2', 'd3', 'd4', 'd5', 'd6');
  fs.mkdirSync(six, { recursive: true });

  const hit = await vcs.detectIn(five, { searchDepth: 5, allowSnapshot: false, storageDir: baseDir });
  check('向上 5 层内的 .svn 被接管', hit.kind === 'svn' && hit.provider.root === wc,
    `${hit.kind} ${hit.provider && hit.provider.root}`);
  check('并记录打开目录为 scope', hit.provider && hit.provider.scopes && hit.provider.scopes.has(five),
    JSON.stringify([...(hit.provider.scopes || [])]));

  const miss = await vcs.detectIn(six, { searchDepth: 5, allowSnapshot: false, storageDir: baseDir });
  check('第 6 层的 .svn 不再接管', miss.kind === null && miss.provider === null,
    `${miss.kind} ${miss.provider && miss.provider.root}`);

  const miss3 = await vcs.detectIn(six, { searchDepth: 3, allowSnapshot: false, storageDir: baseDir });
  check('收紧到 3 层同样不接管（配置生效）', miss3.kind === null, `${miss3.kind}`);
  CWD = baseDir;
}

// ------------------------------------------------------------ 通用 exclude
// 验证 changeReview.exclude：默认空、对所有 kind 生效、用户自填 glob。
async function testExclude(baseDir) {
  console.log('\n[通用 exclude] 用户手动排除规则');
  const root = path.join(baseDir, 'exclude');
  const repo = path.join(root, 'repo');
  const wc = path.join(root, 'wc');
  fs.mkdirSync(root, { recursive: true });
  const svn = (args, cwd) => execFileSync('svn', args, { cwd: cwd || root, encoding: 'utf8' });
  const svnadmin = (args) => execFileSync('svnadmin', args, { cwd: root, encoding: 'utf8' });
  svnadmin(['create', repo]);
  const url = 'file:///' + repo.split(path.sep).join('/').replace(/^([A-Za-z]):/, (m, d) => d.toLowerCase() + ':');
  svn(['co', url, wc]);
  CWD = wc;
  write('keep.js', 'k\n');
  write('build/out/app.js', 'built\n');
  write('docs/new.md', '# note\n');
  svn(['add', '--force', '.'], wc);
  svn(['commit', '-m', 'init'], wc);

  // 改造：版本化修改 + 未版本化生成物 + 未版本化新文件
  write('keep.js', 'k changed\n');           // 已在版本库，修改
  write('build/out/app.js', 'built v2\n');    // 未版本化
  write('docs/new.md', '# note v2\n');        // 未版本化真新文件
  write('release/deep/file.dat', 'raw\n');    // 未版本化嵌套

  // 1) 默认（exclude=[]）：所有改动都列出，没有内置兜底
  const pDef = new vcs.SvnProvider(wc);
  const defRels = (await pDef.listChanges()).map((f) => f.relPath).sort();
  console.log('    默认视角:', defRels.join(', '));
  check('默认空 exclude：所有改动都列出', defRels.length >= 3, defRels.join(','));
  check('默认视角包含版本化修改 keep.js', defRels.includes('keep.js'), defRels.join(','));
  check('默认视角包含未版本化 build/out/app.js', defRels.includes('build/out/app.js'), defRels.join(','));
  check('默认视角包含未版本化 docs/new.md', defRels.includes('docs/new.md'), defRels.join(','));

  // 2) exclude=[]（显式）：与默认等价
  const pEmpty = new vcs.SvnProvider(wc, { exclude: [] });
  const emptyRels = (await pEmpty.listChanges()).map((f) => f.relPath).sort();
  check('显式 exclude=[] 与默认等价', JSON.stringify(emptyRels) === JSON.stringify(defRels));

  // 3) 自定义规则：滤掉 build 与 release（连同子目录），保留 docs/new.md 与版本化修改
  const pCustom = new vcs.SvnProvider(wc, { exclude: ['**/build/**', '**/release/**'] });
  const customRels = (await pCustom.listChanges()).map((f) => f.relPath);
  check('自定义排除 build/**：未版本化 build 不出现',
    !customRels.some((r) => r.startsWith('build/')), customRels.join(','));
  check('自定义排除 release/**：嵌套未版本化 release 不出现',
    !customRels.some((r) => r.startsWith('release/')), customRels.join(','));
  check('真正的新文件 docs/new.md 保留', customRels.includes('docs/new.md'), customRels.join(','));

  // 4) exclude 对所有 kind 生效（包括版本化的修改与删除）
  svn(['delete', '--keep-local', 'keep.js'], wc); // 模拟「版本化删除」(标记删除但工作副本保留)
  svn(['commit', '-m', 'del'], wc);
  fs.unlinkSync(path.join(wc, 'keep.js'));
  const pWithDel = new vcs.SvnProvider(wc, { exclude: ['keep.js'] });
  const withDelRels = (await pWithDel.listChanges()).map((f) => f.relPath);
  check('exclude 对版本化删除也生效', !withDelRels.some((r) => r === 'keep.js'), withDelRels.join(','));

  CWD = baseDir;
}

// ------------------------------------------------------------ 快照基准
async function testSnapshot(baseDir) {
  console.log('\n[快照基准] 无 git / svn 的项目');
  const root = path.join(baseDir, 'snapcase');
  const storage = path.join(baseDir, 'storage');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  CWD = root;
  write('src/a.js', mk(20));
  write('src/b.txt', 'hello\nworld\n');
  write('node_modules/pkg/index.js', 'module.exports = 1;\n');

  const snapOpts = { exclude: undefined, maxFileSizeKB: 1024, maxFiles: 1000 };
  const p = new vcs.SnapshotProvider(root, storage, snapOpts);
  check('未初始化时 hasBaseline=false', p.hasBaseline() === false);
  check('未初始化时 listChanges 为空', (await p.listChanges()).length === 0);

  const info = p.initBaseline();
  check('初始化基准成功', p.hasBaseline() === true, JSON.stringify(info));
  check('node_modules 被排除', !(p.loadIndex().files['node_modules/pkg/index.js']), Object.keys(p.loadIndex().files).join(','));
  check('基准包含 2 个文件', Object.keys(p.loadIndex().files).length === 2, Object.keys(p.loadIndex().files).join(','));

  check('刚初始化后没有改动', (await p.listChanges()).length === 0);

  // 改动
  const lines = mk(20).split('\n');
  lines[0] = 'const v0 = 100;';
  lines[19] = 'const v19 = 200;';
  write('src/a.js', lines.join('\n'));
  write('src/new.js', 'n1\nn2\n');
  try { fs.unlinkSync(path.join(root, 'src/b.txt')); } catch (e) { /* ignore */ }

  const files = await p.listChanges();
  const byRel = {};
  for (const f of files) { byRel[f.relPath] = f; }
  console.log('    改动:', files.map((f) => `${f.relPath}(${f.kind} +${f.added} -${f.removed})`).join(', '));
  check('检出修改文件 src/a.js (+2 −2)', byRel['src/a.js'] && byRel['src/a.js'].kind === 'modified' && byRel['src/a.js'].added === 2 && byRel['src/a.js'].removed === 2);
  check('检出新增文件 src/new.js (+2)', byRel['src/new.js'] && byRel['src/new.js'].kind === 'untracked' && byRel['src/new.js'].added === 2);
  check('检出删除文件 src/b.txt (−2)', byRel['src/b.txt'] && byRel['src/b.txt'].kind === 'deleted' && byRel['src/b.txt'].removed === 2);

  // 块级还原
  await p.rejectHunk(byRel['src/a.js'], 0, 3);
  const after = read('src/a.js').split('\n');
  check('拒绝第 1 块：第 1 行还原', after[0] === 'const v0 = 0;', after[0]);
  check('拒绝第 1 块：第 20 行保留', after[19] === 'const v19 = 200;', after[19]);

  // 文件级还原
  await p.rejectFile(byRel['src/b.txt']);
  check('拒绝删除：文件按基准恢复', read('src/b.txt') === 'hello\nworld\n');

  await p.rejectFile(byRel['src/new.js']);
  check('拒绝新增：文件被删除', !fs.existsSync(path.join(root, 'src/new.js')));

  // 更新基准（此时 a.js 第 20 行仍是改动后的值，先确认确实有 1 项改动）
  const before = (await p.listChanges()).length;
  check('更新前仍有 1 个改动', before === 1, before);
  p.updateBaseline(['src/a.js']);
  const after2 = await p.listChanges();
  check('更新基准后改动清零', after2.length === 0, after2.map((f) => f.relPath).join(','));

  // 基准内容的 diff 正确性
  write('src/a.js', mk(20).replace('const v5 = 5;', 'const v5 = "five";'));
  const f3 = (await p.listChanges())[0];
  const d3 = await p.getDiff(f3, 3);
  check('基准 diff 含改动行', d3.indexOf('+const v5 = "five";') !== -1 && d3.indexOf('-const v5 = 5;') !== -1, JSON.stringify(d3.slice(0, 160)));
  const base = await p.getBaseContent(f3);
  check('getBaseContent 返回的是更新后的基准内容', base.indexOf('const v19 = 200;') !== -1 && base.indexOf('"five"') === -1,
    JSON.stringify(String(base).slice(0, 60)));
  CWD = baseDir;
}

// ------------------------------------------------------------ diff 引擎
function testDiffEngine() {
  console.log('\n[diff 引擎] 随机化正确性');
  let ok = true;
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let t = 0; t < 200; t += 1) {
    const n = 5 + Math.floor(rnd() * 60);
    const a = Array.from({ length: n }, (_, i) => 'line ' + i);
    const b = a.slice();
    const ops = 1 + Math.floor(rnd() * 6);
    for (let k = 0; k < ops; k += 1) {
      const kind = Math.floor(rnd() * 3);
      const at = Math.floor(rnd() * b.length);
      if (kind === 0) { b[at] = 'changed ' + k; } else if (kind === 1) { b.splice(at, 1); } else { b.splice(at, 0, 'inserted ' + k); }
    }
    const script = diffOps(a, b);
    const out = [];
    let x = 0;
    let y = 0;
    for (const op of script) {
      if (op === '=') { out.push(a[x]); x += 1; y += 1; } else if (op === '-') { x += 1; } else { out.push(b[y]); y += 1; }
    }
    if (x !== a.length || y !== b.length || out.join('\n') !== b.join('\n')) { ok = false; break; }
  }
  check('200 组随机改动都能由编辑脚本还原出目标内容', ok);

  const big = Array.from({ length: 20000 }, (_, i) => 'line ' + i);
  const bigB = big.slice();
  bigB[100] = 'x';
  bigB[15000] = 'y';
  const t0 = Date.now();
  const script = diffOps(big, bigB);
  const changed = script.filter((s) => s !== '=').length;
  check('20000 行文件只有局部改动时编辑量很小', changed <= 6 && Date.now() - t0 < 2000, `changed=${changed} ${Date.now() - t0}ms`);
}

// git 同场景回归：仓库根 A 下并行 prj1 / prj2，打开 A/prj1 只列 prj1。
async function testGitSubdirScope(baseDir) {
  console.log('\n[git 子目录范围] 打开的目录不是 git 根');
  const root = path.join(baseDir, 'gitscope'); // 模拟 A/
  fs.mkdirSync(root, { recursive: true });
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 's@local']);
  git(['config', 'user.name', 'Scope']);
  git(['config', 'core.autocrlf', 'false']);
  git(['config', 'commit.gpgsign', 'false']);
  CWD = root;

  const prj1 = path.join(root, 'prj1');
  const prj2 = path.join(root, 'prj2');
  for (const d of [prj1, prj2]) {
    fs.mkdirSync(path.join(d, 'src'), { recursive: true });
    write(path.basename(d) + '/src/app.js', mk(10));
    write(path.basename(d) + '/README.md', path.basename(d) + '\n');
  }
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);

  const l1 = mk(10).split('\n');
  l1[0] = 'const v0 = 100;';
  write('prj1/src/app.js', l1.join('\n'));
  write('prj1/README.md', 'prj1 changed\n');
  write('prj2/README.md', 'prj2 CHANGED\n');
  write('prj2/untracked.js', 'u\n');

  const p1 = await vcs.detectIn(prj1, { searchDepth: 5, allowSnapshot: false, storageDir: baseDir });
  check('从 A/prj1 向上探测到 git 根 A', p1.kind === 'git' && p1.provider.root === root,
    `${p1.kind} ${p1.provider && p1.provider.root}`);
  const files1 = await p1.provider.listChanges();
  const rels1 = files1.map((f) => f.relPath).sort();
  console.log('    A/prj1 视角改动:', rels1.join(', '));
  check('只包含 prj1 内的改动', rels1.length === 2 && rels1.every((r) => r.startsWith('prj1/')), rels1.join(','));
  check('不包含 prj2 的改动', !rels1.some((r) => r.startsWith('prj2/')), rels1.join(','));
  check('列出 prj1/src/app.js (+1 −1)', files1.some((f) => f.relPath === 'prj1/src/app.js' && f.added === 1 && f.removed === 1),
    JSON.stringify(files1.find((f) => f.relPath === 'prj1/src/app.js')));

  const pAll = new vcs.GitProvider(root);
  const filesAll = await pAll.listChanges();
  check('直接打开 A 根时能看到 prj2 改动', filesAll.some((f) => f.relPath === 'prj2/README.md'));
  check('直接打开 A 根时能看到 prj2 未跟踪文件', filesAll.some((f) => f.relPath === 'prj2/untracked.js'));

  // scope 下 diff / 拒绝可用
  const target = files1.find((f) => f.relPath === 'prj1/src/app.js');
  await p1.provider.rejectFile(Object.assign({}, target));
  const after = read('prj1/src/app.js').split('\n');
  check('scope 下拒绝 prj1/src/app.js 还原到 HEAD', after[0] === 'const v0 = 0;', after[0]);
  CWD = baseDir;
}

// 真实场景回归：svn 根 A 下，VSCode 只打开子目录 A/sub2。
// A/sub2/.crignore 里写的是「相对 A/sub2」的路径（同 .gitignore 语义），
// 而 provider 拿到的 relPath 是相对 svn 根 A 的（带 sub2/ 前缀）——
// 只要匹配端按「.crignore 所在目录」锚定，这条规则就必须命中。
async function testSvnCrignoreSubdir(baseDir) {
  console.log('\n[SVN .crignore 锚定] 打开子目录时 .crignore 规则仍命中');
  const root = path.join(baseDir, 'svncrig');
  const repo = path.join(root, 'repo');
  const wc = path.join(root, 'wc');
  fs.mkdirSync(root, { recursive: true });
  const svn = (args, cwd) => execFileSync('svn', args, { cwd: cwd || root, encoding: 'utf8' });
  const svnadmin = (args) => execFileSync('svnadmin', args, { cwd: root, encoding: 'utf8' });

  svnadmin(['create', repo]);
  const url = 'file:///' + repo.split(path.sep).join('/').replace(/^([A-Za-z]):/, (m, d) => d.toLowerCase() + ':');
  svn(['co', url, wc]);
  CWD = wc;

  const sub2 = path.join(wc, 'sub2');
  const relInSub2 = 'components/api/file_server_lib/web_assets/web_assets_version.csv';
  const relFromRoot = 'sub2/' + relInSub2;
  const absTarget = path.join(sub2, relInSub2.split('/').join(path.sep));
  fs.mkdirSync(path.dirname(absTarget), { recursive: true });
  fs.writeFileSync(absTarget, 'a,b,c\n1,2,3\n', 'utf8');
  write('sub2/keep.txt', 'keep\n');
  svn(['add', 'sub2'], wc);
  svn(['commit', '-m', 'init'], wc);
  // 制造改动：目标文件 + 一个不该被误伤的同级文件
  fs.writeFileSync(absTarget, 'a,b,c\n9,9,9\n', 'utf8');
  write('sub2/keep.txt', 'keep changed\n');

  const rules = [relInSub2];
  const mkProvider = (sets) => {
    const p = new vcs.SvnProvider(wc, sets ? { excludeSets: sets } : {});
    p.addScope(sub2);
    return p;
  };

  // 1) 不带 .crignore 规则：两个文件都在
  const before = (await mkProvider(null).listChanges()).map((f) => f.relPath).sort();
  console.log('    屏蔽前改动:', before.join(', '));
  check('未配置 .crignore 时目标文件在列表里', before.includes(relFromRoot), before.join(','));

  // 2) 带「相对 .crignore 所在目录」的规则：目标文件被排除，同级文件不受影响
  const after = (await mkProvider([{ base: sub2, rules }]).listChanges()).map((f) => f.relPath).sort();
  console.log('    屏蔽后改动:', after.join(', '));
  check('.crignore 规则（相对所在目录）命中：目标文件被排除', !after.includes(relFromRoot), after.join(','));
  check('同级文件不被误伤', after.includes('sub2/keep.txt'), after.join(','));

  // 3) 反证：如果规则被错当成「相对 svn 根」拍平匹配，就命中不了（这正是修复前的 bug）
  const flat = (await mkProvider(null).listChanges()).length; // 仅取数量做对照
  const wrongly = rules.some((r) => relFromRoot === r);
  check('对照：规则文本 ≠ 相对 svn 根的路径（说明锚定方式才是关键）', !wrongly && flat === 2, `${wrongly} ${flat}`);

  CWD = baseDir;
}

(async () => {
  const baseDir = path.join(os.tmpdir(), 'cr-vcscheck-' + Date.now());
  fs.mkdirSync(baseDir, { recursive: true });
  try {
    testDiffEngine();
    await testSnapshot(baseDir);
    await testSvnSubdirScope(baseDir);
    await testSvnCrignoreSubdir(baseDir);
    await testGitSubdirScope(baseDir);
    await testSvnDetectDepth(baseDir);
    await testExclude(baseDir);
    await testSvn(baseDir);
  } catch (e) {
    fail += 1;
    console.log('\n执行异常:', e && e.stack ? e.stack : e);
  } finally {
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
