'use strict';

const fs = require('fs');
const path = require('path');
const { parseDiff, clustersOf, hunkForCluster } = require('../diffParser');
const { makeUnifiedDiff, countFromUnified, revertHunkInText } = require('../diffEngine');
const util = require('./util');

const INDEX_NAME = 'index.json';
const FILES_DIR = 'files';

/**
 * 快照基准 provider：用于既没有 git 也没有 svn 的项目。
 * 首次「初始化对比基准」把当前所有文件的内容复制一份存到扩展的 globalStorage
 * （不写进项目目录，不污染工作区），之后以它为基准对比；可随时「更新对比基准」。
 */
class SnapshotProvider {
  constructor(root, storageDir, options = {}) {
    this.id = 'snapshot';
    this.label = util.uiLang() === 'zh' ? '快照基准' : 'Snapshot';
    this.root = root;
    this.storageDir = storageDir;
    const given = options || {};
    this.options = {
      exclude: given.exclude && given.exclude.length ? given.exclude : util.DEFAULT_EXCLUDE.slice(),
      maxFileSizeKB: given.maxFileSizeKB || 1024,
      maxFiles: given.maxFiles || 10000
    };
    // 运行时列表排除（来自 changeReview.exclude），对所有 kind 生效；不影响基准
    this.runtimeExclude = Array.isArray(options.runtimeExclude) ? options.runtimeExclude : [];
    // 项目忽略文件（.crignore / .gitignore fallback）：按「各自规则文件所在目录」锚定（同 .gitignore 语义）
    this.excludeSets = Array.isArray(options.excludeSets) ? options.excludeSets : [];
    this.baseLabel = util.uiLang() === 'zh' ? '基准快照' : 'Baseline snapshot';
    this.capabilities = {
      stage: false,
      hunkStage: false,
      hunkRevert: true,
      revertFile: true,
      baselineUpdate: true
    };
    this.index = null;
  }

  get dir() {
    return path.join(this.storageDir, 'snapshots', util.sha1(this.root).slice(0, 16));
  }

  get indexPath() {
    return path.join(this.dir, INDEX_NAME);
  }

  abs(relPath) {
    return util.relToAbs(this.root, relPath);
  }

  baseFileOf(relPath) {
    return path.join(this.dir, FILES_DIR, relPath.split('/').join(path.sep));
  }

  loadIndex() {
    if (this.index) { return this.index; }
    try {
      this.index = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'));
    } catch (e) {
      this.index = null;
    }
    return this.index;
  }

  saveIndex() {
    util.ensureDir(this.dir);
    fs.writeFileSync(this.indexPath, JSON.stringify(this.index), 'utf8');
  }

  hasBaseline() {
    return !!this.loadIndex();
  }

  baselineInfo() {
    const idx = this.loadIndex();
    if (!idx) { return null; }
    return {
      createdAt: idx.createdAt,
      updatedAt: idx.updatedAt,
      fileCount: Object.keys(idx.files || {}).length,
      root: idx.root
    };
  }

  scan() {
    return util.walk(this.root, {
      exclude: this.options.exclude,
      maxFiles: this.options.maxFiles
    });
  }

  /** 初始化 / 全量重建基准 */
  initBaseline() {
    util.ensureDir(this.dir);
    const filesDir = path.join(this.dir, FILES_DIR);
    util.rmDir(filesDir);
    util.ensureDir(filesDir);
    const { files } = this.scan();
    const index = { root: this.root, createdAt: Date.now(), updatedAt: Date.now(), files: {} };
    const maxBytes = this.options.maxFileSizeKB * 1024;
    for (const f of files) {
      const hash = util.fileHash(f.absPath);
      let stored = false;
      let lines = 0;
      if (hash !== null && f.size <= maxBytes && util.isTextFile(f.absPath)) {
        try {
          const dest = this.baseFileOf(f.relPath);
          util.ensureDir(path.dirname(dest));
          fs.copyFileSync(f.absPath, dest);
          stored = true;
        } catch (e) {
          stored = false;
        }
      }
      index.files[f.relPath] = {
        size: f.size,
        mtimeMs: Math.floor(f.mtimeMs),
        hash,
        stored,
        lines
      };
    }
    this.index = index;
    this.saveIndex();
    return { fileCount: Object.keys(index.files).length, truncated: false };
  }

  /** 更新基准：只传 relPaths 则更新这些文件，不传则全量重建 */
  updateBaseline(relPaths) {
    const idx = this.loadIndex();
    if (!idx) { return this.initBaseline(); }
    let list;
    if (relPaths && relPaths.length) {
      list = relPaths;
    } else {
      // 全量更新：除了基准里已有的文件，还必须把当前扫描到的新文件也纳入基准。
      // 否则 untracked 新文件永远不在 idx.files 里，「更新基准」后它们仍显示为差异。
      const { files } = this.scan();
      const all = new Set(Object.keys(idx.files));
      for (const f of files) { all.add(f.relPath); }
      list = Array.from(all);
    }
    const maxBytes = this.options.maxFileSizeKB * 1024;
    for (const rel of list) {
      const abs = this.abs(rel);
      if (!fs.existsSync(abs)) {
        delete idx.files[rel];
        try { fs.unlinkSync(this.baseFileOf(rel)); } catch (e) { /* ignore */ }
        continue;
      }
      const st = fs.statSync(abs);
      const hash = util.fileHash(abs);
      let stored = false;
      if (hash !== null && st.size <= maxBytes && util.isTextFile(abs)) {
        try {
          const dest = this.baseFileOf(rel);
          util.ensureDir(path.dirname(dest));
          fs.copyFileSync(abs, dest);
          stored = true;
        } catch (e) {
          stored = false;
        }
      }
      idx.files[rel] = { size: st.size, mtimeMs: Math.floor(st.mtimeMs), hash, stored, lines: 0 };
    }
    idx.updatedAt = Date.now();
    this.index = idx;
    this.saveIndex();
    return { fileCount: list.length };
  }

  baseContent(file) {
    const idx = this.loadIndex();
    const rec = idx && idx.files[file.relPath];
    if (!rec || !rec.stored) { return null; }
    try {
      return fs.readFileSync(this.baseFileOf(file.relPath), 'utf8');
    } catch (e) {
      return null;
    }
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
    const idx = this.loadIndex();
    if (!idx) { return []; }
    const { files } = this.scan();
    const now = new Map();
    for (const f of files) { now.set(f.relPath, f); }

    const changed = [];
    const candidates = [];

    for (const [rel, rec] of Object.entries(idx.files)) {
      const cur = now.get(rel);
      if (!cur) {
        changed.push(this.makeFile(rel, 'deleted'));
        continue;
      }
      const sameStamp = Math.floor(cur.mtimeMs) === rec.mtimeMs && cur.size === rec.size;
      if (sameStamp) { continue; }
      candidates.push({ rel, cur, rec });
    }
    for (const [rel, cur] of now.entries()) {
      if (!idx.files[rel]) { changed.push(this.makeFile(rel, 'untracked')); }
    }

    await util.mapLimit(candidates, 8, async (c) => {
      const hashNow = util.fileHash(c.cur.absPath);
      if (hashNow !== null && hashNow === c.rec.hash) {
        c.rec.mtimeMs = Math.floor(c.cur.mtimeMs); // 内容没变，只是时间戳变了
        return;
      }
      changed.push(this.makeFile(c.rel, 'modified'));
    });
    if (candidates.length) { this.saveIndex(); }

    // 运行时排除：设置项（按快照根）+ 项目忽略文件（按各自所在目录锚定），对所有 kind 生效
    const filtered = changed.filter((f) => (this.runtimeExclude.length && util.matchAny(f.relPath, this.runtimeExclude))
      ? false
      : !util.matchExcludeSets(f.absPath, this.excludeSets));

    const result = [];
    await util.mapLimit(filtered, 8, async (file) => {
      if (file.kind === 'untracked') {
        const cur = this.currentContent(file);
        file.added = util.countLinesOfText(cur);
        file.removed = 0;
      } else {
        const base = this.baseContent(file);
        const cur = file.kind === 'deleted' ? '' : this.currentContent(file);
        if (base === null) {
          // 基准内容没存（大文件/二进制）：只能给行数估算
          const baseLines = (this.loadIndex().files[file.relPath] || {}).lines || 0;
          const curLines = util.countLinesOfText(cur);
          file.added = Math.max(0, curLines - baseLines);
          file.removed = Math.max(0, baseLines - curLines);
          file.large = true;
        } else {
          const { added, removed } = countFromUnified(makeUnifiedDiff(base, cur, file.relPath, 3));
          file.added = added;
          file.removed = removed;
        }
      }
      result.push(file);
    });

    result.sort((a, b) => a.relPath.localeCompare(b.relPath));
    return result;
  }

  makeFile(relPath, kind) {
    const absPath = this.abs(relPath);
    return {
      relPath,
      absPath,
      status: kind === 'untracked' ? '?' : (kind === 'deleted' ? 'D' : 'M'),
      kind,
      added: 0,
      removed: 0,
      staged: false,
      provider: 'snapshot',
      hash: ''
    };
  }

  async getDiff(file, contextLines = 3) {
    const base = file.kind === 'untracked' ? '' : this.baseContent(file);
    if (base === null) {
      return `diff --git a/${file.relPath} b/${file.relPath}\n--- a/${file.relPath}\n+++ b/${file.relPath}\n`;
    }
    const current = file.kind === 'deleted' ? '' : this.currentContent(file);
    return makeUnifiedDiff(base, current, file.relPath, contextLines);
  }

  async getBaseContent(file) {
    const base = this.baseContent(file);
    return base === null ? '' : base;
  }

  async acceptFile() {
    return { staged: false, message: '已保留改动（如需把当前内容设为新基准，请用「更新对比基准」）' };
  }

  async rejectFile(file) {
    if (file.kind === 'untracked') {
      try {
        fs.unlinkSync(file.absPath);
      } catch (e) {
        throw new Error(`删除文件失败：${e.message}`);
      }
      return { message: '已删除新增文件' };
    }
    const base = this.baseContent(file);
    if (base === null) { throw new Error('该文件没有保存基准内容（可能超过大小限制或是二进制文件），无法还原'); }
    util.ensureDir(path.dirname(file.absPath));
    fs.writeFileSync(file.absPath, base);
    return { message: '已还原到基准快照' };
  }

  async acceptHunk() {
    return { staged: false, message: '该块仅标记为已接受（如需更新基准请用「更新对比基准」）' };
  }

  async rejectHunk(file, hunkIndex, contextLines = 3) {
    const diffText = await this.getDiff(file, contextLines);
    const parsed = parseDiff(diffText);
    if (!parsed.length || !parsed[0].hunks.length) { throw new Error('无法解析该文件的差异'); }
    const hunk = parsed[0].hunks[hunkIndex];
    if (!hunk) { throw new Error(`未找到第 ${hunkIndex + 1} 个改动块`); }
    const current = this.currentContent(file);
    const next = revertHunkInText(current, hunk);
    fs.writeFileSync(file.absPath, next);
    return { message: '该块已还原' };
  }

  /** 只还原一个块里的第 clusterIndex 段改动 */
  async rejectCluster(file, hunkIndex, clusterIndex, contextLines = 3) {
    const diffText = await this.getDiff(file, contextLines);
    const parsed = parseDiff(diffText);
    if (!parsed.length || !parsed[0].hunks.length) { throw new Error('无法解析该文件的差异'); }
    const hunk = parsed[0].hunks[hunkIndex];
    if (!hunk) { throw new Error(`未找到第 ${hunkIndex + 1} 个改动块`); }
    const cluster = clustersOf(hunk)[clusterIndex];
    if (!cluster) { throw new Error(`未找到第 ${clusterIndex + 1} 段改动`); }
    const current = this.currentContent(file);
    const next = revertHunkInText(current, hunkForCluster(cluster));
    fs.writeFileSync(file.absPath, next);
    return { message: '该段已还原' };
  }

  async describe() {
    const out = [];
    out.push('类型: 快照基准（无 git / svn）');
    out.push(`目录: ${this.root}`);
    out.push(`基准存放: ${this.dir}`);
    const info = this.baselineInfo();
    if (!info) {
      out.push('基准状态: 尚未初始化');
    } else {
      out.push(`基准状态: 已初始化，${info.fileCount} 个文件，更新于 ${new Date(info.updatedAt).toLocaleString()}`);
    }
    return out;
  }
}

/** 无任何版本控制时兜底 */
function detect(folder) {
  return { root: folder };
}

module.exports = { SnapshotProvider, detect, DEFAULT_EXCLUDE: util.DEFAULT_EXCLUDE };
