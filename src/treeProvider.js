'use strict';

const vscode = require('vscode');

const KIND_ICON = {
  modified: 'diff-modified',
  added: 'diff-added',
  deleted: 'diff-removed',
  renamed: 'diff-renamed',
  untracked: 'new-file',
  conflict: 'warning'
};

const KIND_LABEL = {
  modified: '修改',
  added: '新增',
  deleted: '删除',
  renamed: '重命名',
  untracked: '未跟踪',
  conflict: '冲突'
};

const VCS_ICON = {
  git: 'git-branch',
  svn: 'cloud-upload',
  snapshot: 'database'
};

function dirOf(relPath) {
  const idx = relPath.lastIndexOf('/');
  return idx === -1 ? '' : relPath.slice(0, idx);
}

function baseOf(relPath) {
  const idx = relPath.lastIndexOf('/');
  return idx === -1 ? relPath : relPath.slice(idx + 1);
}

class FileNode extends vscode.TreeItem {
  constructor(repo, file) {
    super(baseOf(file.relPath), vscode.TreeItemCollapsibleState.None);
    this.repo = repo;
    this.file = file;
    this.id = `${repo.id || 'src'}::${repo.root}::${file.relPath}`;
    this.resourceUri = vscode.Uri.file(file.absPath);
    const dir = dirOf(file.relPath);
    const stat = `+${file.added} −${file.removed}`;
    // ▶ 标记当前正在审查的文件（放 description 里，不破坏 label 匹配）
    const active = repo.activeFile
      && repo.activeFile.root === repo.root
      && repo.activeFile.relPath === file.relPath;
    this.description = (dir ? `${dir}  ${stat}` : stat) + (active ? '  ◀ 审查中' : '');
    this.checkboxState = file.reviewed
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
    this.contextValue = file.reviewed ? 'changeReviewFileDone' : 'changeReviewFile';
    this.iconPath = new vscode.ThemeIcon(KIND_ICON[file.kind] || 'diff-modified');
    const base = repo.baseLabel || (repo.label || '') + ' 基准';
    this.tooltip = new vscode.MarkdownString(
      `**${file.relPath}**\n\n` +
      `- 状态：${KIND_LABEL[file.kind] || file.kind}${file.staged ? '（已暂存）' : ''}\n` +
      `- 新增 ${file.added} 行，删除 ${file.removed} 行\n` +
      `- 对比基准：${base}（${repo.label}）\n` +
      `- ${file.reviewed ? '已审查' : '待审查'}\n\n` +
      `点击文件名进入审查模式`
    );
    this.command = {
      command: 'changeReview.openReview',
      title: '进入审查模式',
      arguments: [{ repoRoot: repo.root, relPath: file.relPath }]
    };
  }
}

class RepoNode extends vscode.TreeItem {
  constructor(repo) {
    const done = repo.files.filter((f) => f.reviewed).length;
    super(repo.name, vscode.TreeItemCollapsibleState.Expanded);
    this.repo = repo;
    this.id = `repo::${repo.id || 'src'}::${repo.root}`;
    this.contextValue = `changeReviewRepo_${repo.id || 'src'}`;
    this.description = `${repo.label} · ${done}/${repo.files.length}`;
    this.iconPath = new vscode.ThemeIcon(VCS_ICON[repo.id] || 'repo');
    const base = repo.baseLabel || '';
    let tip = `**${repo.root}**\n\n来源：${repo.label}\n对比基准：${base}\n已审查 ${done}/${repo.files.length} 个文件`;
    if (repo.needBaseline) {
      tip += '\n\n⚠ 尚未建立对比基准，请执行「Change Review: 初始化对比基准」';
    }
    if (repo.error) {
      tip += `\n\n⚠ 读取失败：${repo.error}`;
    }
    this.tooltip = new vscode.MarkdownString(tip);
  }
}

class ChangesTreeProvider {
  constructor(getConfig) {
    this.getConfig = getConfig || (() => ({}));
    this.model = { sources: [] };
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    // 每次 getChildren 时记录「root::relPath → 节点实例」，
    // 供扩展侧在「下一个待审查」时 treeView.reveal 高亮定位（bug 9）。
    // 必须存 VSCode 自己 getChildren 拿到的同一批实例，reveal 才认。
    this.nodeMap = new Map();
  }

  setModel(model) {
    this.model = model;
    this._onDidChangeTreeData.fire();
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(node) {
    return node;
  }

  filesOf(repo) {
    const cfg = this.getConfig();
    let files = repo.files.slice();
    if (cfg.get('sortReviewedLast', true) !== false) {
      files.sort((a, b) => {
        if (a.reviewed !== b.reviewed) { return a.reviewed ? 1 : -1; }
        return a.relPath.localeCompare(b.relPath);
      });
    } else {
      files.sort((a, b) => a.relPath.localeCompare(b.relPath));
    }
    return files.map((f) => {
      const node = new FileNode(repo, f);
      this.nodeMap.set(`${repo.root}::${f.relPath}`, node);
      return node;
    });
  }

  /** 找当前树里渲染着的节点实例（找不到返回 null；刷新后由 getChildren 重建） */
  findNode(repoRoot, relPath) {
    return this.nodeMap.get(`${repoRoot}::${relPath}`) || null;
  }

  getChildren(node) {
    const repos = (this.model.sources || []).filter((r) => r.files.length > 0 || r.needBaseline || r.error);
    if (!node) {
      if (repos.length === 0) { return []; }
      if (repos.length === 1) { return this.filesOf(repos[0]); }
      return repos.map((r) => new RepoNode(r));
    }
    if (node instanceof RepoNode) { return this.filesOf(node.repo); }
    return [];
  }
}

module.exports = { ChangesTreeProvider, FileNode, RepoNode, KIND_LABEL, KIND_ICON, VCS_ICON };
