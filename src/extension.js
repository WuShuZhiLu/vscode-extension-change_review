'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const vcs = require('./vcs');
const platform = require('./platform');
const { ReviewStore } = require('./reviewStore');
const { ChangesTreeProvider, FileNode, RepoNode } = require('./treeProvider');
const { ReviewPanel } = require('./reviewPanel');
const { parseDiff, hunkSignature } = require('./diffParser');
const util = require('./vcs/util');

let outputChannel;
let store;
let provider;
let treeView;
let statusBar;
let panel;
let timer = null;
let refreshTimer = null;
let refreshing = false;
let safeDirPrompting = false;
let storageDir = '';

// 性能：探测结果缓存。同一份「文件夹 + 版本控制配置」下不再重复 spawn rev-parse 探测；
// 配置/工作区目录变化或用户手动点刷新时 forceRedetect=true 强制重建。
let forceRedetect = true;
let cachedProviders = null;
let lastBuildKey = '';

const model = { sources: [], flat: [] };

function buildProvidersKey(folders, opt) {
  return JSON.stringify({
    f: folders.map((p) => platform.normalizeForCompare(p)),
    forceVcs: opt.forceVcs,
    depth: opt.searchDepth,
    exclude: opt.exclude || [],
    allow: !!opt.allowSnapshot,
    storage: opt.storageDir,
    snapExcl: (opt.snapshotOptions && opt.snapshotOptions.exclude) || null,
    maxKB: opt.snapshotOptions && opt.snapshotOptions.maxFileSizeKB,
    maxF: opt.snapshotOptions && opt.snapshotOptions.maxFiles
  });
}

function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  if (outputChannel) { outputChannel.appendLine(line); }
  console.log(`[Change Review] ${msg}`); // 同步写 console，Developer Tools 里也能看到
  // 同时落盘：globalStorage/change-review.log，终端里可直接 cat/tail，
  // Output 面板找不到时（Linux 远程等场景）日志也不会丢
  if (storageDir) {
    try {
      const lf = path.join(storageDir, 'change-review.log');
      const fsMod = require('fs');
      try {
        const st = fsMod.statSync(lf);
        if (st.size > 1024 * 1024) { fsMod.writeFileSync(lf, ''); } // 超 1MB 直接截断重来
      } catch (_) { /* 文件还不存在 */ }
      fsMod.appendFileSync(lf, line + '\n');
    } catch (e) { /* 日志落盘失败不影响主流程 */ }
  }
}

/** 错误 = 弹窗 + 写日志 + 自动打开输出面板（绝不静默，用户不用自己去翻 Output 下拉框） */
function showErr(msg) {
  log(`[error] ${msg}`);
  if (outputChannel) { outputChannel.show(true); }
  vscode.window.showErrorMessage(msg);
}

function cfg() {
  return vscode.workspace.getConfiguration('changeReview');
}

/**
 * 读取某个工作区目录下的 .crignore（gitignore 风格：每行一个 glob，# 注释，空行忽略）。
 * 这是「配置排除规则」命令实际编辑的文件，也是项目级的排除规则来源（不写进插件设置）。
 */
function readProjectIgnore(folderFsPath) {
  const igPath = path.join(folderFsPath, '.crignore');
  if (!fs.existsSync(igPath)) { return []; }
  try {
    const lines = fs.readFileSync(igPath, 'utf8').split(/\r?\n/);
    const globs = [];
    for (const raw of lines) {
      const line = String(raw).trim();
      if (!line || line.startsWith('#')) { continue; }
      globs.push(line);
    }
    return globs;
  } catch (e) {
    log(`读取 .crignore 失败 ${igPath}: ${e.message}`);
    return [];
  }
}

/** 汇总所有工作区目录的 .crignore 规则 */
function projectIgnoreGlobs() {
  const folders = vscode.workspace.workspaceFolders || [];
  const all = [];
  for (const f of folders) {
    all.push(...readProjectIgnore(f.uri.fsPath));
  }
  return all;
}

// 默认内容：一行说明即可，中英文对照；规则语法同 .gitignore
const IGNORE_TEMPLATE = '# 排除规则，语法同 .gitignore / Exclude rules, same syntax as .gitignore\n';

function vcsOptions() {
  // 排除规则 = 手动设置 changeReview.exclude + 项目 .crignore 文件 + 规则文件自身（始终隐藏）
  const exclude = [
    ...cfg().get('exclude', []),
    ...projectIgnoreGlobs(),
    '.crignore',
    '**/.crignore'
  ].filter((x) => typeof x === 'string' && x.length > 0);
  return {
    forceVcs: cfg().get('forceVcs', 'auto'),
    searchDepth: cfg().get('vcsSearchDepth', 5),
    exclude,
    storageDir: storageDir || path.join(os.tmpdir(), 'change-review'),
    allowSnapshot: true,
    snapshotOptions: {
      exclude: cfg().get('snapshotExclude', null),
      maxFileSizeKB: cfg().get('snapshotMaxFileSize', 1024),
      maxFiles: cfg().get('snapshotMaxFiles', 10000)
    }
  };
}

function syncToolPaths() {
  vcs.setPaths({ gitPath: cfg().get('gitPath', ''), svnPath: cfg().get('svnPath', '') });
}

function norm(p) {
  return platform.normalizeForCompare(p);
}

function findEntry(root, relPath) {
  const r = norm(root);
  return model.flat.find((e) => norm(e.source.root) === r && platform.toGitPath(e.file.relPath) === platform.toGitPath(relPath)) || null;
}

function entryForActiveEditor() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !editor.document) { return null; }
  const p = editor.document.uri.fsPath;
  for (const e of model.flat) {
    if (platform.samePath(e.file.absPath, p)) { return e; }
  }
  return null;
}

/** 从参数/选中项/当前编辑器/面板里确定一个「来源」（仓库或快照基准） */
function resolveSource(arg) {
  if (arg && arg.provider) { return arg; }
  if (arg && arg.root) {
    return model.sources.find((s) => norm(s.root) === norm(arg.root)) || null;
  }
  const sel = treeView && treeView.selection && treeView.selection[0];
  if (sel && sel.repo) { return sel.repo; }
  if (sel && sel.source) { return sel.source; }
  if (panel && panel.entry && panel.panel && panel.panel.visible) { return panel.entry.source; }
  return model.sources.length === 1 ? model.sources[0] : null;
}

/**
 * 解析命令目标文件。优先级：显式参数 → 树当前选中 → 当前编辑器打开的文件 → 审查面板当前文件。
 * 取不到时给用户明确提示，绝不静默什么都不做。
 */
function resolveArg(arg, silent = false) {
  let entry = null;
  if (arg && arg.repoRoot && arg.relPath) {
    entry = findEntry(arg.repoRoot, arg.relPath);
  } else if (arg && arg.source && arg.file) {
    entry = arg;
  } else if (arg instanceof FileNode) {
    entry = { source: arg.repo, file: arg.file };
  }
  if (!entry) {
    const sel = treeView && treeView.selection && treeView.selection[0];
    if (sel && sel.file) { entry = { source: sel.repo || sel.source, file: sel.file }; }
  }
  if (!entry) { entry = entryForActiveEditor(); }
  if (!entry && panel && panel.entry && panel.panel && panel.panel.visible) { entry = panel.entry; }
  if (!entry && !silent) {
    vscode.window.showWarningMessage(
      'Change Review：没有找到目标文件。请在改动列表里选中一个文件，或先打开该文件，再执行命令。'
    );
  }
  return entry;
}

/**
 * 标记/取消「已审查」。
 * opts.stageGit=true 时（勾选/取消勾选这种显式的"标记为已审查"动作）会顺带操作 git 暂存区：
 *   勾选 → git add（加入暂存区）；取消 → git reset（撤出暂存区）。
 * 接受(全部/此块) 与「全部标记」走的都是普通标记（stageGit 不传），
 * 一律不碰暂存区——用户语义：接受/拒绝只对文件层面判断，暂存只在显式打勾时发生。
 */
async function setReviewed(entry, value, opts) {
  if (!entry) { return; }
  const root = entry.source.root;
  const provider = entry.source.provider;
  const stageGit = !!(opts && opts.stageGit) && provider && provider.id === 'git';
  let appliedRejects = 0;
  if (value) {
    // 标记为已审查前，先执行该文件所有待执行的拒绝块；失败则不标记，保持状态一致
    const r = await applyPendingRejects(entry);
    if (r === -1) { return; }
    appliedRejects = r;
  }
  if (stageGit) {
    try {
      if (value) {
        await provider.stageFile(entry.file);
        log(`标记已审查 → 已 git add：${entry.file.relPath}`);
      } else if (value === false && (entry.file.staged || await provider.isStaged(entry.file))) {
        // 只有文件确实在暂存区才 reset，避免把用户用其它方式暂存的文件误撤出来
        await provider.unstageFile(entry.file);
        log(`取消已审查 → 已 git reset：${entry.file.relPath}`);
      }
    } catch (e) {
      const msg = `${value ? '加入' : '撤出'}暂存区失败：${e.message}`;
      log(msg);
      showErr(msg);
      return; // 暂存区没动成就不标记，避免勾选状态与 git 状态不一致
    }
  }
  if (value) {
    // 拒绝块执行过还原 → 文件内容已变，旧 hash 会立刻失配导致"标记又丢了"；
    // 用还原后的新 hash 记录，保证"部分拒绝部分接受"的文件标记稳定
    const hash = appliedRejects > 0 ? await freshFileHash(entry) : entry.file.hash;
    await store.setReviewed(root, entry.file.relPath, hash);
  } else {
    await store.clearReviewed(root, entry.file.relPath);
  }
  entry.file.reviewed = value;
}

/** 用文件当前实际状态重算指纹（拒绝块还原后内容已变，原 hash 失效） */
async function freshFileHash(entry) {
  try {
    const t = await entry.source.provider.getDiff(entry.file, cfg().get('contextLines', 3));
    const parsed = parseDiff(t)[0];
    const hunks = parsed ? parsed.hunks : [];
    const added = hunks.reduce((s, h) => s + h.added, 0);
    const removed = hunks.reduce((s, h) => s + h.removed, 0);
    return util.fileHashOf({ relPath: entry.file.relPath, kind: entry.file.kind, added, removed, absPath: entry.file.absPath });
  } catch (e) {
    log(`重算文件指纹失败（${entry.file.relPath}）：${e.message}`);
    return entry.file.hash;
  }
}

async function offerSafeDirectory(root) {
  if (safeDirPrompting) { return; }
  safeDirPrompting = true;
  try {
    const pick = await vscode.window.showWarningMessage(
      `git 拒绝访问仓库（dubious ownership）：${root}\n` +
      '通常是因为仓库目录的所有者与当前用户不一致（WSL 挂载 Windows 目录时很常见）。',
      '信任该仓库',
      '信任全部仓库'
    );
    if (pick === '信任该仓库') {
      await require('./gitService').addSafeDirectory(root, false);
      vscode.window.showInformationMessage(`已把 ${root} 加入 git safe.directory`);
    } else if (pick === '信任全部仓库') {
      await require('./gitService').addSafeDirectory(null, true);
      vscode.window.showInformationMessage('已设置 safe.directory = *');
    } else {
      return;
    }
    require('./gitService').resetGit();
    await doRefresh(true);
  } catch (e) {
    vscode.window.showErrorMessage(`设置 safe.directory 失败：${e.message}`);
  } finally {
    safeDirPrompting = false;
  }
}

/** 全量刷新改动列表。force=true 时强制重新探测版本控制（手动刷新/配置变化时用）。 */
async function doRefresh(force) {
  if (refreshing) { return; }
  refreshing = true;
  const reuseCache = !force && !forceRedetect;
  forceRedetect = false;
  try {
    syncToolPaths();
    const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
    const includeUntracked = cfg().get('includeUntracked', true);

    let providers = [];
    let problems = [];
    let detectionFailures = [];
    const opt = vcsOptions();
    const key = buildProvidersKey(folders, opt);
    if (reuseCache && cachedProviders && key === lastBuildKey) {
      providers = cachedProviders; // 复用探测结果，只重新 listChanges
    } else {
      try {
        const built = await vcs.buildProviders(folders, opt);
        providers = built.providers;
        problems = built.problems;
        detectionFailures = built.failures || [];
      } catch (e) {
        if (e && e.dubiousRoot) {
          await offerSafeDirectory(e.dubiousRoot);
        } else if (e && e.noGit) {
          // 探测期就失败：把原因放到面板 + 状态栏，但只展示一次，不刷屏
          const msg = `未找到可用的 git 可执行文件（${platform.IS_WIN ? 'Windows' : (platform.IS_MAC ? 'macOS' : 'Linux/WSL')}）。请在 VSCode 设置里把 changeReview.gitPath 填成 git 的完整路径。`;
          log(`git 不可用：${e.message}`);
          vscode.window.showWarningMessage(`Change Review：${msg}`, '我知道了');
          detectionFailures.push({ kind: 'git-missing', message: msg });
        } else {
          log(`探测版本控制失败：${e.message}`);
          vscode.window.showErrorMessage(`Change Review 探测版本控制失败：${e.message}`);
          detectionFailures.push({ kind: 'detect-error', message: e.message });
        }
      }
      cachedProviders = providers;
      lastBuildKey = key;
    }
    for (const p of problems) { log(`探测提示：${p}`); }

    const sources = [];
    for (const p of providers) {
      let files = [];
      let error = null;
      try {
        files = await p.listChanges();
      } catch (e) {
        error = e;
        log(`读取改动失败 ${p.root}（${p.id}）：${e.message}`);
        if (e && e.dubiousRoot) { await offerSafeDirectory(e.dubiousRoot); }
      }
      if (!includeUntracked) {
        files = files.filter((f) => f.kind !== 'untracked');
      }
      for (const f of files) {
        f.hash = util.fileHashOf(f);
        f.reviewed = store.isReviewed(p.root, f.relPath, f.hash);
      }
      sources.push({
        provider: p,
        id: p.id,
        root: p.root,
        name: path.basename(p.root) || p.root,
        label: p.label,
        baseLabel: p.baseLabel,
        files,
        error: error ? error.message : null,
        needBaseline: p.id === 'snapshot' && !p.hasBaseline(),
        baselineInfo: p.id === 'snapshot' ? p.baselineInfo() : null
      });
    }

    model.sources = sources;
    model.flat = [];
    for (const s of sources) {
      for (const f of s.files) { model.flat.push({ source: s, file: f }); }
    }
    model.detectionFailures = detectionFailures;
    log(`刷新完成：${sources.map((s) => `${s.label}(${s.root}) ${s.files.length} 项${s.error ? ' ❌' + s.error : ''}`).join(' | ') || '无'}`);
    vscode.commands.executeCommand('setContext', 'changeReview.hasBaseline', !model.sources.some((s) => s.needBaseline));
    const hasSnapshot = model.sources.some((s) => s.provider && s.provider.id === 'snapshot');
    vscode.commands.executeCommand(
      'setContext',
      'changeReview.snapshotActive',
      hasSnapshot && !model.sources.some((s) => s.needBaseline)
    );
    provider.setModel(model);
    updateBadges();
    if (pendingReveal) { retryPendingReveal().catch(() => {}); } // #4：刷新后补一次高亮跟随
    if (panel && panel.entry) { await refreshPanelIfChanged(); }
  } catch (e) {
    log(`刷新异常：${e.stack || e.message}`);
  } finally {
    refreshing = false;
  }
}

/** 全量刷新后，当前面板文件内容没变就不重渲染（省一次 diff 计算） */
async function refreshPanelIfChanged() {
  if (!panel.panel) { return; }
  const old = panel.entry;
  const fresh = findEntry(old.source.root, old.file.relPath);
  if (!fresh) {
    panel.entry = null;
    panel.panel.webview.html = '<html><body style="font-family:var(--vscode-font-family);padding:20px">该文件已没有与对比基准的差异。</body></html>';
    return;
  }
  const changed = !old.file.hash || !fresh.file.hash || old.file.hash !== fresh.file.hash;
  panel.entry = fresh;
  if (changed) { await panel.render(); }
}

function scheduleRefresh(delay = 250) {
  if (refreshTimer) { clearTimeout(refreshTimer); }
  refreshTimer = setTimeout(() => { refreshTimer = null; doRefresh(false); }, delay);
}

/** 判断 abs 是否位于 root 之内（或等于 root） */
function isUnderRoot(root, abs) {
  const rel = path.relative(root, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 文件被保存后只复查该文件（而不是整表重扫）：
 * 大仓库里 Ctrl+S 之后等 400ms 再整仓 status+numstat 是卡顿的主要来源之一。
 */
function scheduleFileRefresh(doc) {
  if (!doc || doc.isUntitled || !doc.uri || doc.uri.scheme !== 'file') { return; }
  const abs = doc.uri.fsPath;
  const src = model.sources.find((s) => isUnderRoot(s.root, abs));
  if (!src || !src.provider || typeof src.provider.recheckFile !== 'function') {
    scheduleRefresh(400);
    return;
  }
  const rel = path.relative(src.root, abs);
  const file = {
    relPath: platform.toGitPath(rel),
    absPath: abs,
    kind: 'modified',
    added: 0,
    removed: 0
  };
  if (refreshTimer) { clearTimeout(refreshTimer); }
  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    await refreshSingleEntry({ source: src, file });
  }, 400);
}

function updateBadges() {
  const total = model.flat.length;
  const done = model.flat.filter((e) => e.file.reviewed).length;
  const pending = total - done;

  treeView.badge = pending > 0
    ? { value: pending, tooltip: `${pending} 个文件待审查（共 ${total} 项改动）` }
    : undefined;

  const needBaseline = model.sources.filter((s) => s.needBaseline);
  const kinds = Array.from(new Set(model.sources.map((s) => s.label))).join('/');
  const failures = model.detectionFailures || [];

  if (failures.length) {
    // 把探测失败一次性展示在面板顶部（不会反复弹窗）
    const msg = failures[0].message;
    treeView.message = `⚠ ${msg}`;
  } else if (needBaseline.length && model.sources.length === 1 && needBaseline.length === 1) {
    treeView.message = '此项目没有 git / svn，请点击「初始化对比基准」建立审查基准';
  } else if (total === 0 && kinds) {
    treeView.message = `没有检测到与${kinds}基准不同的文件`;
  } else if (total === 0 && !kinds) {
    treeView.message = '没有可识别的来源（既不是 git / svn 仓库，也不是可建立快照的项目）';
  } else if (pending === 0) {
    treeView.message = `全部 ${total} 个文件已审查 ✓`;
  } else {
    treeView.message = undefined;
  }

  if (!cfg().get('showStatusBar', true)) {
    statusBar.hide();
    return;
  }
  statusBar.text = total === 0
    ? (failures.length ? `$(warning) ${kinds || '未识别到来源'}` : '$(check) 无本地改动')
    : (pending === 0 ? `$(check-all) ${total} 个文件已审查` : `$(checklist) ${done}/${total} 已审查`);
  const srcLine = kinds ? `（${kinds}）` : '（未识别到来源）';
  statusBar.tooltip = failures.length
    ? `Change Review 探测失败：${failures[0].message}\n点此打开设置修改 git/svn 路径。`
    : `Change Review${srcLine}：共 ${total} 个文件与基准不同，${done} 个已审查。点击聚焦改动列表。`;
  statusBar.show();
}

function openBaseDiff(entry, line) {
  const left = vscode.Uri.from({
    scheme: 'change-review-base',
    path: '/' + platform.toGitPath(entry.file.relPath),
    query: 'root=' + encodeURIComponent(entry.source.root)
  });
  const right = vscode.Uri.file(entry.file.absPath);
  const title = `${path.basename(entry.file.relPath)}（${entry.source.baseLabel} ↔ 工作区）`;
  return vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: false })
    .then(() => {
      if (typeof line === 'number' && line > 0) {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          const pos = new vscode.Position(Math.max(0, line - 1), 0);
          editor.selection = new vscode.Selection(pos, pos);
          editor.revealRange(new vscode.Range(pos, pos));
        }
      }
    });
}

/**
 * 跳转：打开「真实的」工作区文件并把光标直接落到改动行。
 * 关键点：不能先 showTextDocument 再手动定位——那样会先停在首行再跳，观感很慢。
 * 这里已打开的编辑器直接设选区；未打开的则带 selection 一次性打开到该行。
 */
async function openFileForEdit(entry, line) {
  const abs = entry.file.absPath;
  try {
    if (!fs.existsSync(abs)) {
      vscode.window.showInformationMessage('该文件当前不存在（可能已被删除），无法直接编辑。');
      return;
    }
  } catch (e) {
    return;
  }
  const lineNo = (typeof line === 'number' && line > 0) ? line : 1;
  const target = new vscode.Position(Math.max(0, lineNo - 1), 0);
  const range = new vscode.Range(target, target);
  try {
    const uri = vscode.Uri.file(abs);
    const want = uri.fsPath;
    const existing = vscode.window.visibleTextEditors.find(
      (ed) => ed.document && ed.document.uri && ed.document.uri.fsPath === want
    );
    if (existing) {
      // 已经打开：直接定位，不重新打开，也就不会先停在首行
      existing.selection = new vscode.Selection(target, target);
      existing.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      await vscode.window.showTextDocument(existing.document, { viewColumn: existing.viewColumn, preview: false });
      return;
    }
    // 未打开：带 selection 打开，一步到位落在该行
    await vscode.window.showTextDocument(uri, { preview: false, selection: range });
    vscode.window.setStatusBarMessage(`已打开 ${entry.file.relPath}:${lineNo}`, 3000);
  } catch (e) {
    const msg = `打开 ${entry.file.relPath} 失败：${e.message}`;
    log(msg);
    showErr(msg);
  }
}

/**
 * 在对比块里直接改某一行：按「新文件行号」把该行写回文件，然后刷新 diff 与改动列表。
 * 这是用户要的「编辑 = 在对比块里就地改、同步到内容」，而不是跳到文件里改。
 * insertBelow=true 时（按 Enter / 点「+行」）顺便在该行下面插一个空行，并把焦点落到新行。
 */
async function editLineInFile(entry, lineNo, text, insertBelow, focusLine) {
  const abs = entry.file.absPath;
  if (!abs || !fs.existsSync(abs)) {
    vscode.window.showWarningMessage('该文件当前不存在（可能已被删除），无法写入修改。');
    return;
  }
  if (typeof text !== 'string') { return; }
  try {
    const content = fs.readFileSync(abs, 'utf8');
    const lines = content.split('\n');
    const idx = Number(lineNo) - 1;
    if (!(idx >= 0 && idx < lines.length)) {
      vscode.window.showWarningMessage(`行号 ${lineNo} 超出文件范围（共 ${lines.length} 行），未写入。`);
      return;
    }
    let changed = false;
    if (lines[idx] !== text) { lines[idx] = text; changed = true; }
    if (insertBelow) { lines.splice(idx + 1, 0, ''); }
    if (!changed && !insertBelow) { return; }
    fs.writeFileSync(abs, lines.join('\n'), 'utf8');
    log(`[审查面板] 已写回 ${entry.file.relPath}:${lineNo}${insertBelow ? ' 并插入新行' : ''}`);
    vscode.window.setStatusBarMessage(`已写回 ${entry.file.relPath}:${lineNo}`, 2000);
    await doRefresh(false);
    if (panel && panel.entry && sameEntry(panel.entry, entry)) {
      // Ctrl+S / Enter 插入行 都会把光标焦点带回去（避免保存后焦点丢到页面顶上）
      const targetFocus = focusLine ? Number(focusLine)
        : (insertBelow ? idx + 2 : undefined);
      await panel.reload(targetFocus ? { focusLine: targetFocus } : undefined);
    }
  } catch (e) {
    const msg = `写回第 ${lineNo} 行失败：${e.message}`;
    log(msg);
    showErr(msg);
  }
}

/** 在第 lineNo 行下面插入一个空行（对比块里的「+行」） */
async function insertLineInFile(entry, lineNo) {
  const abs = entry.file.absPath;
  if (!abs || !fs.existsSync(abs)) { return; }
  try {
    const lines = fs.readFileSync(abs, 'utf8').split('\n');
    const idx = Number(lineNo); // 插到该行之后（0 基 = lineNo）
    if (!(idx >= 0 && idx <= lines.length)) {
      vscode.window.showWarningMessage(`行号 ${lineNo} 超出文件范围，未插入。`);
      return;
    }
    lines.splice(idx, 0, '');
    fs.writeFileSync(abs, lines.join('\n'), 'utf8');
    log(`[审查面板] 已在 ${entry.file.relPath}:${lineNo} 后插入空行`);
    await doRefresh(false);
    if (panel && panel.entry && sameEntry(panel.entry, entry)) {
      await panel.reload({ focusLine: idx + 1 });
    }
  } catch (e) {
    log(`插入行失败: ${e.message}`);
    vscode.window.showErrorMessage(`插入行失败：${e.message}`);
  }
}

/** 删除第 lineNo 行（对比块里的「删行」） */
/** 删除第 lineNo 行（对比块里的「删行」/ 键盘删行）。focusLine 为删完后要聚焦的行号（由面板在删前从 DOM 邻居算出） */
async function deleteLineInFile(entry, lineNo, focusLine) {
  const abs = entry.file.absPath;
  if (!abs || !fs.existsSync(abs)) { return; }
  try {
    const lines = fs.readFileSync(abs, 'utf8').split('\n');
    const idx = Number(lineNo) - 1;
    if (!(idx >= 0 && idx < lines.length)) {
      vscode.window.showWarningMessage(`行号 ${lineNo} 超出文件范围，未删除。`);
      return;
    }
    lines.splice(idx, 1);
    fs.writeFileSync(abs, lines.join('\n'), 'utf8');
    log(`[审查面板] 已删除 ${entry.file.relPath}:${lineNo}`);
    vscode.window.setStatusBarMessage(`已删除 ${entry.file.relPath}:${lineNo}`, 2000);
    await doRefresh(false);
    if (panel && panel.entry && sameEntry(panel.entry, entry)) {
      // 焦点落到「被删行上面的那一行」：diff 重算后行号会漂移，
      // 不能用删掉的行号硬指（可能指到补位行/对不上导致焦点乱跳）。
      // 删之前面板已把目标行号算好带过来；带不过来才退而取 lineNo-1。
      const target = Number(focusLine) > 0 ? Number(focusLine) : Math.max(1, Number(lineNo) - 1);
      await panel.reload({ focusLine: target });
    }
  } catch (e) {
    log(`删除行失败: ${e.message}`);
    vscode.window.showErrorMessage(`删除行失败：${e.message}`);
  }
}

/** 只还原某一块里的某一段改动（“上面一处修改没问题、下面一处删除要单独拒绝”的场景） */
async function clusterRestoreInFile(entry, hunkIndex, clusterIndex) {
  try {
    const res = await entry.source.provider.rejectCluster(entry.file, Number(hunkIndex), Number(clusterIndex), cfg().get('contextLines', 3));
    log(`已还原 ${entry.file.relPath} 第 ${Number(hunkIndex) + 1} 块的第 ${Number(clusterIndex) + 1} 段: ${res.message || ''}`);
    vscode.window.setStatusBarMessage(`已还原 ${entry.file.relPath} 该段改动`, 3000);
  } catch (e) {
    const msg = `还原该段失败：${e.message}`;
    log(msg);
    showErr(msg);
    return;
  }
  await doRefresh(false);
  if (panel && panel.entry && sameEntry(panel.entry, entry)) {
    await panel.reload({ focusLine: 1 }); // 行号整体漂移过，别硬指；回到顶部附近的第一个可编辑行
  }
}

/** 批量删除多个真实文件行（lines 为新文件 1 基行号） */
async function deleteLinesInFile(entry, lines) {
  const abs = entry.file.absPath;
  const arr = Array.isArray(lines) ? lines.map((n) => Number(n)).filter((n) => n > 0) : [];
  if (!abs || !fs.existsSync(abs) || !arr.length) { return; }
  try {
    const content = fs.readFileSync(abs, 'utf8');
    const fileLines = content.split('\n');
    const set = new Set(arr);
    const next = fileLines.filter((_, i) => !set.has(i + 1));
    if (next.length === fileLines.length) { return; }
    fs.writeFileSync(abs, next.join('\n'), 'utf8');
    log(`[审查面板] 已删除 ${entry.file.relPath} 的 ${arr.length} 行`);
    await doRefresh(false);
    if (panel && panel.entry && sameEntry(panel.entry, entry)) {
      const focus = Math.min(...arr);
      await panel.reload({ focusLine: Math.max(1, focus) });
    }
  } catch (e) {
    log(`批量删除行失败: ${e.message}`);
    vscode.window.showErrorMessage(`删除选中行失败：${e.message}`);
  }
}

/** 在第 line 行下面插入多行（text 按换行拆开；粘贴恢复删除内容也用这里） */
async function insertLinesBelowInFile(entry, line, text) {
  const abs = entry.file.absPath;
  if (!abs || !fs.existsSync(abs)) { return; }
  const insert = String(text == null ? '' : text).replace(/\r\n/g, '\n').split('\n');
  if (insert.length && insert[insert.length - 1] === '') { insert.pop(); } // 末尾换行不额外产生空行
  if (!insert.length) { return; }
  try {
    const fileLines = fs.readFileSync(abs, 'utf8').split('\n');
    const idx = Math.min(Math.max(0, Number(line)), fileLines.length); // 0 基位置 = line 1 基行之后
    fileLines.splice(idx, 0, ...insert);
    fs.writeFileSync(abs, fileLines.join('\n'), 'utf8');
    log(`[审查面板] 已在 ${entry.file.relPath}:${line} 后插入 ${insert.length} 行`);
    await doRefresh(false);
    if (panel && panel.entry && sameEntry(panel.entry, entry)) {
      await panel.reload({ focusLine: Number(line) + 1 });
    }
  } catch (e) {
    log(`插入多行失败: ${e.message}`);
    vscode.window.showErrorMessage(`插入失败：${e.message}`);
  }
}

/** 记录"应当高亮"的文件；若此刻树不可见/没渲染完，等可见或下次刷新后再补一次 reveal */
let pendingReveal = null;

/**
 * 把改动列表里的对应文件节点滚动到可见并高亮选中（bug 9 / 0.4.5 加固）。
 * 树刷新是异步的：节点实例要等 VSCode 重新拉取 getChildren 后才有。
 * 等不到就先强制树刷新一次再等，避免列表停在旧高亮、与面板实际文件不一致。
 */
async function revealInTree(entry, tries = 20) {
  if (!treeView || !provider) { return; }
  pendingReveal = { root: entry.source.root, relPath: entry.file.relPath }; // 兜底记录
  const wait = () => new Promise((r) => setTimeout(r, 60));
  for (let i = 0; i < tries; i += 1) {
    const node = provider.findNode(entry.source.root, entry.file.relPath);
    if (node) {
      try {
        await treeView.reveal(node, { select: true, focus: false, expand: true });
      } catch (e) { /* 树尚未渲染完时忽略，下一轮会再试 */ }
      return;
    }
    if (i === Math.floor(tries / 2)) { provider.refresh(); } // 中途强制刷新一次，让 getChildren 重建节点
    await wait();
  }
}

/** 按 pendingReveal 再试一次（树刚变成可见 / 刚刷新完时调用） */
async function retryPendingReveal(tries = 12) {
  if (!pendingReveal) { return; }
  const entry = findEntry(pendingReveal.root, pendingReveal.relPath);
  if (entry) { await revealInTree(entry, tries); }
}

/** 在树节点 label 上标记 ▶ 当前正在审查的文件（不依赖 reveal 的视觉高亮，肉眼直接可见） */
function setActiveFile(entry) {
  if (!entry || !entry.source) { return; }
  const af = { root: entry.source.root, relPath: entry.file.relPath };
  const src = entry.source;
  if (src.activeFile && src.activeFile.root === af.root && src.activeFile.relPath === af.relPath) { return; }
  src.activeFile = af;
  provider.refresh(); // 树重渲染，▶ 标记移到新文件上
}

async function nextUnreviewed(entry) {
  // 不加防重入锁：锁曾在异常路径卡死导致按钮"只有第一次生效"。
  // 每一步都写日志，出错弹窗 + 自动打开输出面板，绝不静默。
  try {
    log(`[next] 点击，当前文件=${entry ? entry.file.relPath : '(无)'}，总改动=${model.flat.length}`);
    await nextUnreviewedInner(entry);
  } catch (e) {
    const msg = `下一个待审查失败：${e.message}`;
    log(msg);
    outputChannel.show(true);
    showErr(msg);
  }
}

async function nextUnreviewedInner(entry) {
  if (!model.flat.length) {
    log('[next] 没有任何改动，提示后返回');
    vscode.window.showInformationMessage('当前没有待审查的改动');
    return;
  }
  let start = 0;
  if (entry) {
    const idx = model.flat.findIndex((e) => e.source.root === entry.source.root && e.file.relPath === entry.file.relPath);
    start = idx === -1 ? 0 : idx + 1;
  }
  for (let i = 0; i < model.flat.length; i += 1) {
    const e = model.flat[(start + i) % model.flat.length];
    if (!e.file.reviewed) {
      log(`[next] 跳到 ${e.file.relPath}`);
      setActiveFile(e); // ▶ 标记当前文件（树刷新可见）
      await revealInTree(e, 5);
      await panel.show(e);
      await revealInTree(e, 20);
      return;
    }
  }
  log('[next] 所有文件都已审查完毕');
  // 面板还停在旧文件上时，换成"全部完成"页，避免停留在过期内容
  if (panel && panel.panel) {
    const done = vscode.env.language && vscode.env.language.toLowerCase().startsWith('zh')
      ? '所有文件都已审查完毕 ✓' : 'All files reviewed ✓';
    panel.panel.webview.html = `<html><body style="font-family:var(--vscode-font-family,sans-serif);padding:40px;font-size:15px;opacity:.8">${done}</body></html>`;
    panel.entry = null;
  }
  vscode.window.showInformationMessage('所有文件都已审查完毕 ✓');
}

const handlers = {
  log: (msg) => log(msg),
  resolve: findEntry,
  getReviewedHunks: (root, relPath) => store.getReviewedHunks(root, relPath),
  getRejectedHunks: (root, relPath) => store.getRejectedHunks(root, relPath),
  refresh: async () => { await doRefresh(false); },
  accept: async (entry) => { await acceptFile(entry); },
  reject: async (entry) => { await rejectFile(entry); },
  revertHunk: async (entry, index) => { await rejectHunk(entry, index, null); },
  acceptHunk: async (entry, index, sig) => { await acceptHunk(entry, index, sig); },
  rejectHunk: async (entry, index, sig) => { await rejectHunk(entry, index, sig); },
  unrejectHunk: async (entry, index, sig) => { await unrejectHunk(entry, index, sig); },
  toggleReviewed: async (entry) => {
    // 面板里的「标记为已审查 / 取消」= git 暂存的显式入口：勾上 add、取消 reset
    const value = !entry.file.reviewed;
    await setReviewed(entry, value, { stageGit: true });
    await refreshSingleEntry(entry); // 拒绝块执行后文件可能已无差异 → 从列表移除
    provider.refresh();
    updateBadges();
    const stillListed = value ? findEntry(entry.source.root, entry.file.relPath) : true;
    if (value && !stillListed) {
      // 标记后文件已无差异（拒绝块已执行还原）→ 自动跳下一个待审查，不留在空面板
      log(`${entry.file.relPath} 标记后已无差异，自动跳到下一个待审查`);
      await nextUnreviewed(null);
      return;
    }
    if (value && entry) { await revealInTree(entry, 6); } // 打钩后文件会下移，高亮跟着走
    if (panel && panel.entry && sameEntry(panel.entry, entry)) { await panel.reload(); }
  },
  openInEditor: async (entry, line) => { await openBaseDiff(entry, line); },
  editLine: async (entry, line, text, insertBelow, focusLine) => { await editLineInFile(entry, line, text, insertBelow, focusLine); },
  insertLine: async (entry, line) => { await insertLineInFile(entry, line); },
  deleteLine: async (entry, line, focusLine) => { await deleteLineInFile(entry, line, focusLine); },
  clusterRestore: async (entry, hunk, clus) => { await clusterRestoreInFile(entry, hunk, clus); },
  deleteLines: async (entry, lines) => { await deleteLinesInFile(entry, lines); },
  insertLinesBelow: async (entry, line, text) => { await insertLinesBelowInFile(entry, line, text); },
  copyText: async (text) => {
    // 复制走扩展宿主写剪贴板（webview 内 execCommand('copy') 不稳定）
    try { await vscode.env.clipboard.writeText(String(text == null ? '' : text)); }
    catch (e) { log(`写剪贴板失败：${e.message}`); }
  },
  next: async (entry) => { await nextUnreviewed(entry); }
};

function sameEntry(a, b) {
  if (!a || !b) { return false; }
  return platform.toGitPath(a.file.relPath) === platform.toGitPath(b.file.relPath)
    && platform.normalizeForCompare(a.source.root) === platform.normalizeForCompare(b.source.root);
}

/**
 * 单文件复查：拒绝/还原/保存后工作区只变了一个文件，不必整表重扫。
 * 返回 true 表示已回退到全量刷新，调用方不要再做别的。
 */
async function refreshSingleEntry(entry) {
  const src = entry.source;
  const p = src.provider;
  let fresh = undefined;
  if (p && typeof p.recheckFile === 'function') {
    try {
      fresh = await p.recheckFile(entry.file);
    } catch (e) {
      log(`单文件复查失败（${entry.file.relPath}），回退全量刷新：${e.message}`);
      fresh = undefined;
    }
  }
  if (fresh === undefined) { await doRefresh(false); return true; }

  const rel = platform.toGitPath(entry.file.relPath);
  const list = src.files;
  const idx = list.findIndex((f) => platform.toGitPath(f.relPath) === rel);
  if (!fresh) {
    if (idx !== -1) { list.splice(idx, 1); }
  } else {
    fresh.reviewed = store.isReviewed(src.root, fresh.relPath, fresh.hash);
    if (idx !== -1) { list[idx] = fresh; } else { list.push(fresh); }
  }
  model.flat = [];
  for (const s of model.sources) {
    for (const f of s.files) { model.flat.push({ source: s, file: f }); }
  }
  provider.setModel(model);
  updateBadges();
  if (pendingReveal) { retryPendingReveal().catch(() => {}); }

  // 面板正停在这个文件上：文件没了就跳下一个，还在就重渲染这一个文件的 diff
  if (panel && panel.entry && sameEntry(panel.entry, entry)) {
    if (fresh) { await panel.reload(); }
    else { panel.entry = null; await nextUnreviewed(null); }
  }
  return false;
}

/**
 * 接受全部：只把文件标记为已审查，不 git add / 不改文件内容。
 * （0.4.5 语义：接受=对文件层面的判断；暂存只发生在显式「标记为已审查」打勾时）
 */
async function acceptFile(entry) {
  const p = entry.source.provider;
  await setReviewed(entry, true);
  provider.refresh();
  updateBadges();
  await revealInTree(entry, 6); // 接受后同样保持列表高亮跟随
  if (panel && panel.entry && sameEntry(panel.entry, entry)) { await panel.reload(); }
  vscode.window.showInformationMessage(`已接受 ${entry.file.relPath}（仅标记为已审查，未改动${p.id === 'git' ? '暂存区' : '文件'}）`);
}

async function rejectFile(entry) {
  const p = entry.source.provider;
  const kind = entry.file.kind;
  const answer = await vscode.window.showWarningMessage(
    kind === 'untracked' || (p.id === 'snapshot' && kind === 'untracked')
      ? `确定删除新增文件 ${entry.file.relPath} 吗？此操作不可撤销。`
      : `确定放弃 ${entry.file.relPath} 的全部改动并还原到${p.baseLabel}吗？此操作不可撤销。`,
    { modal: true },
    '拒绝改动'
  );
  if (answer !== '拒绝改动') { return; }
  try {
    const res = await p.rejectFile(entry.file);
    log(`拒绝 ${entry.file.relPath}: ${res.message || ''}`);
  } catch (e) {
    const msg = `还原 ${entry.file.relPath} 失败：${e.message}`;
    log(msg);
    showErr(msg);
    return;
  }
  const wasPanelFile = !!(panel && panel.entry && sameEntry(panel.entry, entry));
  // 拒绝全部 = 内容已执行 → 自动标记为已审查（文件随后会从改动列表消失）
  await setReviewed(entry, true);
  const didFull = await refreshSingleEntry(entry);
  // 单文件路径已由 refreshSingleEntry 处理面板；全量路径在此补“当前文件整个被还原 → 跳下一个”
  if (didFull && wasPanelFile && !findEntry(entry.source.root, entry.file.relPath)) {
    await nextUnreviewed(null);
  }
  vscode.window.showInformationMessage(`已还原 ${entry.file.relPath}（自动标记为已审查）`);
}

/** 校验点击的块与当前 diff 是否一致（文件被编辑过时索引会漂移） */
async function verifyHunkSig(entry, index, sig) {
  if (!sig) { return true; }
  const t = await entry.source.provider.getDiff(entry.file, cfg().get('contextLines', 3));
  const hunks = parseDiff(t)[0].hunks;
  return !!hunks[index] && hunkSignature(hunks[index]) === sig;
}

async function rejectHunk(entry, index, sig) {
  if (sig && !(await verifyHunkSig(entry, index, sig))) {
    vscode.window.showWarningMessage('文件内容已变化，该块位置对不上了，请刷新后重试。');
    return;
  }
  // 只记录拒绝决定，不立即改文件——和接受块对称：执行统一发生在「标记为已审查」时，
  // 之前随时可以撤销拒绝（反悔机会）
  await store.setHunkRejected(entry.source.root, entry.file.relPath, sig, true);
  await store.setHunkReviewed(entry.source.root, entry.file.relPath, sig, false); // 从已接受表移除（若之前接受过）
  log(`已记录拒绝 ${entry.file.relPath} 第 ${index + 1} 块 (sig=${sig})，标记为已审查时执行还原`);
  await autoMarkWhenAllHunksDone(entry);
  if (panel && panel.entry && sameEntry(panel.entry, entry)) { await panel.reload(); }
  vscode.window.setStatusBarMessage(`已拒绝 ${entry.file.relPath} 第 ${index + 1} 个改动块（标记为已审查时执行还原）`, 4000);
}

/** 撤销某个块的拒绝决定（反悔） */
async function unrejectHunk(entry, index, sig) {
  await store.setHunkRejected(entry.source.root, entry.file.relPath, sig, false);
  log(`已撤销拒绝 ${entry.file.relPath} 第 ${index + 1} 块`);
  if (panel && panel.entry && sameEntry(panel.entry, entry)) { await panel.reload(); }
}

/**
 * 执行某文件所有待执行的拒绝块（标记为已审查时调用）。
 * 从最后一个块往前还原，避免 index 漂移。
 * 返回实际还原的块数；-1 表示执行失败（调用方不应继续标记）。
 */
async function applyPendingRejects(entry) {
  try {
    const table = store.getRejectedHunks(entry.source.root, entry.file.relPath);
    const sigs = Object.keys(table);
    if (!sigs.length) { return 0; }
    const p = entry.source.provider;
    const t = await p.getDiff(entry.file, cfg().get('contextLines', 3));
    const parsed = parseDiff(t)[0];
    const hunks = parsed ? parsed.hunks : [];
    let applied = 0;
    for (let i = hunks.length - 1; i >= 0; i -= 1) {
      const s = hunkSignature(hunks[i]);
      if (table[s]) {
        await p.rejectHunk(entry.file, i, cfg().get('contextLines', 3));
        applied += 1;
      }
    }
    await store.clearRejectedHunks(entry.source.root, entry.file.relPath);
    if (applied) {
      log(`已执行 ${entry.file.relPath} 的拒绝决定（还原 ${applied} 块）`);
      vscode.window.setStatusBarMessage(`已还原 ${entry.file.relPath} 的 ${applied} 个拒绝块`, 3000);
    }
    return applied;
  } catch (e) {
    const msg = `执行拒绝块失败：${e.message}`;
    log(msg);
    showErr(msg);
    return -1; // 拒绝块没执行成功就不标记已审查，保持状态一致
  }
}

async function currentSig(entry, index) {
  try {
    const t = await entry.source.provider.getDiff(entry.file, cfg().get('contextLines', 3));
    const hunks = parseDiff(t)[0].hunks;
    return hunks[index] ? hunkSignature(hunks[index]) : null;
  } catch (e) {
    return null;
  }
}

async function acceptHunk(entry, index, sig) {
  if (sig && !(await verifyHunkSig(entry, index, sig))) {
    vscode.window.showWarningMessage('文件内容已变化，该块位置对不上了，请刷新后重试。');
    return;
  }
  try {
    await entry.source.provider.acceptHunk(entry.file, index, cfg().get('contextLines', 3));
  } catch (e) {
    const msg = `接受第 ${index + 1} 个改动块失败：${e.message}`;
    log(msg);
    showErr(msg);
    return;
  }
  await store.setHunkReviewed(entry.source.root, entry.file.relPath, sig, true);
  await store.setHunkRejected(entry.source.root, entry.file.relPath, sig, false); // 改主意：从拒绝表移除
  log(`已接受 ${entry.file.relPath} 第 ${index + 1} 块 (sig=${sig})`);
  // 接受只动暂存区/标记，工作区内容没变：不需要整表重扫
  await autoMarkWhenAllHunksDone(entry);
  if (panel && panel.entry && sameEntry(panel.entry, entry)) { await panel.reload(); }
  vscode.window.setStatusBarMessage(`已接受 ${entry.file.relPath} 第 ${index + 1} 个改动块`, 3000);
}

/** 一个文件的所有改动块都有决定（接受或拒绝）→ 自动标记为已审查（拒绝块在此刻执行还原） */
async function autoMarkWhenAllHunksDone(entry) {
  const fresh = findEntry(entry.source.root, entry.file.relPath);
  if (!fresh || fresh.file.reviewed) { return; }
  try {
    const t = await fresh.source.provider.getDiff(fresh.file, cfg().get('contextLines', 3));
    const hunks = parseDiff(t)[0].hunks;
    if (!hunks.length) { return; }
    const acc = store.getReviewedHunks(fresh.source.root, fresh.file.relPath);
    const rej = store.getRejectedHunks(fresh.source.root, fresh.file.relPath);
    const allDone = hunks.every((h) => { const s = hunkSignature(h); return acc[s] || rej[s]; });
    if (allDone) {
      await setReviewed(fresh, true); // 内部会执行所有待执行的拒绝块（还原）
      await refreshSingleEntry(fresh); // 拒绝执行后文件可能已无差异 → 从列表移除
      provider.refresh();
      updateBadges();
      log(`${fresh.file.relPath} 全部改动块已决定（接受/拒绝），自动标记为已审查`);
      // 文件已无差异 → 自动跳到下一个待审查，不留在"没有差异"的空面板
      if (!findEntry(fresh.source.root, fresh.file.relPath)) {
        log(`${fresh.file.relPath} 已无差异，自动跳到下一个待审查`);
        await nextUnreviewed(null);
      } else if (panel && panel.entry && sameEntry(panel.entry, fresh)) {
        await panel.reload();
      }
    }
  } catch (e) {
    log(`自动打钩检查失败：${e.message}`);
  }
}

// ------------------------------------------------------------ 基准快照命令
async function initBaseline(arg) {
  const src = resolveSource(arg) || model.sources.find((s) => s.provider.id === 'snapshot');
  if (!src) {
    vscode.window.showInformationMessage('没有找到可用于建立基准的项目目录。');
    return;
  }
  if (src.provider.id !== 'snapshot') {
    vscode.window.showInformationMessage(
      `该项目由 ${src.provider.label} 管理，对比基准就是${src.provider.baseLabel}，不需要手动初始化。`
    );
    return;
  }
  const info = src.provider.baselineInfo();
  const answer = await vscode.window.showWarningMessage(
    info
      ? `将用当前文件状态重新建立对比基准（覆盖原有基准，原有 ${info.fileCount} 个文件的记录会被替换）。继续？`
      : `将把 ${src.root} 的当前文件状态记录为对比基准，之后以此为基准显示改动。继续？`,
    { modal: true },
    '建立基准'
  );
  if (answer !== '建立基准') { return; }
  try {
    const res = src.provider.initBaseline();
    log(`已建立基准：${src.root}（${res.fileCount} 个文件）`);
  } catch (e) {
    vscode.window.showErrorMessage(`建立基准失败：${e.message}`);
    return;
  }
  await doRefresh(false);
  vscode.window.showInformationMessage(`已把当前状态设为对比基准（${src.root}）`);
}

async function updateBaseline(arg) {
  // 关键（0.4.2 bug 10）：只有调用方「显式」传了文件级目标才更新单个文件。
  // 标题栏 ↑ 和命令面板都是全量更新——不能走 resolveArg 的兜底链
  // （树选中项 → 面板当前文件），否则用户以为在更新整个基准，
  // 实际只把当前选中的一个文件更新了，其余文件差异原封不动。
  let entry = null;
  if (arg instanceof FileNode) {
    entry = { source: arg.repo, file: arg.file };
  } else if (arg && arg.repoRoot && arg.relPath) {
    entry = findEntry(arg.repoRoot, arg.relPath);
  }
  const src = (entry && entry.source)
    || (arg instanceof RepoNode ? arg.repo : null)
    || resolveSource(arg && (arg.repoRoot || arg.root) ? arg : null)
    || model.sources.find((s) => s.provider.id === 'snapshot');
  if (!src) {
    vscode.window.showInformationMessage('没有找到可更新基准的项目目录。');
    return;
  }
  if (!src.provider.capabilities.baselineUpdate) {
    vscode.window.showInformationMessage(
      `该项目由 ${src.provider.label} 管理，基准由版本控制系统决定（${src.provider.baseLabel}），无需手动更新。`
    );
    return;
  }
  const only = entry ? [entry.file.relPath] : null;
  const answer = await vscode.window.showWarningMessage(
    only
      ? `把 ${only[0]} 的当前内容设为新的对比基准？该文件将不再显示为改动。`
      : '把当前所有文件的状态设为新的对比基准？之后所有文件都不再显示为改动。',
    { modal: true },
    '更新基准'
  );
  if (answer !== '更新基准') { return; }
  try {
    src.provider.updateBaseline(only);
    log(`已更新基准：${src.root}${only ? ' (' + only.join(',') + ')' : '（全部）'}`);
  } catch (e) {
    vscode.window.showErrorMessage(`更新基准失败：${e.message}`);
    return;
  }
  await doRefresh(false);
  vscode.window.showInformationMessage(only ? `已更新 ${only[0]} 的基准` : '已更新对比基准');
}

function startTimer() {
  if (timer) { clearInterval(timer); timer = null; }
  const seconds = cfg().get('autoRefreshInterval', 5);
  if (!seconds || seconds <= 0) { return; }
  timer = setInterval(() => {
    if (treeView.visible || (panel && panel.panel && panel.panel.visible)) { doRefresh(false); }
  }, seconds * 1000);
}

/** 远程工作区却在本地运行扩展宿主（典型：WSL 工作区 + 只装在 Windows 的插件） */
function checkRemoteMismatch() {
  const folders = vscode.workspace.workspaceFolders || [];
  const remoteFolders = folders.filter((f) => f.uri.scheme === 'vscode-remote');
  if (remoteFolders.length && !vscode.env.remoteName) {
    log('警告：工作区是远程/WSL，但扩展运行在本地宿主');
    vscode.window.showWarningMessage(
      'Change Review 检测到工作区在远程/WSL 中，但插件正运行在 Windows 本地。' +
      '请在扩展面板里点「在 WSL 中安装」把插件装进远程，否则 git/svn 路径与文件操作都会异常。',
      '我知道了'
    );
  }
}

async function activate(context) {
  outputChannel = vscode.window.createOutputChannel('Change Review');
  context.subscriptions.push(outputChannel);
  log(`扩展已激活 v${require('../package.json').version}，语言=${vscode.env.language}，日志命令：Ctrl+Shift+P → "Change Review: 打开日志"`);

  storageDir = context.globalStorageUri ? context.globalStorageUri.fsPath : '';
  try {
    require('fs').mkdirSync(storageDir, { recursive: true });
  } catch (e) { /* ignore */ }

  store = new ReviewStore(context.workspaceState);
  require('./gitService').setDiagLogger(log); // git 层诊断 → 统一进 Output + 日志文件
  provider = new ChangesTreeProvider(() => cfg());
  treeView = vscode.window.createTreeView('changeReview.files', {
    treeDataProvider: provider,
    showCollapseAll: false,
    canSelectMany: false
  });
  context.subscriptions.push(treeView);
  // 树从隐藏变成可见时，补做一次 pending 高亮（#4：列表不可见期间 reveal 会静默失败）
  if (typeof treeView.onDidChangeVisibility === 'function') {
    context.subscriptions.push(treeView.onDidChangeVisibility((vis) => {
      if (vis) { retryPendingReveal().catch(() => {}); }
    }));
  }

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'changeReview.focusView';
  context.subscriptions.push(statusBar);

  panel = new ReviewPanel(handlers);

  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('change-review-base', {
    provideTextDocumentContent: async (uri) => {
      const params = new URLSearchParams(uri.query);
      const root = params.get('root') || '';
      const relPath = String(uri.path || '').replace(/^\//, '');
      const entry = findEntry(root, relPath);
      if (!entry) { return ''; }
      try {
        return await entry.source.provider.getBaseContent(entry.file);
      } catch (e) {
        log(`读取基准内容失败 ${relPath}: ${e.message}`);
        return '';
      }
    }
  }));

  context.subscriptions.push(treeView.onDidChangeCheckboxState(async (e) => {
    for (const [node, state] of e.items) {
      if (node instanceof FileNode) {
        const value = state === vscode.TreeItemCheckboxState.Checked;
        await setReviewed({ source: node.repo, file: node.file }, value, { stageGit: true });
      }
    }
    provider.refresh();
    updateBadges();
  }));

  const register = (cmd, fn) => context.subscriptions.push(
    vscode.commands.registerCommand(cmd, async (...args) => {
      try {
        return await fn(...args);
      } catch (e) {
        const msg = `命令 ${cmd} 执行失败：${e && e.message ? e.message : e}`;
        log(`${msg}\n${e && e.stack ? e.stack : ''}`);
        showErr(msg);
      }
    })
  );

  register('changeReview.refresh', () => doRefresh(true)); // 手动刷新：强制重新探测
  register('changeReview.focusView', () => vscode.commands.executeCommand('changeReview.files.focus'));
  register('changeReview.showLog', async () => {
    if (outputChannel) { outputChannel.show(true); }
  });

  register('changeReview.configureExclude', async () => {
    const folders = vscode.workspace.workspaceFolders || [];
    if (!folders.length) {
      vscode.window.showInformationMessage('请先打开一个文件夹，再配置排除规则。');
      return;
    }
    let target = folders[0];
    if (folders.length > 1) {
      const pick = await vscode.window.showQuickPick(
        folders.map((f) => ({ label: f.name || f.uri.fsPath, fsPath: f.uri.fsPath })),
        { placeHolder: '选择要配置排除规则的文件夹' }
      );
      if (!pick) { return; }
      target = { uri: { fsPath: pick.fsPath } };
    }
    const igPath = path.join(target.uri.fsPath, '.crignore');
    let created = false;
    if (!fs.existsSync(igPath)) {
      fs.writeFileSync(igPath, IGNORE_TEMPLATE, 'utf8');
      created = true;
    }
    const doc = await vscode.workspace.openTextDocument(igPath);
    await vscode.window.showTextDocument(doc);
    if (created) {
      vscode.window.showInformationMessage('已创建 .crignore：每行一个 glob，保存后自动生效。');
    }
  });
  register('changeReview.initBaseline', (arg) => initBaseline(arg));
  register('changeReview.updateBaseline', (arg) => updateBaseline(arg));
  register('changeReview.openReview', async (arg) => {
    const entry = resolveArg(arg);
    if (entry) { setActiveFile(entry); await panel.show(entry); }
  });
  register('changeReview.openDiff', async (arg) => {
    const entry = resolveArg(arg);
    if (entry) { await openBaseDiff(entry); }
  });
  register('changeReview.acceptFile', async (arg) => {
    const entry = resolveArg(arg);
    if (entry) { await acceptFile(entry); }
  });
  register('changeReview.rejectFile', async (arg) => {
    const entry = resolveArg(arg);
    if (entry) { await rejectFile(entry); }
  });
  register('changeReview.markReviewed', async (arg) => {
    const entry = resolveArg(arg);
    if (!entry) { return; }
    await setReviewed(entry, true);
    provider.refresh();
    updateBadges();
    vscode.window.setStatusBarMessage(`已标记 ${entry.file.relPath} 为已审查`, 3000);
  });
  register('changeReview.unmarkReviewed', async (arg) => {
    const entry = resolveArg(arg);
    if (!entry) { return; }
    await setReviewed(entry, false);
    provider.refresh();
    updateBadges();
    vscode.window.setStatusBarMessage(`已取消 ${entry.file.relPath} 的审查标记`, 3000);
  });
  register('changeReview.markAllReviewed', async () => {
    if (!model.flat.length) {
      vscode.window.showInformationMessage('当前没有待审查的改动');
      return;
    }
    await store.markAll(model.flat);
    for (const e of model.flat) { e.file.reviewed = true; }
    provider.refresh();
    updateBadges();
    vscode.window.setStatusBarMessage(`已把 ${model.flat.length} 个文件标记为已审查`, 3000);
  });
  register('changeReview.clearReviewed', async () => {
    await store.clearAll();
    // 内容没变，只是标记清了：直接改内存状态 + 刷新树，不做全量重扫
    for (const e of model.flat) { e.file.reviewed = false; }
    provider.refresh();
    updateBadges();
    vscode.window.setStatusBarMessage('已清除所有审查标记', 3000);
  });
  register('changeReview.nextUnreviewed', async () => { await nextUnreviewed(null); });
  register('changeReview.revealFile', async (arg) => {
    const entry = resolveArg(arg);
    if (entry) { await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(entry.file.absPath)); }
  });

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc && doc.uri && /(^|[\\/])\.crignore$/.test(doc.uri.fsPath || '')) {
        // 排除规则文件被改了：重建探测并刷新（排除规则已并入 vcsOptions，下一轮刷新自动生效）
        forceRedetect = true;
        scheduleRefresh(150);
        return;
      }
      scheduleFileRefresh(doc);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('changeReview')) {
        forceRedetect = true; // 探测参数/排除规则可能变了，重建 providers
        if (e.affectsConfiguration('changeReview.gitPath') || e.affectsConfiguration('changeReview.svnPath')) {
          require('./gitService').resetGit();
          require('./vcs/svnProvider').resetSvn();
        }
        startTimer();
        scheduleRefresh(200);
        provider.refresh();
        updateBadges();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      forceRedetect = true;
      scheduleRefresh(400);
    })
  );

  log(`Change Review 激活：platform=${process.platform} remote=${vscode.env.remoteName || '本地'} vscode=${vscode.version} storage=${storageDir}`);
  checkRemoteMismatch();
  await doRefresh(true);
  startTimer();
}

function deactivate() {
  if (timer) { clearInterval(timer); }
  if (refreshTimer) { clearTimeout(refreshTimer); }
}

module.exports = { activate, deactivate };
