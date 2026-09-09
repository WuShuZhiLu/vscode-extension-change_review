'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const platform = require('./platform');

const MAX_UNTRACKED_SCAN = 2 * 1024 * 1024; // 未跟踪文件最多读 2MB 来统计行数

let configuredGit = '';      // 用户设置的 git 路径
let resolvedGit = null;      // 已探测成功的 git
const badGit = new Set();    // 探测失败的候选

function setGitPath(p) {
  const v = String(p || '').trim();
  if (v !== configuredGit) {
    configuredGit = v;
    resetGit();
  }
}

function resetGit() {
  resolvedGit = null;
  badGit.clear();
}

function candidates() {
  const list = [];
  if (configuredGit) { list.push(configuredGit); }
  for (const c of platform.gitCandidates()) { list.push(c); }
  return Array.from(new Set(list));
}

function execRaw(bin, args, cwd, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      windowsHide: true,
      env: Object.assign({}, process.env, { GIT_OPTIONAL_LOCKS: '0' })
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      err.gitStderr = stderr;
      reject(err);
    });
    child.on('close', (code) => {
      const allowed = opts.allowExitCodes || [];
      if (code === 0 || allowed.indexOf(code) !== -1) {
        resolve({ code, stdout, stderr });
        return;
      }
      const err = new Error(`git ${args.join(' ')} 执行失败 (code=${code}): ${String(stderr || stdout || '').trim()}`);
      err.code = code;
      err.gitStderr = stderr;
      reject(err);
    });
  });
}

async function ensureGit() {
  if (resolvedGit) { return resolvedGit; }
  const errors = [];
  for (const cand of candidates()) {
    if (badGit.has(cand)) { continue; }
    try {
      const r = await execRaw(cand, ['--version'], process.cwd());
      if (!/git version/i.test(r.stdout)) { throw new Error('不是 git'); }
      resolvedGit = cand;
      return cand;
    } catch (e) {
      badGit.add(cand);
      errors.push(`${cand}: ${e.message.split('\n')[0]}`);
    }
  }
  const err = new Error(
    `未找到可用的 git 可执行文件${platform.IS_WIN ? '（Windows）' : '（Linux/macOS）'}。` +
    `请在 VSCode 设置里把 changeReview.gitPath 填成 git 的完整路径。\n尝试过：\n${errors.join('\n')}`
  );
  err.noGit = true;
  throw err;
}

function markBadGit() {
  if (resolvedGit) { badGit.add(resolvedGit); }
  resolvedGit = null;
}

function parseDubiousRoot(msg) {
  const m = /detected dubious ownership in repository at '(.+?)'/.exec(String(msg || ''));
  return m ? m[1] : null;
}

function isToplevelArgs(args) {
  return args[0] === 'rev-parse' && args[1] === '--show-toplevel';
}

/**
 * 执行 git。自动处理：候选二进制探测、平台错配（Linux 下拿到 Windows 版 git）、
 * 以及 "dubious ownership" 报错归类。
 */
async function run(cwd, args, opts = {}, depth = 0) {
  const bin = await ensureGit();
  let res;
  try {
    res = await execRaw(bin, args, cwd, opts);
  } catch (e) {
    if (e && e.code === 'ENOENT' && depth < 3) {
      markBadGit();
      return run(cwd, args, opts, depth + 1);
    }
    const root = parseDubiousRoot(e.gitStderr || e.message || '');
    if (root) {
      const err = new Error(`git 拒绝操作该仓库（dubious ownership）：${root}`);
      err.dubiousRoot = root;
      throw err;
    }
    diag(`git 命令失败：git ${args.join(' ')} | ${e.message} | stderr=${String(e.gitStderr || '').slice(0, 300)}`);
    throw e;
  }

  // Linux 上却跑着 Windows 版 git（WSL 里很常见）：返回的 toplevel 会是 C:/... 或 //wsl...
  if (isToplevelArgs(args)) {
    const out = res.stdout.trim();
    if (out && !platform.IS_WIN && platform.isWindowsPath(out) && depth < 3) {
      markBadGit();
      return run(cwd, args, opts, depth + 1);
    }
    if (out && platform.IS_WIN && platform.isPosixAbsPath(out) && !out.startsWith('//') && depth < 3) {
      // Windows 上却跑着 WSL 版 git：同样换候选
      markBadGit();
      return run(cwd, args, opts, depth + 1);
    }
  }
  return res;
}

async function addSafeDirectory(root, all = false) {
  const target = all ? '*' : root;
  return run(process.cwd(), ['config', '--global', '--add', 'safe.directory', target]);
}

async function getGitInfo() {
  const bin = await ensureGit();
  const r = await execRaw(bin, ['--version'], process.cwd());
  return { bin, version: r.stdout.trim() };
}

async function topLevel(dir) {
  const r = await run(dir, ['rev-parse', '--show-toplevel']);
  const out = r.stdout.trim();
  // git 输出用正斜杠，统一成当前平台分隔符，便于和 Uri.fsPath 比较
  return out ? path.normalize(out) : null;
}

async function headExists(root) {
  try {
    await run(root, ['rev-parse', '--verify', 'HEAD']);
    return true;
  } catch (e) {
    return false;
  }
}

/** 从工作区目录里找出所有 git 仓库根（当前目录 + 一层子目录扫描） */
async function findRepos(folders) {
  const roots = new Set();
  for (const folder of folders || []) {
    let top = null;
    try {
      top = await topLevel(folder);
    } catch (e) {
      if (e && (e.noGit || e.dubiousRoot)) { throw e; }
      // 不是仓库，继续往下扫
    }
    if (top) {
      roots.add(top);
      continue;
    }
    let names = [];
    try {
      names = fs.readdirSync(folder);
    } catch (e) {
      names = [];
    }
    for (const name of names) {
      const child = path.join(folder, name);
      try {
        if (!fs.statSync(child).isDirectory()) { continue; }
      } catch (e) {
        continue;
      }
      if (fs.existsSync(path.join(child, '.git'))) {
        try {
          const t = await topLevel(child);
          if (t) { roots.add(t); }
        } catch (e) {
          if (e && (e.noGit || e.dubiousRoot)) { throw e; }
        }
      }
    }
  }
  return Array.from(roots);
}

function parseStatusZ(out) {
  const parts = String(out || '').split('\0');
  const result = [];
  let i = 0;
  while (i < parts.length) {
    const rec = parts[i];
    if (!rec) { i += 1; continue; }
    const status = rec.slice(0, 2);
    const p = rec.slice(3);
    if (/[RC]/.test(status)) {
      i += 2; // 重命名/复制会多带一个原始路径记录
    } else {
      i += 1;
    }
    result.push({ status, path: p });
  }
  return result;
}

function classify(status) {
  const x = status[0];
  const y = status[1];
  if (status === '??') { return 'untracked'; }
  if (status === '!!') { return 'ignored'; }
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) { return 'conflict'; }
  if (y === 'D' || x === 'D') { return 'deleted'; }
  if (x === 'A' || y === 'A') { return 'added'; }
  if (x === 'R' || y === 'R' || x === 'C' || y === 'C') { return 'renamed'; }
  return 'modified';
}

async function numstatMap(root, paths) {
  const map = new Map();
  try {
    const args = ['-c', 'core.quotepath=false', 'diff', 'HEAD', '--numstat', '--no-renames', '--'];
    if (paths && paths.length) { args.push(...paths); }
    const r = await run(root, args);
    for (const line of r.stdout.split('\n')) {
      if (!line.trim()) { continue; }
      const tabs = line.split('\t');
      if (tabs.length < 3) { continue; }
      const p = tabs.slice(2).join('\t');
      map.set(p, {
        added: tabs[0] === '-' ? 0 : parseInt(tabs[0], 10) || 0,
        removed: tabs[1] === '-' ? 0 : parseInt(tabs[1], 10) || 0
      });
    }
  } catch (e) {
    // 没有 HEAD 或出错时返回空表
  }
  return map;
}

function countLines(absPath) {
  try {
    const size = fs.statSync(absPath).size || 0;
    const fd = fs.openSync(absPath, 'r');
    const buf = Buffer.alloc(Math.min(MAX_UNTRACKED_SCAN, Math.max(size, 1)));
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const slice = buf.slice(0, read);
    if (slice.indexOf(0) !== -1) { return null; } // 疑似二进制
    const text = slice.toString('utf8');
    if (!text) { return 0; }
    const n = (text.match(/\n/g) || []).length;
    return text.endsWith('\n') ? n : n + 1;
  } catch (e) {
    return null;
  }
}

function makeHash(relPath, kind, added, removed, statInfo) {
  const raw = [relPath, kind, added, removed, statInfo].join('|');
  return crypto.createHash('sha1').update(raw).digest('hex');
}

function statInfoOf(absPath) {
  try {
    const st = fs.statSync(absPath);
    return `${st.size}:${Math.floor(st.mtimeMs)}`;
  } catch (e) {
    return 'missing';
  }
}

// 诊断日志钩子：由扩展注入（写入 Output 面板 + 日志文件），gitService 自身不依赖 vscode
let diag = () => {};
function setDiagLogger(fn) { diag = typeof fn === 'function' ? fn : () => {}; }
const emptyStatusWarned = new Set(); // (root|paths) 只警告一次，避免自动刷新刷屏

/**
 * 列出仓库根下所有与上次 commit 不同的文件。
 * 性能：先跑 status（一次 spawn），只有确实有改动才去跑 numstat（第二次 spawn）；
 * 空闲/无改动仓库的自动刷新不再额外 spawn rev-parse + numstat。
 * @param {string} root 仓库根
 * @param {string[]} [paths] 可选 pathspec 限制（相对 root 的目录/文件，git 风格），只查这些路径内的改动
 * @returns {Promise<Array<{relPath,absPath,status,kind,added,removed,hash,staged}>>}
 */
async function getChanges(root, paths) {
  const ps = (paths && paths.length) ? ['--'].concat(paths) : ['--'];
  const statusOut = await run(root, ['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-uall', '-z'].concat(ps));
  const entries = parseStatusZ(statusOut.stdout);
  // 诊断：如果 git status 返回了内容但 parse 后是 0 条，说明解析有问题——把原始输出记下来
  if (statusOut.stdout && statusOut.stdout.length > 0 && entries.length === 0) {
    diag(`git status 返回 ${statusOut.stdout.length} 字节但解析出 0 条改动，原始输出前 200 字节: ${JSON.stringify(statusOut.stdout.slice(0, 200))}`);
  }
  // 诊断：status 干净但用户明明有改动时（Linux 上常因 root/pathspec 不对），把查询参数记下来
  if (entries.length === 0) {
    const k = `${root}|${ps.join(',')}`;
    if (!emptyStatusWarned.has(k)) {
      emptyStatusWarned.add(k);
      diag(`git status 空结果 root=${root} pathspec=${JSON.stringify(ps)}（若终端 git diff 有内容而此处为空，请把本行日志发出来定位）`);
    }
  }
  // 只有存在改动才需要 diff HEAD --numstat（无改动时省一次 spawn；
  // 没有 HEAD 的仓库 numstatMap 内部会自己兜底为空）
  const numstat = entries.length ? await numstatMap(root, paths) : new Map();

  const files = [];
  for (const entry of entries) {
    const kind = classify(entry.status);
    if (kind === 'ignored') { continue; }
    const relPath = platform.toGitPath(entry.path);
    const absPath = platform.joinRepo(root, relPath);
    let added = 0;
    let removed = 0;
    const ns = numstat.get(entry.path);
    if (ns) {
      added = ns.added;
      removed = ns.removed;
    } else if (kind === 'untracked') {
      const lines = countLines(absPath);
      added = lines === null ? 0 : lines;
    }
    files.push({
      relPath,
      absPath,
      status: entry.status,
      kind,
      added,
      removed,
      staged: entry.status[0] !== ' ' && entry.status[0] !== '?',
      hash: makeHash(relPath, kind, added, removed, statInfoOf(absPath))
    });
  }
  return files;
}

async function getDiff(root, file, contextLines = 3) {
  const context = ['-c', 'core.quotepath=false'];
  const rel = platform.toGitPath(file.relPath);
  if (file.kind === 'untracked') {
    // 未跟踪的新文件：跟空文件比
    const r = await run(root, context.concat(['diff', '--no-index', `--unified=${contextLines}`, '--', '/dev/null', rel]), { allowExitCodes: [1] });
    return r.stdout;
  }
  const r = await run(root, context.concat(['diff', 'HEAD', `--unified=${contextLines}`, '--no-renames', '--', rel]));
  return r.stdout;
}

async function getHeadContent(root, file) {
  if (file.kind === 'untracked' || file.kind === 'added') { return ''; }
  try {
    const r = await run(root, ['-c', 'core.quotepath=false', 'show', `HEAD:${platform.toGitPath(file.relPath)}`]);
    return r.stdout;
  } catch (e) {
    return '';
  }
}

async function acceptFile(root, file) {
  return run(root, ['add', '-A', '--', platform.toGitPath(file.relPath)]);
}

async function rejectFile(root, file) {
  const rel = platform.toGitPath(file.relPath);
  // 新增文件（未跟踪 ?? 或已 git add 的 A）：拒绝 = 从工作区删除。
  // 注意：文件一旦被 git add，status 是 'A'（kind='added'），不能走“还原到 HEAD”
  // —— 该文件从未提交，restore 会报 pathspec 不匹配。必须 rm 掉索引项再删盘。
  if (file.kind === 'untracked') {
    await fs.promises.unlink(file.absPath);
    return null;
  }
  if (file.kind === 'added') {
    try {
      await run(root, ['rm', '-f', '--', rel]); // 同时移出暂存区与磁盘
    } catch (e) {
      await fs.promises.unlink(file.absPath); // 兜底：至少删掉磁盘文件
    }
    return null;
  }
  try {
    return await run(root, ['restore', '--source=HEAD', '--staged', '--worktree', '--', rel]);
  } catch (e) {
    // 老版本 git 没有 restore
    return await run(root, ['checkout', 'HEAD', '--', rel]);
  }
}

function buildHunkPatch(relPath, hunk) {
  const rel = platform.toGitPath(relPath);
  const lines = [
    `diff --git a/${rel} b/${rel}`,
    `--- a/${rel}`,
    `+++ b/${rel}`,
    hunk.header
  ];
  for (const line of hunk.lines) {
    if (line.type === 'meta') { lines.push(line.text); continue; }
    const prefix = line.type === 'add' ? '+' : (line.type === 'del' ? '-' : ' ');
    lines.push(prefix + line.text);
  }
  return lines.join('\n') + '\n';
}

/**
 * 对单个 hunk 应用补丁。
 * @param {'worktree'|'index'} target
 *   - 'worktree'：反向应用（-R），把该块的改动从工作区还原掉 = 拒绝此块
 *   - 'index'：正向应用到暂存区（--cached），只暂存这一块 = 接受此块
 */
async function applyHunk(root, file, hunkIndex, target, contextLines = 3) {
  const diffText = await getDiff(root, file, contextLines);
  const parsed = require('./diffParser').parseDiff(diffText);
  if (!parsed.length) { throw new Error('无法解析该文件的 diff'); }
  const hunk = parsed[0].hunks[hunkIndex];
  if (!hunk) { throw new Error(`未找到第 ${hunkIndex + 1} 个改动块`); }

  const patch = buildHunkPatch(file.relPath, hunk);
  const tmp = path.join(os.tmpdir(), `change-review-hunk-${Date.now()}-${Math.random().toString(36).slice(2)}.patch`);
  fs.writeFileSync(tmp, patch, 'utf8');
  try {
    const args = target === 'index'
      ? ['apply', '--cached', '--recount', '--whitespace=nowarn', tmp]
      : ['apply', '-R', '--recount', '--whitespace=nowarn', tmp];
    return await run(root, args);
  } catch (e) {
    if (target === 'index') {
      throw new Error(`暂存该块失败（如果该文件已有暂存内容，暂存区与 HEAD 的上下文对不上，请先用「接受改动」整体暂存）：${e.message}`);
    }
    throw e;
  } finally {
    try { fs.unlinkSync(tmp); } catch (err) { /* ignore */ }
  }
}

/** 拒绝此块：把该块的改动从工作区还原 */
function revertHunk(root, file, hunkIndex, contextLines = 3) {
  return applyHunk(root, file, hunkIndex, 'worktree', contextLines);
}

/** 接受此块：只把该块暂存，工作区保持不变 */
function stageHunk(root, file, hunkIndex, contextLines = 3) {
  return applyHunk(root, file, hunkIndex, 'index', contextLines);
}

/** 把单个文件撤出暂存区（git reset -- path，mixed：工作区内容不动） */
async function runResetPath(root, rel) {
  if (!rel) { return; }
  return run(root, ['reset', '-q', '--', rel]);
}

/** 该文件当前是否在暂存区里（git diff --cached --quiet 的退出码判断） */
async function isStagedFile(root, rel) {
  if (!rel) { return false; }
  try {
    const res = await run(root, ['diff', '--cached', '--quiet', '--', rel], { allowExitCodes: [1] });
    return res.code === 1; // 0=无暂存差异；1=暂存区有该文件的改动
  } catch (e) {
    return false;
  }
}

module.exports = {
  setDiagLogger,
  setGitPath,
  resetGit,
  getGitInfo,
  addSafeDirectory,
  run,
  topLevel,
  headExists,
  findRepos,
  getChanges,
  getDiff,
  getHeadContent,
  acceptFile,
  rejectFile,
  revertHunk,
  stageHunk,
  applyHunk,
  runResetPath,
  isStagedFile,
  parseStatusZ,
  classify
};
