'use strict';

const fs = require('fs');
const git = require('../gitService');
const platform = require('../platform');
const { parseDiff, clustersOf, hunkForCluster } = require('../diffParser');
const { revertHunkInText, makeUnifiedDiff, countFromUnified } = require('../diffEngine');
const util = require('./util');

/**
 * Git provider：以 HEAD（上次提交）为对比基准。
 * 块级“拒绝”走纯 JS 反向替换（不依赖 git apply，跨 Windows/WSL 行为一致）；
 * 块级“接受”走 git apply --cached，是 git 独有的真暂存。
 */
class GitProvider {
  constructor(root, options = {}) {
    this.id = 'git';
    this.label = 'Git';
    this.root = root;
    this.baseLabel = 'HEAD（上次提交）';
    this.scopes = new Set(); // 空 = 整个仓库；非空 = 只列这些打开目录内的改动
    // 手动排除（glob，相对仓库根），对所有 kind 生效；默认空
    this.exclude = Array.isArray(options && options.exclude) ? options.exclude : [];
    // 项目忽略文件（.crignore / .gitignore fallback）：按「各自规则文件所在目录」锚定（同 .gitignore 语义）
    this.excludeSets = Array.isArray(options && options.excludeSets) ? options.excludeSets : [];
    this.capabilities = {
      stage: false,       // 0.4.5：接受不再 git add；暂存只在「标记已审查」打勾时发生
      hunkStage: false,   // 块级接受也只标记，不再 git apply --cached
      hunkRevert: true,
      revertFile: true,
      baselineUpdate: false
    };
    this.diffCache = new Map(); // 文件内容没变时直接复用 diff，别每次操作都 spawn
  }

  addScope(dir) {
    if (dir) { this.scopes.add(dir); }
  }

  inScope(file) {
    if (!this.scopes.size) { return true; }
    for (const scope of this.scopes) {
      if (util.relInScope(file.relPath, this.root, scope)) { return true; }
    }
    return false;
  }

  inExclude(file) {
    if (this.exclude.length && util.matchAny(file.relPath, this.exclude)) { return true; }
    return util.matchExcludeSets(file.absPath, this.excludeSets);
  }

  async listChanges() {
    // scope 非空时，只对打开的目录跑 status（避免大仓库根全量扫描）
    const rels = [];
    for (const scope of this.scopes) {
      const rel = util.scopeRelOf(this.root, scope);
      if (rel) { rels.push(rel); }
    }
    const files = await git.getChanges(this.root, rels);
    return files
      .filter((f) => this.inScope(f) && !this.inExclude(f))
      .map((f) => Object.assign({}, f, { provider: 'git' }));
  }

  async getDiff(file, contextLines = 3) {
    // 缓存：key 里带文件 stat，内容变了自然失效，不会给用户看旧 diff
    const key = `${file.relPath}|${file.kind}|${contextLines}|${util.statInfoOf(file.absPath)}`;
    const hit = this.diffCache.get(key);
    if (hit !== undefined) { return hit; }
    let text;
    if (file.kind === 'untracked') {
      // 未跟踪文件：git diff 能出，但统一用 JS 生成，块级操作与内容严格一致
      const current = this.safeRead(file.absPath);
      text = makeUnifiedDiff('', current, file.relPath, contextLines);
    } else {
      text = await git.getDiff(this.root, file, contextLines);
    }
    if (this.diffCache.size >= 80) { this.diffCache.clear(); }
    this.diffCache.set(key, text);
    return text;
  }

  /**
   * 只复查一个文件当前是否还有改动（拒绝/还原后工作区通常只变这一个文件）。
   * @returns {Promise<object|null>} 还改动则返回新 entry；已与基准一致 / 被排除则返回 null。
   */
  async recheckFile(file) {
    const rel = platform.toGitPath(file.relPath);
    const rels = rel ? [rel] : [];
    const list = await git.getChanges(this.root, rels);
    const hit = list.find((f) => platform.toGitPath(f.relPath) === rel);
    if (hit && (!this.inScope(hit) || this.inExclude(hit))) { return null; }
    return hit ? Object.assign({}, hit, { provider: 'git' }) : null;
  }

  async getBaseContent(file) {
    return git.getHeadContent(this.root, file);
  }

  /** git add（把文件加入暂存区）——只在「标记已审查」勾选时调用（0.4.5 语义） */
  async stageFile(file) {
    await git.acceptFile(this.root, file);
    return { staged: true, message: '已 git add' };
  }

  /** git reset -- path（把文件撤出暂存区，不动工作区内容）——「取消已审查」时调用 */
  async unstageFile(file) {
    const rel = platform.toGitPath(file.relPath);
    await git.runResetPath(this.root, rel);
    return { staged: false, message: '已撤出暂存区' };
  }

  /** 该文件当前是否在暂存区（git diff --cached 判断） */
  async isStaged(file) {
    return git.isStagedFile(this.root, platform.toGitPath(file.relPath));
  }

  async rejectFile(file) {
    await git.rejectFile(this.root, file);
    return { message: '已还原到 HEAD' };
  }

  /**
   * 接受此块（0.4.5 起 git 与 svn/快照一致）：只打上"已接受"标记，
   * 不 git apply --cached、不改工作区。暂存只发生在「标记已审查」打勾时。
   */
  async acceptHunk(file) {
    return { staged: false, message: '该块已标记为已接受（暂存发生在标记已审查时）' };
  }

  async rejectHunk(file, hunkIndex, contextLines = 3) {
    const diffText = await this.getDiff(file, contextLines);
    const parsed = parseDiff(diffText);
    if (!parsed.length) { throw new Error('无法解析该文件的差异'); }
    const hunk = parsed[0].hunks[hunkIndex];
    if (!hunk) { throw new Error(`未找到第 ${hunkIndex + 1} 个改动块`); }
    const current = this.safeRead(file.absPath);
    const next = revertHunkInText(current, hunk);
    fs.writeFileSync(file.absPath, next);
    return { message: '该块已还原' };
  }

  /** 只还原第 hunkIndex 个块里的第 clusterIndex 段连续改动（上面一处修改/下面一处删除可分别处理） */
  async rejectCluster(file, hunkIndex, clusterIndex, contextLines = 3) {
    const diffText = await this.getDiff(file, contextLines);
    const parsed = parseDiff(diffText);
    if (!parsed.length) { throw new Error('无法解析该文件的差异'); }
    const hunk = parsed[0].hunks[hunkIndex];
    if (!hunk) { throw new Error(`未找到第 ${hunkIndex + 1} 个改动块`); }
    const cluster = clustersOf(hunk)[clusterIndex];
    if (!cluster) { throw new Error(`未找到第 ${clusterIndex + 1} 段改动`); }
    const current = this.safeRead(file.absPath);
    const next = revertHunkInText(current, hunkForCluster(cluster));
    fs.writeFileSync(file.absPath, next);
    return { message: '该段已还原' };
  }

  safeRead(absPath) {
    try {
      return fs.readFileSync(absPath, 'utf8');
    } catch (e) {
      return '';
    }
  }

  async hasHead() {
    return git.headExists(this.root);
  }

  async describe() {
    const out = [];
    out.push(`类型: Git`);
    out.push(`仓库根: ${this.root}`);
    try {
      const hasHead = await this.hasHead();
      out.push(`HEAD: ${hasHead ? '存在' : '不存在（还没有提交）'}`);
    } catch (e) {
      out.push(`HEAD 检查失败: ${e.message}`);
    }
    return out;
  }
}

/** 探测：git 优先用 rev-parse（能直接给出仓库根），失败再向上找 .git */
async function detect(folder, maxDepth = 5) {
  try {
    const top = await git.topLevel(folder);
    if (top) { return { root: top }; }
  } catch (e) {
    if (e && (e.noGit || e.dubiousRoot)) { throw e; }
  }
  const found = util.findUp(folder, '.git', maxDepth);
  if (found) { return { root: found }; }
  return null;
}

module.exports = { GitProvider, detect };
