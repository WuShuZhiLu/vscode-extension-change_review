'use strict';

const fs = require('fs');
const path = require('path');
const platform = require('../platform');
const gitProvider = require('./gitProvider');
const svnProvider = require('./svnProvider');
const snapshotProvider = require('./snapshotProvider');
const util = require('./util');

const VCS_LABEL = { git: 'Git', svn: 'SVN', snapshot: '快照基准' };

function setPaths(opts) {
  if (opts && typeof opts.gitPath === 'string') {
    require('../gitService').setGitPath(opts.gitPath);
  }
  if (opts && typeof opts.svnPath === 'string') {
    svnProvider.setSvnPath(opts.svnPath);
  }
}

function orderOf(force) {
  const f = String(force || 'auto').toLowerCase();
  if (f === 'git') { return ['git', 'svn', 'snapshot']; }
  if (f === 'svn') { return ['svn', 'git', 'snapshot']; }
  if (f === 'snapshot') { return ['snapshot']; }
  return ['git', 'svn', 'snapshot'];
}

function markExists(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (e) {
    return false;
  }
}

/**
 * 在单个目录里按优先级探测版本控制。
 * 关键：SVN 的 .svn 可能在工作区的上级目录（甚至上上级），所以逐级向上找。
 */
async function detectIn(dir, opts) {
  const order = orderOf(opts.forceVcs);
  const problems = [];

  for (const kind of order) {
    if (kind === 'git') {
      try {
        const found = await gitProvider.detect(dir, opts.searchDepth);
        if (found) {
          const p = new gitProvider.GitProvider(found.root, { exclude: opts.exclude, excludeSets: opts.excludeSets });
          // 若 git 根高于打开目录（向上探测命中），改动只显示打开目录内
          p.addScope(dir);
          return { provider: p, kind: 'git' };
        }
      } catch (e) {
        if (e && e.dubiousRoot) { throw e; }
        problems.push(`git: ${e.message.split('\n')[0]}`);
        if (e && e.noGit && order.indexOf('git') === 0) {
          // git 不可用不是致命错误，继续尝试 svn / 快照
        }
      }
      continue;
    }
    if (kind === 'svn') {
      try {
        const found = svnProvider.detect(dir, opts.searchDepth);
        if (found) {
          const p = new svnProvider.SvnProvider(found.root, { exclude: opts.exclude, excludeSets: opts.excludeSets });
          p.addScope(dir);
          return { provider: p, kind: 'svn' };
        }
      } catch (e) {
        problems.push(`svn: ${e.message.split('\n')[0]}`);
      }
      continue;
    }
    if (kind === 'snapshot') {
      if (!opts.allowSnapshot) { continue; }
      return {
        provider: new snapshotProvider.SnapshotProvider(dir, opts.storageDir, Object.assign({}, opts.snapshotOptions, { runtimeExclude: opts.exclude, excludeSets: opts.excludeSets })),
        kind: 'snapshot'
      };
    }
  }
  return { provider: null, kind: null, problems };
}

/**
 * 为所有工作区目录建立 provider 列表。
 * @returns {Promise<{providers:Array, problems:Array<string>}>}
 */
async function buildProviders(folders, opts = {}) {
  const options = Object.assign({
    forceVcs: 'auto',
    searchDepth: 5,
    exclude: [],          // 全局手动排除（glob），对所有来源生效
    storageDir: '',
    allowSnapshot: true,
    snapshotOptions: {}
  }, opts);
  const providers = [];
  const problems = [];
  const failures = [];
  const byKey = new Map();

  const push = (p) => {
    const key = `${p.id}:${p.root}`;
    const existing = byKey.get(key);
    if (existing) {
      // 同一个根从另一个打开目录再次探测到：合并 scope，不要丢
      if (p.scopes) { for (const s of p.scopes) { existing.addScope(s); } }
      return;
    }
    byKey.set(key, p);
    providers.push(p);
  };

  for (const folder of folders || []) {
    if (!markExists(folder)) { continue; }
    let res;
    try {
      res = await detectIn(folder, options);
    } catch (e) {
      if (e && e.dubiousRoot) { throw e; }
      problems.push(`${folder}: ${e.message}`);
      if (e && e.noGit) {
        failures.push({ kind: 'git-missing', folder, message: e.message });
      }
      continue;
    }
    if (res.provider) {
      push(res.provider);
      continue;
    }
    for (const p of res.problems || []) { problems.push(`${folder}: ${p}`); }

    // 目录本身不是仓库：扫一层子目录（多仓库工作区）
    let names = [];
    try {
      names = fs.readdirSync(folder);
    } catch (e) {
      names = [];
    }
    for (const name of names) {
      const child = path.join(folder, name);
      if (!markExists(child)) { continue; }
      if (name === 'node_modules' || name.startsWith('.')) { continue; }
      try {
        const r = await detectIn(child, options);
        if (r.provider && r.kind !== 'snapshot') { push(r.provider); }
      } catch (e) {
        if (e && e.dubiousRoot) { throw e; }
        problems.push(`${child}: ${e.message}`);
        if (e && e.noGit) {
          failures.push({ kind: 'git-missing', folder: child, message: e.message });
        }
      }
    }

    // 扫完仍然什么都没有 → 该目录走快照基准
    if (options.allowSnapshot && !providers.some((p) => p.root === folder)) {
      const anyChild = providers.some((p) => p.root.startsWith(folder));
      if (!anyChild) {
        push(new snapshotProvider.SnapshotProvider(
          folder,
          options.storageDir,
          Object.assign({}, options.snapshotOptions, { runtimeExclude: options.exclude, excludeSets: options.excludeSets })
        ));
      }
    }
  }

  return { providers, problems, failures };
}

module.exports = {
  buildProviders,
  detectIn,
  setPaths,
  VCS_LABEL,
  GitProvider: gitProvider.GitProvider,
  SvnProvider: svnProvider.SvnProvider,
  SnapshotProvider: snapshotProvider.SnapshotProvider,
  util
};
