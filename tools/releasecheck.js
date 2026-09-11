'use strict';

/**
 * 发布脚本的真实性测试：起一个本地 HTTP 服务模拟 GitHub / Gitea 的 Release API，
 * 真的把 tools/release.js --upload 跑一遍，校验：
 *   - 两个产物（vsix + 源码 zip）确实生成了
 *   - tag 与版本不一致时拒绝上传
 *   - Gitea 风格（没有 upload_url）走 /releases/{id}/assets 上传
 *   - GitHub 风格（响应带 upload_url）走 upload_url 上传
 *   - Release 已存在（422）时复用并覆盖同名资产
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra !== undefined ? '  ->  ' + extra : ''}`);
  }
}

/** 极简 zip 目录读取：从中央目录里取出所有条目名（只读，不依赖任何库） */
function readZipNames(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65536; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) { return null; }
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < count; i += 1) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) { return null; }
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    names.push(buf.slice(off + 46, off + 46 + nameLen).toString('utf8'));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

function runRelease(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'release.js'), '--upload'], {
      cwd: ROOT,
      env: Object.assign({}, process.env, env),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

/** 模拟 Release API。githubStyle=true 时返回带 upload_url 的响应（GitHub 语义） */
function startApi(opts) {
  const state = {
    uploaded: [],
    releaseExists: opts.releaseExists,
    deleted: [],
    creates: 0,
    existing: (opts.existingAssets || []).slice()
  };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const p = u.pathname;
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'POST' && p === '/api/v1/repos/o/r/releases') {
      state.creates += 1;
      if (state.releaseExists) { return send(422, { message: 'release already exists' }); }
      if (opts.githubStyle) {
        return send(201, {
          id: 8,
          tag_name: 'v0.5.0-pre',
          upload_url: `http://127.0.0.1:${server.address().port}/uploads/repos/o/r/releases/8/assets{?name,label}`
        });
      }
      return send(201, { id: 7, tag_name: 'v0.5.0-pre' });
    }
    if (req.method === 'GET' && p === '/api/v1/repos/o/r/releases/tags/v0.5.0-pre') {
      return send(200, opts.githubStyle
        ? { id: 8, tag_name: 'v0.5.0-pre', upload_url: `http://127.0.0.1:${server.address().port}/uploads/repos/o/r/releases/8/assets{?name,label}` }
        : { id: 7, tag_name: 'v0.5.0-pre' });
    }
    if (req.method === 'GET' && /^\/api\/v1\/repos\/o\/r\/releases\/\d+\/assets$/.test(p)) {
      const all = state.existing.map((n, i) => ({ id: 100 + i, name: n }))
        .concat(state.uploaded.map((n, i) => ({ id: 200 + i, name: n })));
      return send(200, all);
    }
    const delMatch = p.match(/^\/api\/v1\/repos\/o\/r\/(?:releases\/\d+\/assets|releases\/assets)\/(\d+)$/);
    if (req.method === 'DELETE' && delMatch) {
      const id = Number(delMatch[1]);
      state.deleted.push(id);
      if (id >= 100 && id < 200) { state.existing.splice(id - 100, 1); }
      return send(204, {});
    }
    // 资产上传：Gitea 走 /repos/{o}/{r}/releases/{id}/assets，GitHub 走 upload_url（/uploads/...）
    if (req.method === 'POST' && (/^\/api\/v1\/repos\/o\/r\/releases\/\d+\/assets$/.test(p) || /^\/uploads\/repos\/o\/r\/releases\/\d+\/assets$/.test(p))) {
      const name = u.searchParams.get('name');
      state.uploaded = state.uploaded.filter((n) => n !== name).concat(name);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ id: 300, name }));
    }
    send(404, { message: `unexpected ${req.method} ${p}` });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }));
  });
}

(async () => {
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  console.log(`\n[发布脚本] 当前版本 ${pkgVersion}`);

  // --- Case 1: tag 与版本不一致 → 直接拒绝，且不联网
  {
    const r = await runRelease({ RELEASE_TOKEN: 't', RELEASE_REPO: 'o/r', RELEASE_TAG: 'v9.9.9', RELEASE_API_URL: 'http://127.0.0.1:1' });
    check('tag 与 package.json 版本不一致 → 拒绝上传', r.code !== 0 && /不一致/.test(r.err + r.out), (r.err + r.out).trim().slice(-160));
  }

  // --- Case 2: Gitea 风格（响应无 upload_url）
  {
    const api = await startApi({ githubStyle: false, releaseExists: false });
    const r = await runRelease({
      RELEASE_TOKEN: 't', RELEASE_REPO: 'o/r', RELEASE_TAG: `v${pkgVersion}`,
      RELEASE_API_URL: `http://127.0.0.1:${api.port}`
    });
    check('Gitea 风格：脚本执行成功', r.code === 0, (r.err || r.out).trim().slice(-200));
    const names = api.state.uploaded.slice().sort();
    check('Gitea 风格：vsix 与源码 zip 都上传了',
      names.length === 2 && names.includes(`change-review-${pkgVersion}.vsix`) && names.includes(`change-review-${pkgVersion}-source.zip`),
      JSON.stringify(names));
    api.server.close();
  }

  // --- Case 3: GitHub 风格（响应带 upload_url）
  {
    const api = await startApi({ githubStyle: true, releaseExists: false });
    const r = await runRelease({
      RELEASE_TOKEN: 't', RELEASE_REPO: 'o/r', RELEASE_TAG: `v${pkgVersion}`,
      RELEASE_API_URL: `http://127.0.0.1:${api.port}`
    });
    check('GitHub 风格：脚本执行成功', r.code === 0, (r.err || r.out).trim().slice(-200));
    check('GitHub 风格：两个资产都通过 upload_url 上传', api.state.uploaded.length === 2, JSON.stringify(api.state.uploaded));
    api.server.close();
  }

  // --- Case 4: Release 已存在（422）→ 复用并覆盖同名资产
  {
    const api = await startApi({
      githubStyle: false,
      releaseExists: true,
      existingAssets: [`change-review-${pkgVersion}.vsix`, `change-review-${pkgVersion}-source.zip`]
    });
    const r = await runRelease({
      RELEASE_TOKEN: 't', RELEASE_REPO: 'o/r', RELEASE_TAG: `v${pkgVersion}`,
      RELEASE_API_URL: `http://127.0.0.1:${api.port}`
    });
    check('Release 已存在时复用而不报错', r.code === 0, (r.err || r.out).trim().slice(-200));
    check('重跑会先删掉同名旧资产再上传', api.state.deleted.length === 2 && api.state.uploaded.length === 2,
      `deleted=${JSON.stringify(api.state.deleted)} uploaded=${JSON.stringify(api.state.uploaded)}`);
    api.server.close();
  }

  // --- Case 5: 产物本身可用，而且别混进不该有的东西
  {
    const dist = path.join(ROOT, 'dist');
    const vsix = path.join(dist, `change-review-${pkgVersion}.vsix`);
    const zip = path.join(dist, `change-review-${pkgVersion}-source.zip`);
    check('dist 下有 vsix 产物', fs.existsSync(vsix), vsix);
    check('dist 下有源码 zip 产物', fs.existsSync(zip), zip);
    const vsixBuf = fs.existsSync(vsix) ? fs.readFileSync(vsix) : Buffer.alloc(0);
    const zipBuf = fs.existsSync(zip) ? fs.readFileSync(zip) : Buffer.alloc(0);
    check('vsix 是 zip 容器（魔数 PK）', vsixBuf.slice(0, 2).toString() === 'PK');
    check('源码 zip 是 zip 容器（魔数 PK）', zipBuf.slice(0, 2).toString() === 'PK');

    const vsixNames = readZipNames(vsixBuf);
    const zipNames = readZipNames(zipBuf);
    check('能读出 vsix 的条目列表', Array.isArray(vsixNames) && vsixNames.length > 10, JSON.stringify(vsixNames && vsixNames.length));
    check('vsix 含 src/extension.js 与 package.json',
      !!vsixNames && vsixNames.includes('extension/src/extension.js') && vsixNames.includes('extension/package.json'),
      JSON.stringify(vsixNames));
    check('vsix 没混进临时文件/构建产物',
      !!vsixNames && !vsixNames.some((n) => /\.tmp|\.log$|\.vsix$/.test(n) || n.includes('dist/')),
      JSON.stringify((vsixNames || []).filter((n) => /\.tmp|\.log$|\.vsix$/.test(n) || n.includes('dist/'))));

    check('源码包含 src/ 与 CI 配置',
      !!zipNames && zipNames.includes('src/extension.js') && zipNames.includes('.github/workflows/release.yml') && zipNames.includes('.gitea/workflows/release.yml'),
      JSON.stringify(zipNames));
    check('源码包没混进 dist/ 临时产物',
      !!zipNames && !zipNames.some((n) => n.startsWith('dist/') || n.startsWith('.tmp') || n.endsWith('.vsix')),
      JSON.stringify((zipNames || []).filter((n) => n.startsWith('dist/') || n.startsWith('.tmp') || n.endsWith('.vsix'))));
  }

  console.log(`\n${fail === 0 ? '全部通过 ✓' : `${fail} 项失败 ✗`}`);
  try { fs.rmSync(path.join(os.tmpdir(), 'cr-release-none'), { force: true }); } catch (e) { /* ignore */ }
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('发布脚本测试异常：', e && e.stack ? e.stack : e);
  process.exit(1);
});
