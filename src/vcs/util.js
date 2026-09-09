'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const platform = require('../platform');

const MAX_TEXT_SCAN = 2 * 1024 * 1024; // 二进制探测最多读 2MB

/** 生成物/忽略目录的默认模式：快照基准的排除列表、SVN 未版本化项的忽略列表共用同一套 */
const DEFAULT_EXCLUDE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.svn/**',
  '**/.hg/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/.next/**',
  '**/target/**',
  '**/bin/**',
  '**/obj/**',
  '**/.workbuddy/**',
  '**/*.log',
  '**/.DS_Store',
  '**/Thumbs.db'
];

/** 执行命令，返回 {code, stdout, stderr}。allowExitCodes 里的退出码视为正常。 */
function exec(bin, args, cwd, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      windowsHide: true,
      env: Object.assign({}, process.env, opts.env || {})
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      err.binStderr = stderr;
      reject(err);
    });
    child.on('close', (code) => {
      const allowed = opts.allowExitCodes || [];
      if (code === 0 || allowed.indexOf(code) !== -1) {
        resolve({ code, stdout, stderr });
        return;
      }
      const err = new Error(`${path.basename(bin)} ${args.join(' ')} 执行失败 (code=${code}): ${String(stderr || stdout || '').trim()}`);
      err.code = code;
      err.binStderr = stderr;
      err.stdout = stdout;
      reject(err);
    });
  });
}

/** 探测某个可执行文件是否可用 */
async function probeBin(bin, versionArgs = ['--version']) {
  try {
    const r = await exec(bin, versionArgs, process.cwd());
    return { bin, version: String(r.stdout || '').split('\n')[0].trim() };
  } catch (e) {
    return { bin, error: e.message.split('\n')[0] };
  }
}

/** 沿目录向上查找包含指定子目录（如 .git / .svn）的最近祖先 */
function findUp(dir, markerName, maxDepth) {
  let cur = path.resolve(dir);
  const limit = typeof maxDepth === 'number' ? maxDepth : 5;
  for (let i = 0; i <= limit; i += 1) {
    try {
      if (fs.existsSync(path.join(cur, markerName))) { return cur; }
    } catch (e) { /* ignore */ }
    const parent = path.dirname(cur);
    if (!parent || parent === cur) { break; }
    cur = parent;
  }
  return null;
}

/** 极简 glob：支持 **、*、?，分隔符统一用 / */
function globToRegExp(pattern) {
  let re = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i += 1;
        // 吃掉紧跟的 /
        if (pattern[i + 1] === '/') { i += 1; re += '(?:.*/)?'; }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.indexOf(c) !== -1) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp(re + '$');
}

/** 取 glob 正则的主体（去掉 ^ $ 锚点），便于按 gitignore 语义自行拼锚点 */
function globSource(pattern) {
  const src = globToRegExp(pattern).source;
  return src.slice(1, src.length - 1);
}

/**
 * gitignore 风格匹配：
 *  - build/          排除任意层级的 build 目录及其下所有内容
 *  - /build          只排除根下的 build
 *  - build           排除任意层级名为 build 的文件/目录（含其下内容）
 *  - *.log / .tmp.*  任意层级同名文件
 *  - a/b、多级星号路径模式    按路径 glob
 */
function matchAny(relPath, patterns) {
  const p = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const name = p.split('/').pop();
  for (const pat of patterns || []) {
    const raw = String(pat).replace(/\\/g, '/').trim();
    if (!raw || raw.startsWith('#')) { continue; }
    const s = raw.replace(/^\.\//, '').replace(/\/+$/, '') + (raw.endsWith('/') ? '/' : '');
    // gitignore 目录模式：以 / 结尾，只匹配目录及其内容
    if (s.endsWith('/')) {
      const dir = s.slice(0, -1);
      if (!dir) { continue; }
      const anchored = dir.indexOf('/') !== -1 || raw.startsWith('/');
      const re = new RegExp((anchored ? '^' : '(?:^|/)') + globSource(dir) + '(/|$)');
      if (re.test(p)) { return true; }
      continue;
    }
    if (raw.startsWith('/')) {
      // 根锚定：前导 / 是锚定符不是路径的一部分。/build → 根下的 build 及其内容
      const t = s.slice(1);
      if (!t) { continue; }
      if (new RegExp('^' + globSource(t) + '(/|$)').test(p)) { return true; }
      continue;
    }
    if (s.indexOf('/') === -1) {
      // 纯名字：任意层级同名文件，也命中同名目录下的内容（build → build/x.js）
      if (new RegExp('(?:^|/)' + globSource(s) + '$').test(p)) { return true; }
      if (globToRegExp(s).test(name)) { return true; }
      if (new RegExp('(?:^|/)' + globSource(s) + '/').test(p)) { return true; }
      continue;
    }
    if (globToRegExp(s).test(p)) { return true; }
    // 目录模式 **/node_modules/** 也命中其内部
    const dirForm = s.replace(/\/\*\*$/, '');
    if (dirForm !== s && globToRegExp(dirForm).test(p)) { return true; }
  }
  return false;
}

/**
 * 遍历目录下的普通文件。
 * @param {string} dir 要遍历的目录（绝对路径）
 * @param {object} opts
 *  - exclude: 忽略模式（glob）。默认按「相对 walk 根」匹配；
 *    传了 excludeFrom（相对仓库根的正斜杠路径）时，改为按「仓库根相对路径」匹配，
 *    用于遍历 svn 里某个未版本化子目录时仍能命中仓库级的忽略规则。
 * @returns {Array<{relPath:string, absPath:string, size:number, mtimeMs:number}>}
 */
function walk(dir, opts = {}) {
  const exclude = opts.exclude || [];
  const maxFiles = opts.maxFiles || 20000;
  const skipDirs = opts.skipDirs || ['.git', '.svn', '.hg', '.workbuddy'];
  const excludeFrom = opts.excludeFrom
    ? String(opts.excludeFrom).replace(/\\/g, '/').replace(/\/+$/, '')
    : '';
  const out = [];
  let truncated = false;

  const matchExcl = (rel) => (excludeFrom ? matchAny(excludeFrom + '/' + rel, exclude) : matchAny(rel, exclude));

  const rec = (cur, relBase) => {
    if (out.length >= maxFiles) { truncated = true; return; }
    let names;
    try {
      names = fs.readdirSync(cur);
    } catch (e) {
      return;
    }
    for (const name of names) {
      const abs = path.join(cur, name);
      const rel = relBase ? relBase + '/' + name : name;
      let st;
      try {
        st = fs.statSync(abs);
      } catch (e) {
        continue;
      }
      if (st.isDirectory()) {
        if (skipDirs.indexOf(name) !== -1) { continue; }
        if (matchExcl(rel)) { continue; }
        rec(abs, rel);
        continue;
      }
      if (!st.isFile()) { continue; }
      if (matchExcl(rel)) { continue; }
      if (out.length >= maxFiles) { truncated = true; return; }
      out.push({ relPath: rel, absPath: abs, size: st.size, mtimeMs: st.mtimeMs });
    }
  };
  rec(dir, '');
  return { files: out, truncated };
}

function sha1(text) {
  return crypto.createHash('sha1').update(String(text == null ? '' : text)).digest('hex');
}

/** 改动项的指纹：状态/行数/大小/mtime 变了就认为“又改过了”，已审查标记自动失效 */
function fileHashOf(file) {
  return sha1([file.relPath, file.kind, file.added, file.removed, statInfoOf(file.absPath)].join('|'));
}

function statInfoOf(absPath) {
  try {
    const st = fs.statSync(absPath);
    return `${st.size}:${Math.floor(st.mtimeMs)}`;
  } catch (e) {
    return 'missing';
  }
}

/** 文件内容 hash（用于快照基准快速判断是否变化） */
function fileHash(absPath) {
  try {
    const buf = fs.readFileSync(absPath);
    return crypto.createHash('sha1').update(buf).digest('hex');
  } catch (e) {
    return null;
  }
}

function isTextFile(absPath) {
  try {
    const fd = fs.openSync(absPath, 'r');
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(MAX_TEXT_SCAN, Math.max(size, 1)));
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    return buf.slice(0, read).indexOf(0) === -1;
  } catch (e) {
    return false;
  }
}

function readText(absPath) {
  return fs.readFileSync(absPath, 'utf8');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function rmDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    // 老版本 node 没有 rmSync
    try {
      const rimraf = (d) => {
        for (const name of fs.readdirSync(d)) {
          const p = path.join(d, name);
          const st = fs.lstatSync(p);
          if (st.isDirectory()) { rimraf(p); } else { fs.unlinkSync(p); }
        }
        fs.rmdirSync(d);
      };
      rimraf(dir);
    } catch (e2) { /* ignore */ }
  }
}

/** 限并发的 map */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  const workers = [];
  const n = Math.max(1, Math.min(limit, items.length));
  for (let w = 0; w < n; w += 1) {
    workers.push((async () => {
      for (;;) {
        const i = idx;
        idx += 1;
        if (i >= items.length) { return; }
        results[i] = await fn(items[i], i);
      }
    })());
  }
  await Promise.all(workers);
  return results;
}

function countLinesOfText(text) {
  if (!text) { return 0; }
  const n = (text.match(/\n/g) || []).length;
  return text.endsWith('\n') ? n : n + 1;
}

function relToAbs(root, relPath) {
  return platform.joinRepo(root, relPath);
}

/** scopeDir 相对 root 的正斜杠相对路径（root==scope 时返回空字符串） */
function scopeRelOf(root, scopeDir) {
  if (!scopeDir) { return ''; }
  const rel = platform.toPosix(path.relative(root, scopeDir));
  if (!rel || rel === '.') { return ''; }
  // scope 不在 root 之下（符号链接 / 挂载点 / 大小写路径不一致，Linux 常见）：
  // 绝不能把 ../xxx 当 git pathspec 传下去（会匹配不到任何文件 → "0 改动"假象），退化为整个仓库
  if (rel === '..' || rel.startsWith('../')) { return ''; }
  return rel;
}

/**
 * 判断某个「相对仓库根的 relPath」是否落在 scopeDir 之内。
 * scopeDir 为空 / 等于 root 时视为整个仓库。
 * @param {string} relPath git 风格相对路径（正斜杠）
 * @param {string} root 仓库根（本机绝对路径）
 * @param {string} scopeDir 打开目录（本机绝对路径，可空）
 */
function relInScope(relPath, root, scopeDir) {
  if (!scopeDir) { return true; }
  const rel = scopeRelOf(root, scopeDir);
  if (!rel) { return true; } // scopeDir == root：整个仓库
  const p = platform.toGitPath(relPath);
  return p === rel || p.startsWith(rel + '/');
}

module.exports = {
  DEFAULT_EXCLUDE,
  exec,
  probeBin,
  findUp,
  globToRegExp,
  globSource,
  matchAny,
  walk,
  sha1,
  fileHash,
  fileHashOf,
  statInfoOf,
  isTextFile,
  readText,
  ensureDir,
  rmDir,
  mapLimit,
  countLinesOfText,
  relToAbs,
  scopeRelOf,
  relInScope
};
