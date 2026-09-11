'use strict';

const KEY = 'changeReview.reviewed.v1';

class ReviewStore {
  constructor(workspaceState) {
    this.state = workspaceState;
    this.data = workspaceState.get(KEY) || {};
  }

  key(root, relPath) {
    return `${String(root).replace(/\\/g, '/')}::${relPath}`;
  }

  /** 只有当记录的 hash 与当前 hash 一致时才算已审查（文件又被改过就自动失效） */
  isReviewed(root, relPath, hash) {
    const rec = this.data[this.key(root, relPath)];
    return !!(rec && rec.hash === hash);
  }

  raw(root, relPath) {
    return this.data[this.key(root, relPath)];
  }

  setReviewed(root, relPath, hash) {
    this.data[this.key(root, relPath)] = { hash, at: Date.now() };
    return this.save();
  }

  clearReviewed(root, relPath) {
    delete this.data[this.key(root, relPath)];
    return this.save();
  }

  // ---- 手动「取消审查」后的自动标记抑制 ----
  // 用户手动取消审查，就是要自己接着操作（改内容、重新审），不能被自动标记立刻又打上钩。
  // 记录抑制时的文件指纹：文件内容一变（hash 变了）抑制自动失效，恢复到正常的「块都决定了就自动打钩」。
  autoMarkOffKey(root, relPath) {
    return `${this.key(root, relPath)}::autoMarkOff`;
  }

  isAutoMarkOff(root, relPath, hash) {
    const rec = this.data[this.autoMarkOffKey(root, relPath)];
    return !!(rec && rec.hash === hash);
  }

  setAutoMarkOff(root, relPath, hash) {
    this.data[this.autoMarkOffKey(root, relPath)] = { hash, at: Date.now() };
    return this.save();
  }

  clearAutoMarkOff(root, relPath) {
    delete this.data[this.autoMarkOffKey(root, relPath)];
    return this.save();
  }

  markAll(entries) {
    for (const e of entries) {
      const root = e.source ? e.source.root : e.repo.root;
      this.data[this.key(root, e.file.relPath)] = { hash: e.file.hash, at: Date.now() };
    }
    return this.save();
  }

  hunkKey(root, relPath) {
    return `${this.key(root, relPath)}::hunks`;
  }

  /** 某文件下所有“已接受”的块签名表 */
  getReviewedHunks(root, relPath) {
    return this.data[this.hunkKey(root, relPath)] || {};
  }

  isHunkReviewed(root, relPath, sig) {
    return !!this.getReviewedHunks(root, relPath)[sig];
  }

  setHunkReviewed(root, relPath, sig, value) {
    const k = this.hunkKey(root, relPath);
    const table = this.data[k] || {};
    if (value) { table[sig] = { at: Date.now() }; } else { delete table[sig]; }
    this.data[k] = table;
    return this.save();
  }

  // ---- 已拒绝块表：拒绝块只记录决定，不立即改文件；标记已审查时统一执行还原 ----
  rejectedKey(root, relPath) {
    return `${this.key(root, relPath)}::rejected`;
  }

  /** 某文件下所有“已拒绝（待执行）”的块签名表 */
  getRejectedHunks(root, relPath) {
    return this.data[this.rejectedKey(root, relPath)] || {};
  }

  setHunkRejected(root, relPath, sig, value) {
    const k = this.rejectedKey(root, relPath);
    const table = this.data[k] || {};
    if (value) { table[sig] = { at: Date.now() }; } else { delete table[sig]; }
    this.data[k] = table;
    return this.save();
  }

  clearRejectedHunks(root, relPath) {
    delete this.data[this.rejectedKey(root, relPath)];
    return this.save();
  }

  clearAll() {
    this.data = {};
    return this.save();
  }

  save() {
    return this.state.update(KEY, this.data);
  }
}

module.exports = { ReviewStore, KEY };
