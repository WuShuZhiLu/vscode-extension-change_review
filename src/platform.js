'use strict';

const path = require('path');
const os = require('os');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';

/** 是否 Windows 风格路径（C:\... / C:/... / \\server\share） */
function isWindowsPath(p) {
  return /^[A-Za-z]:[\\/]/.test(String(p)) || String(p).startsWith('\\\\');
}

/** 是否 POSIX 绝对路径（/home/...），用于识别 "Linux 下跑着 Windows 版 git" */
function isPosixAbsPath(p) {
  return String(p).startsWith('/');
}

/** 各平台下 git 可执行文件的候选位置（按优先级） */
function gitCandidates() {
  const list = [];
  if (IS_WIN) {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA || '';
    list.push('git');
    list.push(path.join(pf, 'Git', 'cmd', 'git.exe'));
    list.push(path.join(pf, 'Git', 'bin', 'git.exe'));
    list.push(path.join(pf, 'Git', 'mingw64', 'bin', 'git.exe'));
    list.push(path.join(pf86, 'Git', 'cmd', 'git.exe'));
    if (local) { list.push(path.join(local, 'Programs', 'Git', 'cmd', 'git.exe')); }
    list.push(path.join(os.homedir(), 'scoop', 'apps', 'git', 'current', 'cmd', 'git.exe'));
  } else {
    list.push('git');
    list.push('/usr/bin/git');
    list.push('/usr/local/bin/git');
    list.push('/opt/homebrew/bin/git');
    if (IS_MAC) { list.push('/Applications/Xcode.app/Contents/Developer/usr/bin/git'); }
  }
  return Array.from(new Set(list));
}

/** 各平台下 svn 可执行文件的候选位置（按优先级） */
function svnCandidates() {
  const list = [];
  if (IS_WIN) {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    list.push('svn');
    list.push(path.join(pf, 'TortoiseSVN', 'bin', 'svn.exe'));
    list.push(path.join(pf86, 'TortoiseSVN', 'bin', 'svn.exe'));
    list.push(path.join(pf, 'SlikSvn', 'bin', 'svn.exe'));
    list.push(path.join(pf, 'VisualSVN', 'bin', 'svn.exe'));
    list.push(path.join(os.homedir(), 'scoop', 'apps', 'svn', 'current', 'bin', 'svn.exe'));
  } else {
    list.push('svn');
    list.push('/usr/bin/svn');
    list.push('/usr/local/bin/svn');
    list.push('/opt/homebrew/bin/svn');
    list.push('/opt/local/bin/svn');
  }
  return Array.from(new Set(list));
}

function normalizeForCompare(p) {
  let s = String(p || '');
  // 只有 Windows 把 '\' 当路径分隔符；POSIX 下 '\' 是合法的文件名字符，
  // 无条件归一会把 "C:\a\b"（一个文件名）误判成 "C:/a/b"（一个路径）。
  if (IS_WIN) { s = s.replace(/\\/g, '/'); }
  if (s.length > 1 && s.endsWith('/')) { s = s.slice(0, -1); }
  // Windows / macOS 文件系统默认大小写不敏感，Linux 敏感
  if (IS_WIN || IS_MAC) { s = s.toLowerCase(); }
  return s;
}

function samePath(a, b) {
  if (!a || !b) { return false; }
  return normalizeForCompare(a) === normalizeForCompare(b);
}

function toPosix(p) {
  return String(p || '').replace(/\\/g, '/');
}

/** git 的 pathspec 永远用正斜杠；仓库内相对路径 */
function toGitPath(relPath) {
  // 无条件替换，不能用 split(path.sep)：
  // WSL / Linux 上跑 Windows 版 git 时会拿到 "src\a.js" 这类路径，
  // 此时 path.sep 是 '/'，split(path.sep) 完全不生效，反斜杠会原样传给 git。
  return String(relPath || '').replace(/\\/g, '/');
}

/** 仓库根 + git 相对路径 -> 本机绝对路径 */
function joinRepo(root, relPath) {
  return path.join(root, String(relPath || '').split('/').join(path.sep));
}

module.exports = {
  IS_WIN, IS_MAC, IS_LINUX,
  isWindowsPath,
  isPosixAbsPath,
  gitCandidates,
  svnCandidates,
  samePath,
  toPosix,
  toGitPath,
  joinRepo,
  normalizeForCompare
};
