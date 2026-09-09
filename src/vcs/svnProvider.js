'use strict';

const fs = require('fs');
const path = require('path');
const platform = require('../platform');
const { parseDiff, clustersOf, hunkForCluster } = require('../diffParser');
const { makeUnifiedDiff, countFromUnified, revertHunkInText, splitLines } = require('../diffEngine');
const util = require('./util');

/**
 * SVN provider：以 BASE（svn 的基础版本）为对比基准。
 * 只用到 svn 的 status / cat / revert / info 四个子命令；
 * diff 由 JS 引擎从「BASE 内容 vs 工作副本内容」算出，
 * 好处是不受 svn 输出换行风格影响，块级操作（接受/拒绝某块）的坐标永远和文件内容一致。
 */

let configuredSvn = '';
let resolvedSvn = null;
const badSvn = new Set();

function setSvnPath(p) {
  const v = String(p || '').trim();
  if (v !== configuredSvn) {
    configuredSvn = v;
    resetSvn();
  }
}

function resetSvn() {
  resolvedSvn = null;
  badSvn.clear();
}

function candidates() {
  const list = [];
  if (configuredSvn) { list.push(configuredSvn); }
  for (const c of platform.svnCandidates()) { list.push(c); }
  return Array.from(new Set(list));
}

async function ensureSvn() {
  if (resolvedSvn) { return resolvedSvn; }
  const errors = [];
  for (const cand of candidates()) {
    if (badSvn.has(cand)) { continue; }
    try {
      const r = await util.exec(cand, ['--version', '--quiet'], process.cwd());
      if (!/^\d+\.\d+/.test(String(r.stdout || '').trim())) { throw new Error('不是 svn'); }
      resolvedSvn = cand;
      return cand;
    } catch (e) {
      badSvn.add(cand);
      errors.push(`${cand}: ${e.message.split('\n')[0]}`);
    }
  }
  const err = new Error(
    `未找到可用的 svn 可执行文件${platform.IS_WIN ? '（Windows）' : '（Linux/macOS）'}。` +
    `请在 VSCode 设置里把 changeReview.svnPath 填成 svn 的完整路径。\n尝试过：\n${errors.join('\n')}`
  );
  err.noSvn = true;
  throw err;
}

function markBadSvn() {
  if (resolvedSvn) { badSvn.add(resolvedSvn); }
  resolvedSvn = null;
}

async function run(cwd, args, opts = {}, depth = 0) {
  const bin = await ensureSvn();
  // 注意：svn 的全局选项必须放在子命令之前，放到末尾会被当成 target
  try {
    return await util.exec(bin, ['--non-interactive'].concat(args), cwd, opts);
  } catch (e) {
    if (e && e.code === 'ENOENT' && depth < 3) {
      markBadSvn();
      return run(cwd, args, opts, depth + 1);
    }
    throw e;
  }
}

const STATUS_RE = /^(.{7})\s+(.*)$/;

/**
 * 解析 svn status 输出。
 * 列含义：1=文本/目录状态 2=属性 3=锁定 4=历史 5=switch 6=锁令牌 7=树冲突
 */
function parseStatus(out) {
  const rows = [];
  for (const rawLine of String(out || '').split(/\r?\n/)) {
    if (!rawLine.trim()) { continue; }
    const m = STATUS_RE.exec(rawLine);
    if (!m) { continue; }
    const p = m[2].trimEnd();
    if (!p || p.startsWith('>')) { continue; } // "> moved from ..." 之类的附加行
    rows.push({
      text: m[1][0] || ' ',
      prop: m[1][1] || ' ',
      tree: m[1][6] || ' ',
      relPath: p.replace(/\\/g, '/')
    });
  }
  return rows;
}

function classify(row) {
  switch (row.text) {
    case '?': return 'untracked';
    case '!': return 'deleted';   // 缺失（被手工删掉但没 svn delete）
    case 'D': return 'deleted';
    case 'A': return 'added';
    case 'R': return 'modified';  // 替换
    case 'C': return 'conflict';
    case '~': return 'conflict';  // 类型冲突
    case 'I': return 'ignored';
    case 'X': return 'ignored';
    case 'M': return 'modified';
    default: return 'modified';
  }
}

class SvnProvider {
  constructor(root, options = {}) {
    this.id = 'svn';
    this.label = 'SVN';
    this.root = root;
    this.baseLabel = 'BASE（SVN 基础版本）';
    this.scopes = new Set(); // 空 = 整个工作副本；非空 = 只列这些打开目录内的改动
    // 手动排除规则：用户填的 glob 列表（默认空），对所有改动生效（包括版本化的
    // 修改与删除、以及未版本化项）。设 [] 表示不额外排除。
    this.exclude = Array.isArray(options && options.exclude) ? options.exclude : [];
    this.capabilities = {
      stage: false,       // SVN 没有暂存区，“接受”只能标记为已审查
      hunkStage: false,
      hunkRevert: true,
      revertFile: true,
      baselineUpdate: false
    };
    this.baseCache = new Map();
    this.revision = '';
  }

  addScope(dir) {
    if (dir) { this.scopes.add(dir); }
  }

  inScope(relPath) {
    if (!this.scopes.size) { return true; }
    for (const scope of this.scopes) {
      if (util.relInScope(relPath, this.root, scope)) { return true; }
    }
    return false;
  }

  abs(relPath) {
    return util.relToAbs(this.root, relPath);
  }

  /** BASE 版本内容（带缓存，缓存以文件 size/mtime 为失效依据） */
  async baseContent(file) {
    if (file.kind === 'untracked' || file.kind === 'added') { return ''; }
    const key = file.relPath;
    const stamp = util.statInfoOf(file.absPath);
    const hit = this.baseCache.get(key);
    if (hit && hit.stamp === stamp) { return hit.text; }
    let text = '';
    try {
      const r = await run(this.root, ['cat', '-r', 'BASE', '--', file.relPath]);
      text = r.stdout;
    } catch (e) {
      text = '';
    }
    this.baseCache.set(key, { stamp, text });
    return text;
  }

  currentContent(file) {
    try {
      if (!fs.existsSync(file.absPath)) { return ''; }
      return fs.readFileSync(file.absPath, 'utf8');
    } catch (e) {
      return '';
    }
  }

  async listChanges() {
    // scope 存在时只对打开的目录跑 status（大仓库根下避免全量扫描）
    const targets = [];
    for (const scope of this.scopes) {
      const rel = util.scopeRelOf(this.root, scope);
      if (rel) { targets.push(rel); }
    }
    const args = targets.length ? ['status', '--'].concat(targets) : ['status'];
    const r = await run(this.root, args);
    const rows = parseStatus(r.stdout);
    const files = [];
    const dirQueue = [];

    for (const row of rows) {
      const kind = classify(row);
      if (kind === 'ignored') { continue; }
      if (!this.inScope(row.relPath)) { continue; }
      // 命中用户手动填的排除规则：跳过（对所有 kind 生效，包括 M/A/D/?）
      if (this.exclude.length && util.matchAny(row.relPath, this.exclude)) { continue; }
      const abs = this.abs(row.relPath);
      let isDir = false;
      try {
        isDir = fs.statSync(abs).isDirectory();
      } catch (e) {
        isDir = false;
      }
      if (isDir) {
        if (kind === 'untracked') { dirQueue.push(row.relPath); }
        continue; // 目录本身不列为文件
      }
      files.push(this.makeFile(row.relPath, kind, row.text));
    }

    // 未版本化的目录：展开其中的文件（排除规则按仓库相对路径匹配，命中即跳过）
    for (const dir of dirQueue) {
      if (this.exclude.length && util.matchAny(dir, this.exclude)) { continue; }
      const { files: found } = util.walk(this.abs(dir), { maxFiles: 5000, exclude: this.exclude, excludeFrom: dir });
      for (const f of found) {
        const rel = dir + '/' + f.relPath;
        files.push(this.makeFile(rel, 'untracked', '?'));
      }
    }

    // 统计增删行数并过滤掉“没有实际文本差异”的项（例如只有属性变化）
    const result = [];
    await util.mapLimit(files, 8, async (file) => {
      const base = await this.baseContent(file);
      const current = file.kind === 'deleted' ? '' : this.currentContent(file);
      if (base === current) { return; }
      const diffText = makeUnifiedDiff(base, current, file.relPath, 3);
      const { added, removed } = countFromUnified(diffText);
      file.added = added;
      file.removed = removed;
      if (file.kind === 'untracked' && !added) {
        file.added = util.countLinesOfText(current); // 空文件等边界
      }
      result.push(file);
    });

    result.sort((a, b) => a.relPath.localeCompare(b.relPath));
    return result;
  }

  makeFile(relPath, kind, statusChar) {
    const absPath = this.abs(relPath);
    return {
      relPath,
      absPath,
      status: statusChar,
      kind,
      added: 0,
      removed: 0,
      staged: false,
      provider: 'svn',
      hash: ''
    };
  }

  async getDiff(file, contextLines = 3) {
    const base = await this.baseContent(file);
    const current = file.kind === 'deleted' ? '' : this.currentContent(file);
    return makeUnifiedDiff(base, current, file.relPath, contextLines);
  }

  async getBaseContent(file) {
    return this.baseContent(file);
  }

  async acceptFile() {
    // SVN 没有暂存区，接受 = 保留改动并标记已审查（由上层打钩）
    return { staged: false, message: 'SVN 没有暂存区，已保留改动' };
  }

  async rejectFile(file) {
    // 未版本化：直接删工作区文件
    if (file.kind === 'untracked') {
      try { fs.unlinkSync(file.absPath); } catch (e) { /* 文件可能已经没了 */ }
      this.baseCache.delete(file.relPath);
      return { message: '已删除未版本化文件' };
    }
    // 已 svn add 但未提交（status A）：删工作区文件并从待提交列表移除
    if (file.kind === 'added') {
      try { fs.unlinkSync(file.absPath); } catch (e) { /* 容忍 */ }
      try { await run(this.root, ['revert', '--', file.relPath]); } catch (e) { /* 容忍 */ }
      this.baseCache.delete(file.relPath);
      return { message: '已删除新增文件' };
    }
    // 已版本化（修改 / 删除）：还原到 BASE
    try {
      await run(this.root, ['revert', '--', file.relPath]);
    } catch (e) {
      throw new Error(`svn revert 失败：${e.message}`);
    }
    // 安全网：BASE 若是空文件，revert 后工作区也是空文件，但用户期望"全清零"应直接删
    try {
      if (fs.existsSync(file.absPath) && fs.statSync(file.absPath).size === 0 && file.kind === 'modified') {
        // 文件被完全删除时 baseContent 为空，revert 会把空 base 写回——用户视角是"全新增的"，
        // 这种情形按"删除新文件"处理更符合直觉。
        fs.unlinkSync(file.absPath);
        try { await run(this.root, ['revert', '--', file.relPath]); } catch (e) { /* 容忍 */ }
        this.baseCache.delete(file.relPath);
        return { message: '已删除新增文件' };
      }
    } catch (e) { /* 容忍 */ }
    this.baseCache.delete(file.relPath);
    return { message: '已 svn revert 还原到 BASE' };
  }

  async acceptHunk() {
    return { staged: false, message: 'SVN 没有暂存区，该块仅标记为已接受' };
  }

  async rejectHunk(file, hunkIndex, contextLines = 3) {
    const diffText = await this.getDiff(file, contextLines);
    const parsed = parseDiff(diffText);
    if (!parsed.length) { throw new Error('无法解析该文件的差异'); }
    const hunk = parsed[0].hunks[hunkIndex];
    if (!hunk) { throw new Error(`未找到第 ${hunkIndex + 1} 个改动块`); }
    const current = this.currentContent(file);
    const next = revertHunkInText(current, hunk);
    fs.writeFileSync(file.absPath, next);
    this.baseCache.delete(file.relPath);
    return { message: '该块已还原' };
  }

  /** 只还原一个块里的第 clusterIndex 段改动 */
  async rejectCluster(file, hunkIndex, clusterIndex, contextLines = 3) {
    const diffText = await this.getDiff(file, contextLines);
    const parsed = parseDiff(diffText);
    if (!parsed.length) { throw new Error('无法解析该文件的差异'); }
    const hunk = parsed[0].hunks[hunkIndex];
    if (!hunk) { throw new Error(`未找到第 ${hunkIndex + 1} 个改动块`); }
    const cluster = clustersOf(hunk)[clusterIndex];
    if (!cluster) { throw new Error(`未找到第 ${clusterIndex + 1} 段改动`); }
    const current = this.currentContent(file);
    const next = revertHunkInText(current, hunkForCluster(cluster));
    fs.writeFileSync(file.absPath, next);
    this.baseCache.delete(file.relPath);
    return { message: '该段已还原' };
  }

  async describe() {
    const out = [];
    out.push('类型: SVN');
    out.push(`工作副本根: ${this.root}`);
    try {
      const r = await run(this.root, ['info', '--show-item', 'revision', '--show-item', 'url']);
      const lines = String(r.stdout || '').split(/\r?\n/).filter((s) => s.trim());
      out.push(`版本库信息: ${lines.join('  ')}`);
    } catch (e) {
      out.push(`svn info 失败: ${e.message}`);
    }
    return out;
  }
}

/** 向上探测 .svn（父目录、上上级……） */
function detect(folder, maxDepth = 5) {
  const found = util.findUp(folder, '.svn', maxDepth);
  if (!found) { return null; }
  return { root: found };
}

module.exports = { SvnProvider, detect, setSvnPath, resetSvn, ensureSvn, parseStatus, classify, getSvnBin: () => resolvedSvn };
