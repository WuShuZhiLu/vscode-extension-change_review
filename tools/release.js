'use strict';

/**
 * 发布打包脚本（GitHub / Gitea 共用，零依赖）。
 *
 * 用法：
 *   node tools/release.js            仅本地打包，产物放 dist/
 *   node tools/release.js --upload   打包后把两个产物上传到当前 tag 的 Release
 *
 * 产物：
 *   dist/change-review-<version>.vsix          扩展包
 *   dist/change-review-<version>-source.zip    源码包
 *
 * CI 里需要提供的环境变量（GitHub Actions / Gitea Actions 都会自动注入 GITHUB_*）：
 *   RELEASE_TOKEN || GITHUB_TOKEN        创建 Release / 上传资产
 *   RELEASE_REPO  || GITHUB_REPOSITORY   owner/repo
 *   RELEASE_TAG   || GITHUB_REF_NAME     形如 v0.5.0-pre 或 0.5.0-pre
 *   RELEASE_API_URL || GITHUB_API_URL    API 根（Gitea 会自动补 /api/v1）
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

// ---------------------------------------------------------------- 迷你 zip 写入器
// 不想为了打个源码包引入依赖，也不想依赖系统有没有 zip 命令，所以自己写最小的 ZIP。

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) { c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i += 1) { c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(d) {
  const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2))) & 0xFFFF;
  const date = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
  return { time, date };
}

/** entries: [{ name: 'a/b.txt', data: Buffer, mtime: Date }] → Buffer（deflate 压缩的 zip） */
function makeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const raw = zlib.deflateRawSync(e.data, { level: 9 });
    const useDeflate = raw.length < e.data.length;
    const body = useDeflate ? raw : e.data;
    const method = useDeflate ? 8 : 0;
    const { time, date } = dosDateTime(e.mtime || new Date());

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);       // version needed
    local.writeUInt16LE(0x0800, 6);   // flag: UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, body);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);         // version made by
    cen.writeUInt16LE(20, 6);         // version needed
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(e.data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);         // extra len
    cen.writeUInt16LE(0, 32);         // comment len
    cen.writeUInt16LE(0, 34);         // disk number
    cen.writeUInt16LE(0, 36);         // internal attrs
    cen.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attrs（普通文件 0644）
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, eocd]);
}

// ---------------------------------------------------------------- 源码包内容
const SOURCE_EXCLUDE_DIRS = new Set(['.git', 'node_modules', 'dist', '.workbuddy']);
const SOURCE_EXCLUDE_FILES = new Set(['.DS_Store', 'Thumbs.db']);

function collectSource(dir, relBase, out) {
  for (const name of fs.readdirSync(dir)) {
    if (SOURCE_EXCLUDE_DIRS.has(name) || SOURCE_EXCLUDE_FILES.has(name)) { continue; }
    if (name.endsWith('.vsix')) { continue; }
    if (name.startsWith('.tmp')) { continue; } // 打包过程中的临时文件/日志，别混进源码包
    const abs = path.join(dir, name);
    const rel = relBase ? `${relBase}/${name}` : name;
    const st = fs.statSync(abs);
    if (st.isDirectory()) { collectSource(abs, rel, out); continue; }
    if (!st.isFile()) { continue; }
    out.push({ name: rel, data: fs.readFileSync(abs), mtime: st.mtime });
  }
  return out;
}

// ---------------------------------------------------------------- Release 说明
function readReleaseNotes(version) {
  for (const file of ['CHANGELOG.md', 'CHANGELOG.en.md']) {
    const p = path.join(ROOT, file);
    if (!fs.existsSync(p)) { continue; }
    const text = fs.readFileSync(p, 'utf8');
    const base = String(version).split('-')[0];
    const lines = text.split(/\r?\n/);
    let start = -1;
    for (let i = 0; i < lines.length; i += 1) {
      const m = lines[i].match(/^##\s+(\S+)\s*$/);
      if (m && (m[1] === version || m[1] === base)) { start = i + 1; break; }
    }
    if (start === -1) { continue; }
    const body = [];
    for (let i = start; i < lines.length; i += 1) {
      if (/^##\s+/.test(lines[i])) { break; }
      body.push(lines[i]);
    }
    const texted = body.join('\n').trim();
    if (texted) { return texted; }
  }
  return `Release ${version}`;
}

// ---------------------------------------------------------------- 打包
function run(cmd, args, opts) {
  return execFileSync(cmd, args, Object.assign({ cwd: ROOT, encoding: 'utf8', stdio: 'inherit' }, opts || {}));
}

/** 跑 npx：Windows 上 npx 是 .cmd，Node 新版本不允许不带 shell 直接执行 .cmd，走 cmd /c */
function runNpx(args) {
  if (process.platform === 'win32') {
    return run('cmd', ['/c', 'npx'].concat(args));
  }
  return run('npx', args);
}

/**
 * 找「已经装好的 vsce」直接用 node 跑。
 * 每次 `npx -y @vscode/vsce@latest` 都要重新解析依赖，单次要十几秒；
 * 迭代时这一下最费时间。这里优先用预装好的 vsce（一次装好，之后秒级）。
 */
function findVsce() {
  const candidates = [
    process.env.CHANGE_REVIEW_VSCE,
    path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules', '@vscode', 'vsce', 'vsce')
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) { return c; } } catch (e) { /* ignore */ }
  }
  return null;
}

function packageVsix(vsixPath) {
  const args = ['package', '--no-yarn', '--allow-missing-repository', '-o', vsixPath];
  const vsce = findVsce();
  if (vsce) {
    run(process.execPath, [vsce].concat(args)); // 直接用 node 跑，省掉 npx 解析
    return;
  }
  console.log('[release] 本地没装 vsce，退回 npx（首次会慢；想加速执行：');
  console.log(`          npm install --prefix "${path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'workspace')}" @vscode/vsce`);
  runNpx(['-y', '@vscode/vsce@latest'].concat(args));
}

function build() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const version = pkg.version;
  fs.mkdirSync(DIST, { recursive: true });

  const vsixPath = path.join(DIST, `change-review-${version}.vsix`);
  console.log(`[release] 打包扩展 ${version} …`);
  packageVsix(vsixPath);
  if (!fs.existsSync(vsixPath)) { throw new Error(`vsix 没生成：${vsixPath}`); }

  const entries = collectSource(ROOT, '', []);
  const zipPath = path.join(DIST, `change-review-${version}-source.zip`);
  fs.writeFileSync(zipPath, makeZip(entries));
  console.log(`[release] 源码包：${entries.length} 个文件 → ${path.relative(ROOT, zipPath)}`);

  return { version, pkg, vsixPath, zipPath, notes: readReleaseNotes(version) };
}

/** 本地装上刚打好的 vsix（版本号变了也不用改脚本） */
function installLocal(vsixPath) {
  const code = process.platform === 'win32' ? 'code.cmd' : 'code';
  console.log(`[release] 安装到本机 VSCode：${path.basename(vsixPath)}`);
  try {
    execFileSync(code, ['--install-extension', vsixPath, '--force'], { cwd: ROOT, stdio: 'inherit' });
  } catch (e) {
    if (process.platform === 'win32') {
      run('cmd', ['/c', 'code', '--install-extension', vsixPath, '--force']); // code 是 .cmd，走 shell
      return;
    }
    throw e;
  }
}

// ---------------------------------------------------------------- 上传 Release
function apiBase() {
  let api = String(process.env.RELEASE_PUBLIC_URL || process.env.RELEASE_API_URL || process.env.GITHUB_API_URL || '').replace(/\/+$/, '');
  if (!api) {
    const server = String(process.env.GITHUB_SERVER_URL || '').replace(/\/+$/, '');
    if (!server) { throw new Error('缺少 RELEASE_PUBLIC_URL / RELEASE_API_URL / GITHUB_API_URL，无法上传'); }
    api = `${server}/api/v1`;
  }
  let host = '';
  // 用 hostname（不带端口）：下面判断 api.github.com 时不受 :443 之类干扰
  try { host = new URL(api).hostname; } catch (e) { throw new Error(`API 地址不合法：${api}`); }
  // GitHub 的 API 根就是 api.github.com；Gitea 需要 /api/v1 前缀
  if (!/github\.com$/i.test(host) && !/\/api\/v1$/i.test(api)) { api += '/api/v1'; }
  return api;
}

/** undici 的 fetch 只会抛「TypeError: fetch failed」，真实原因藏在 e.cause 链里，这里挖出来 */
function describeFetchError(err) {
  const parts = [];
  for (let e = err, depth = 0; e && depth < 5; e = e.cause, depth += 1) {
    const code = e.code || e.errno;
    parts.push([e.name || 'Error', code ? `(${code})` : '', e.message || ''].filter(Boolean).join(' '));
  }
  return parts.join(' ← ');
}

/**
 * 连不上时补一圈旁证：DNS 能否解析、端口通不通、有没有代理拦截。
 * 自建 runner 与 Gitea 是否同处一个 docker 网络，光看「fetch failed」判断不了。
 */
async function diagnoseConnectivity(url) {
  const net = require('net');
  const out = [];
  let u;
  try { u = new URL(url); } catch (e) { return [`  地址解析失败：${url}`]; }
  const host = u.hostname;
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));

  out.push(`  目标：${u.protocol}//${host}:${port}`);
  out.push(`  注入变量：GITHUB_API_URL=${process.env.GITHUB_API_URL || '(空)'}  GITHUB_SERVER_URL=${process.env.GITHUB_SERVER_URL || '(空)'}`);

  let addrs;
  try {
    addrs = await require('dns').promises.lookup(host, { all: true });
  } catch (e) {
    out.push(`  DNS：解析失败（${e.code || e.message}）—— runner 与「${host}」可能不在同一 docker 网络`);
    return out;
  }
  out.push(`  DNS：可解析 → ${addrs.map((a) => a.address).join(', ')}`);

  await new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (msg) => { out.push(`  TCP ${port}：${msg}`); sock.destroy(); resolve(); };
    sock.setTimeout(4000);
    sock.on('connect', () => done('可连接'));
    sock.on('timeout', () => done('连接超时'));
    sock.on('error', (e) => done(`连接失败（${e.code || e.message}）`));
  });

  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
  if (proxy) { out.push(`  代理：${proxy}（若拦了内网请求，可设 NO_PROXY=${host}）`); }
  return out;
}

async function api(method, url, token, body, extraHeaders, raw) {
  const headers = Object.assign({ Authorization: `token ${token}`, 'User-Agent': 'change-review-release' }, extraHeaders || {});
  if (body && !raw) { headers['Content-Type'] = 'application/json'; }
  let res;
  try {
    res = await fetch(url, { method, headers, body: body ? (raw ? body : JSON.stringify(body)) : undefined });
  } catch (e) {
    let diag = [];
    try { diag = await diagnoseConnectivity(url); } catch (err) { /* 诊断失败不影响主错误 */ }
    throw new Error([`${method} ${url} 网络请求失败：${describeFetchError(e)}`, ...diag].join('\n'));
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* 非 JSON */ }
  return { status: res.status, ok: res.ok, json, text };
}

async function upload() {
  const token = process.env.RELEASE_TOKEN || process.env.GITHUB_TOKEN;
  const repo = process.env.RELEASE_REPO || process.env.GITHUB_REPOSITORY;
  const tag = process.env.RELEASE_TAG || process.env.GITHUB_REF_NAME;
  if (!token) { throw new Error('缺少 RELEASE_TOKEN / GITHUB_TOKEN'); }
  if (!repo) { throw new Error('缺少 RELEASE_REPO / GITHUB_REPOSITORY'); }
  if (!tag) { throw new Error('缺少 RELEASE_TAG / GITHUB_REF_NAME'); }

  const base = apiBase();

  // tag 必须和 package.json 的版本对得上，避免发出错误的产物（先校验，再打包）
  const declared = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const tagVersion = tag.replace(/^v/i, '');
  if (tagVersion !== declared) {
    throw new Error(`tag「${tag}」与 package.json 版本「${declared}」不一致：请先把版本号改成 ${tagVersion} 再打 tag`);
  }

  const { version, vsixPath, zipPath, notes } = build();

  const prerelease = /-/.test(version); // 0.5.0-pre 这种带预发布段 → 标记为 prerelease
  const payload = {
    tag_name: tag,
    name: `Change Review ${version}`,
    body: notes,
    draft: false,
    prerelease
  };

  console.log(`[release] 创建 Release ${tag}（prerelease=${prerelease}）…`);
  let res = await api('POST', `${base}/repos/${repo}/releases`, token, payload);
  let release = res.json;
  // 只认真正的 GitHub。不能靠「响应里有没有 upload_url」判断：Gitea 的 Release JSON
  // 同样带 upload_url，而那里的 host 是 Gitea 的 ROOT_URL（可能配成公网地址，runner 连不上）。
  // 用 base 的主机名判断；Gitea 一律走自己的 asset API（拼 ${base}，不用服务端返回的 URL）。
  let isGithub = false;
  try { isGithub = /(^|\.)github\.com$/i.test(new URL(base).hostname); } catch (e) { /* 保持 false */ }
  const flavor = isGithub ? 'github' : 'gitea';
  if (!res.ok) {
    // 已经存在（重跑 CI）→ 取回来复用
    if (res.status === 422 || res.status === 409) {
      const got = await api('GET', `${base}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, token);
      if (!got.ok) { throw new Error(`Release 已存在但读取失败：${got.status} ${got.text.slice(0, 300)}`); }
      release = got.json;
      console.log('[release] Release 已存在，改为覆盖资产');
    } else {
      throw new Error(`创建 Release 失败：${res.status} ${res.text.slice(0, 400)}`);
    }
  }

  const assets = [
    { file: vsixPath, name: path.basename(vsixPath), type: 'application/zip' },
    { file: zipPath, name: path.basename(zipPath), type: 'application/zip' }
  ];
  const existing = await api('GET', `${base}/repos/${repo}/releases/${release.id}/assets`, token);
  const have = Array.isArray(existing.json) ? existing.json : [];
  for (const a of assets) {
    for (const old of have.filter((x) => x.name === a.name)) {
      const delUrl = flavor === 'github'
        ? `${base}/repos/${repo}/releases/assets/${old.id}`
        : `${base}/repos/${repo}/releases/${release.id}/assets/${old.id}`;
      await api('DELETE', delUrl, token);
    }
    const data = fs.readFileSync(a.file);
    const url = flavor === 'github'
      ? `${String(release.upload_url).replace(/\{.*$/, '')}?name=${encodeURIComponent(a.name)}`
      : `${base}/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(a.name)}`;
    console.log(`[release] 上传 ${a.name} → ${url.replace(/\?.*$/, '')}（flavor=${flavor}）`);
    const up = await api('POST', url, token, data, { 'Content-Type': a.type, 'Content-Length': data.length }, true);
    if (!up.ok) { throw new Error(`上传 ${a.name} 失败：${up.status} ${up.text.slice(0, 300)}`); }
    console.log(`[release] 已上传 ${a.name}（${(data.length / 1024).toFixed(1)} KB）`);
  }
  console.log(`[release] 完成：${repo} ${tag}`);
}

(async () => {
  try {
    if (process.argv.includes('--upload')) {
      await upload();
    } else {
      const { vsixPath } = build();
      if (process.argv.includes('--install')) { installLocal(vsixPath); }
    }
  } catch (e) {
    console.error(`\n[release] 失败：${e.message}`);
    process.exit(1);
  }
})();
