'use strict';

const vscode = require('vscode');
// 轻量 i18n：默认串为英文，中文译文在 package.nls.zh-cn.json（含全部运行时提示）。
// 注意不能用 vscode.l10n.t：它运行时只读 l10n/bundle.l10n.*.json，不读 package.nls.*.json。
// 语言跟随 changeReview.uiLanguage：zh 强制中文 / en 强制英文 / auto 跟随 VSCode 显示语言。
const zhDict = (() => {
  try { return require('../package.nls.zh-cn.json') || {}; } catch (e) { return {}; }
})();
function formatMsg(str, args) {
  if (!args || !args.length) { return str; }
  return String(str).replace(/\{(\d+)\}/g, (m, i) => (args[i] !== undefined ? args[i] : m));
}
function msgLang() {
  try {
    const ui = (cfg().get('uiLanguage', 'auto') || 'auto').toLowerCase();
    if (ui === 'zh') { return 'zh'; }
    if (ui === 'en') { return 'en'; }
  } catch (e) { /* cfg 未初始化时按 auto */ }
  const l = (vscode.env && vscode.env.language || '').toLowerCase();
  return l.startsWith('zh') ? 'zh' : 'en';
}
const t = (id, args) => formatMsg(msgLang() === 'zh' ? (zhDict[id] || id) : id, args);
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
    excludeSets: (opt.excludeSets || []).map((s) => ({ b: platform.normalizeForCompare(s.base), r: s.rules })),
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
function readIgnoreFile(igPath) {
  if (!fs.existsSync(igPath)) { return null; }
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
    log(`读取 ${path.basename(igPath)} 失败 ${igPath}: ${e.message}`);
    return [];
  }
}

/**
 * 读取某个工作区目录下的排除规则（gitignore 风格）：
 *   有 .crignore → 用它（svn / 未托管工程主要靠它）；
 *   没有 .crignore → 默认回退到该目录的 .gitignore 规则（git 工程不需要额外配 .crignore）。
 */
function readProjectIgnore(folderFsPath) {
  const crig = readIgnoreFile(path.join(folderFsPath, '.crignore'));
  if (crig !== null) { return crig; }
  const gi = readIgnoreFile(path.join(folderFsPath, '.gitignore'));
  return gi === null ? [] : gi;
}

/**
 * 汇总所有工作区目录里的项目忽略规则，**带上「规则文件所在目录」**。
 *
 * 这是与 .gitignore 对齐的关键：git 里某个 .gitignore 的规则，匹配的是「相对该 .gitignore
 * 所在目录」的路径，而不是相对仓库根。我们如果把规则拍平成一个列表、统一按「相对来源根」
 * 去匹配，当来源根 ≠ 规则文件所在目录时（比如打开的是仓库子目录），规则就会因前缀对不上而失效。
 * 所以这里保留 base，交给 provider 按 base 锚定匹配。
 */
function projectIgnoreSets() {
  const folders = vscode.workspace.workspaceFolders || [];
  const sets = [];
  for (const f of folders) {
    const rules = readProjectIgnore(f.uri.fsPath);
    if (rules.length) { sets.push({ base: f.uri.fsPath, rules }); }
  }
  return sets;
}

// 默认内容：一行说明即可，中英文对照；规则语法同 .gitignore
const IGNORE_TEMPLATE = '# 排除规则，语法同 .gitignore / Exclude rules, same syntax as .gitignore\n';

/** 把一条 glob 规则写入某个目录的 .crignore（不存在则创建；已存在则跳过）。返回 'added' | 'exists' */
function appendIgnoreRule(folderFsPath, glob) {
  const igPath = path.join(folderFsPath, '.crignore');
  const existing = readIgnoreFile(igPath) || [];
  if (existing.some((g) => g === glob)) { return 'exists'; }
  let body = IGNORE_TEMPLATE;
  if (fs.existsSync(igPath)) {
    const raw = fs.readFileSync(igPath, 'utf8');
    body = raw.length && !raw.endsWith('\n') ? `${raw}\n` : raw;
  }
  fs.writeFileSync(igPath, `${body}${glob}\n`, 'utf8');
  return 'added';
}

/** 计算一个文件相对于工作区目录的 posix 相对路径；不在工作区内则返回 null */
function relToFolder(folderFsPath, absPath) {
  const rel = path.relative(folderFsPath, absPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) { return null; }
  return rel.split(path.sep).join('/');
}

function vcsOptions() {
  // 设置项里的排除规则：按「相对来源根」匹配（README 语义），外加规则文件自身始终隐藏
  const exclude = [
    ...cfg().get('exclude', []),
    '.crignore',
    '**/.crignore'
  ].filter((x) => typeof x === 'string' && x.length > 0);
  // 项目 .crignore / .gitignore：按「各自规则文件所在目录」锚定（与 .gitignore 语义一致）
  const excludeSets = projectIgnoreSets();
  return {
    forceVcs: cfg().get('forceVcs', 'auto'),
    searchDepth: cfg().get('vcsSearchDepth', 5),
    exclude,
    excludeSets,
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
      t('Change Review: no target file found. Select a file in the changes list, or open the file first, then run the command.')
    );
  }
  return entry;
}

/**
 * 标记/取消「已审查」。
 * opts.stageGit=true 时（勾选/取消勾选这种显式的"标记已审查"动作）会顺带操作 git 暂存区：
 *   勾选 → git add（加入暂存区）；取消 → git reset（撤出暂存区）。
 * 接受(全部/此块) 与「全部标记」走的都是普通标记（stageGit 不传），
 * 一律不碰暂存区——用户语义：接受/拒绝只对文件层面判断，暂存只在显式打勾时发生。
 */
async function setReviewed(entry, value, opts) {
  if (!entry) { return; }
  const root = entry.source.root;
  const provider = entry.source.provider;
  // git 工程：标记为已审查 = 加入暂存区（git add）。这是既定行为——
  // 「接受全部 / 标记为已审查 / 块都处理完自动打钩 / 树上打勾」都必须走这一步，
  // 只有调用方显式传 { stageGit: false } 才跳过。
  const stageGit = !!(provider && provider.id === 'git') && !(opts && opts.stageGit === false);
  let appliedRejects = 0;
  if (value) {
    // 标记已审查前，先执行该文件所有待执行的拒绝块；失败则不标记，保持状态一致
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
    await store.clearAutoMarkOff(root, entry.file.relPath); // 明确标记了 → 解除自动标记抑制
  } else {
    await store.clearReviewed(root, entry.file.relPath);
    // 手动取消审查 = 用户要自己接着操作：抑制「块都决定了就自动打钩」，
    // 否则下一次刷新/对账会立刻把钩打回来（用户根本没法进入修改流程）。
    // 抑制按当前指纹记录 —— 文件一改，指纹变化，自动打钩恢复正常。
    await store.setAutoMarkOff(root, entry.file.relPath, entry.file.hash);
    log(`已取消审查 ${entry.file.relPath}：暂停自动标记（文件再次改动后恢复）`);
  }
  entry.file.reviewed = value;
  return true;
}

/**
 * 标记完一个文件后自动跳到下一个待审查（用户的期望：标完就走，不用自己找）。
 * 没有下一个时 nextUnreviewed 会给出「全部审查完毕」的提示，所以直接复用即可。
 */
async function advanceAfterReviewed(entry) {
  if (!entry || !entry.file.reviewed) { return; }
  log(`[next] ${entry.file.relPath} 已标记，自动跳到下一个待审查`);
  await nextUnreviewed(entry);
}

/**
 * 用文件当前实际状态重算指纹（拒绝块还原后内容已变，原 hash 失效）。
 * 必须与「刷新时算出的 hash」口径完全一致，否则「标记已审查」会被下一次刷新判成未审查 →
 * 表现为「明明全打钩了，却没标记已审查」。
 * 所以优先用 provider 自己复查出来的 hash（refreshSingleEntry 用的就是它），
 * 拿不到再退回按解析出的块统计。
 */
async function freshFileHash(entry) {
  const p = entry.source && entry.source.provider;
  if (p && typeof p.recheckFile === 'function') {
    try {
      const hit = await p.recheckFile(entry.file);
      if (hit && typeof hit.hash === 'string' && hit.hash) { return hit.hash; }
    } catch (e) {
      log(`复查文件拿权威指纹失败（${entry.file.relPath}）：${e.message}`);
    }
  }
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
    const trustThis = t('Trust this repository');
    const trustAll = t('Trust all repositories');
    const pick = await vscode.window.showWarningMessage(
      t('Git refused to access the repository (dubious ownership): {0}\nUsually because the repository owner differs from the current user (common when WSL mounts a Windows directory).', [root]),
      trustThis,
      trustAll
    );
    if (pick === trustThis) {
      await require('./gitService').addSafeDirectory(root, false);
      vscode.window.showInformationMessage(t('Added {0} to git safe.directory', [root]));
    } else if (pick === trustAll) {
      await require('./gitService').addSafeDirectory(null, true);
      vscode.window.showInformationMessage(t('Set safe.directory = *'));
    } else {
      return;
    }
    require('./gitService').resetGit();
    await doRefresh(true);
  } catch (e) {
    vscode.window.showErrorMessage(t('Failed to set safe.directory: {0}', [e.message]));
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
          const msg = t('No usable git executable found ({0}). Please set changeReview.gitPath to the full path of git in VSCode settings.', [platform.IS_WIN ? 'Windows' : (platform.IS_MAC ? 'macOS' : 'Linux/WSL')]);
          log(`git 不可用：${e.message}`);
          vscode.window.showWarningMessage(t('Change Review: {0}', [msg]), t('Got it'));
          detectionFailures.push({ kind: 'git-missing', message: msg });
        } else {
          log(`探测版本控制失败：${e.message}`);
          vscode.window.showErrorMessage(t('Change Review failed to detect version control: {0}', [e.message]));
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
    // 「审查中」标记重新挂到新的 source 对象上（source 每次刷新都重建）
    reapplyActiveFile(sources);
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
    // 兜底对账：块都决定了却没标记的文件在这里补上（自动刷新会换掉 model 对象，
    // 只靠点击那一刻的检查会漏 → 用户看到"全打钩了但没标记已审查"）
    await reconcileDecidedFiles();
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
    panel.panel.webview.html = '<html><body style="font-family:var(--vscode-font-family);padding:20px">' + t('This file no longer differs from the comparison baseline.') + '</body></html>';
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
    ? { value: pending, tooltip: t('{0} files pending review (out of {1} changes)', [pending, total]) }
    : undefined;

  const needBaseline = model.sources.filter((s) => s.needBaseline);
  const kinds = Array.from(new Set(model.sources.map((s) => s.label))).join('/');
  const failures = model.detectionFailures || [];

  if (failures.length) {
    // 把探测失败一次性展示在面板顶部（不会反复弹窗）
    const msg = failures[0].message;
    treeView.message = t('⚠ {0}', [msg]);
  } else if (needBaseline.length && model.sources.length === 1 && needBaseline.length === 1) {
    treeView.message = t('This project has no git / svn. Click "Initialize Baseline" to set a review baseline.');
  } else if (total === 0 && kinds) {
    treeView.message = t('No files differing from the {0} baseline were detected', [kinds]);
  } else if (total === 0 && !kinds) {
    treeView.message = t('No recognizable source (neither a git / svn repo nor a project that can be snapshotted)');
  } else if (pending === 0) {
    treeView.message = t('All {0} files reviewed ✓', [total]);
  } else {
    treeView.message = undefined;
  }

  if (!cfg().get('showStatusBar', true)) {
    statusBar.hide();
    return;
  }
  statusBar.text = total === 0
    ? (failures.length ? t('$(warning) {0}', [kinds || 'Unrecognized source']) : t('$(check) No local changes'))
    : (pending === 0 ? t('$(check-all) {0} files reviewed', [total]) : t('$(checklist) {0}/{1} reviewed', [done, total]));
  const srcLine = kinds ? t('({0})', [kinds]) : t('(Unrecognized source)');
  statusBar.tooltip = failures.length
    ? t('Change Review detection failed: {0}\nClick to open settings and fix the git/svn path.', [failures[0].message])
    : t('Change Review{0}: {1} files differ from the baseline, {2} reviewed. Click to focus the changes list.', [srcLine, total, done]);
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
      vscode.window.showInformationMessage(t('The file does not currently exist (it may have been deleted), so it cannot be edited directly.'));
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
    vscode.window.setStatusBarMessage(t('Opened {0}:{1}', [entry.file.relPath, lineNo]), 3000);
  } catch (e) {
    const msg = t('Failed to open {0}: {1}', [entry.file.relPath, e.message]);
    log(msg);
    showErr(msg);
  }
}

/**
 * 在对比块里直接改某一行：按「新文件行号」把该行写回文件，然后刷新 diff 与改动列表。
 * 这是用户要的「编辑 = 在对比块里就地改、同步到内容」，而不是跳到文件里改。
 * insertBelow=true 时（按 Enter / 点「+行」）顺便在该行下面插一个空行，并把焦点落到新行。
 */
async function editLineInFile(entry, lineNo, text, insertBelow, focusLine, opts) {
  pushSnapshot(entry);
  const abs = entry.file.absPath;
  const tail = opts && typeof opts.tail === 'string' ? opts.tail : ''; // Enter 在行中间：光标后半截成为下一行
  if (!abs || !fs.existsSync(abs)) {
    vscode.window.showWarningMessage(t('The file does not currently exist (it may have been deleted), so changes cannot be written.'));
    return;
  }
  if (typeof text !== 'string') { return; }
  try {
    const content = fs.readFileSync(abs, 'utf8');
    const lines = content.split('\n');
    const idx = Number(lineNo) - 1;
    if (!(idx >= 0 && idx < lines.length)) {
      vscode.window.showWarningMessage(t('Line number {0} is out of range ({1} lines total); not written.', [lineNo, lines.length]));
      return;
    }
    let changed = false;
    if (lines[idx] !== text) { lines[idx] = text; changed = true; }
    if (insertBelow) { lines.splice(idx + 1, 0, tail); }
    if (!changed && !insertBelow) {
      // Ctrl+S 但内容没变：给个明确反馈，别让人以为没生效
      vscode.window.setStatusBarMessage(t('This line is already up to date; no save needed ({0}:{1})', [entry.file.relPath, lineNo]), 2000);
      return;
    }
    fs.writeFileSync(abs, lines.join('\n'), 'utf8');
    log(`[审查面板] 已写回 ${entry.file.relPath}:${lineNo}${insertBelow ? (tail !== null ? ' 并拆行' : ' 并插入新行') : ''}`);
    vscode.window.setStatusBarMessage(t('Written back {0}:{1}', [entry.file.relPath, lineNo]), 2000);
    // 只复查这一个文件：全量 doRefresh 会触发整仓 git 扫描，行内编辑（尤其 Enter 拆行）会明显卡顿
    const targetFocus = focusLine ? Number(focusLine) : (insertBelow ? idx + 2 : undefined);
    await afterLineOp(entry, { focusLine: targetFocus });
  } catch (e) {
    const msg = t('Failed to write back line {0}: {1}', [lineNo, e.message]);
    log(msg);
    showErr(msg);
  }
}

/** 在第 lineNo 行上面插入一个空行（Enter 打在行首时；焦点回到原来的内容行，内容被顶下来） */
async function insertLineAboveInFile(entry, lineNo) {
  pushSnapshot(entry);
  const abs = entry.file.absPath;
  if (!abs || !fs.existsSync(abs)) { return; }
  try {
    const lines = fs.readFileSync(abs, 'utf8').split('\n');
    const idx = Number(lineNo) - 1;
    if (!(idx >= 0 && idx <= lines.length)) {
      vscode.window.showWarningMessage(t('Line number {0} is out of range; not inserted.', [lineNo]));
      return;
    }
    lines.splice(idx, 0, '');
    fs.writeFileSync(abs, lines.join('\n'), 'utf8');
    log(`[审查面板] 已在 ${entry.file.relPath}:${lineNo} 上方插入空行`);
    await afterLineOp(entry, { focusLine: Number(lineNo) + 1 }); // 原内容行被顶到 lineNo+1
  } catch (e) {
    const msg = t('Failed to insert line: {0}', [e.message]);
    log(msg);
    showErr(msg);
  }
}

/** 在第 lineNo 行下面插入一个空行（对比块里的「+行」） */
async function insertLineInFile(entry, lineNo) {
  pushSnapshot(entry);
  const abs = entry.file.absPath;
  if (!abs || !fs.existsSync(abs)) { return; }
  try {
    const lines = fs.readFileSync(abs, 'utf8').split('\n');
    const idx = Number(lineNo); // 插到该行之后（0 基 = lineNo）
    if (!(idx >= 0 && idx <= lines.length)) {
      vscode.window.showWarningMessage(t('Line number {0} is out of range; not inserted.', [lineNo]));
      return;
    }
    lines.splice(idx, 0, '');
    fs.writeFileSync(abs, lines.join('\n'), 'utf8');
    log(`[审查面板] 已在 ${entry.file.relPath}:${lineNo} 后插入空行`);
    await afterLineOp(entry, { focusLine: idx + 1 });
  } catch (e) {
    log(`插入行失败: ${e.message}`);
    vscode.window.showErrorMessage(t('Failed to insert line: {0}', [e.message]));
  }
}

/** 删除第 lineNo 行（对比块里的「删行」） */
/** 删除第 lineNo 行（对比块里的「删行」/ 键盘删行）。focusLine 为删完后要聚焦的行号（由面板在删前从 DOM 邻居算出） */
async function deleteLineInFile(entry, lineNo, focusLine) {
  pushSnapshot(entry);
  const abs = entry.file.absPath;
  if (!abs || !fs.existsSync(abs)) { return; }
  try {
    const lines = fs.readFileSync(abs, 'utf8').split('\n');
    const idx = Number(lineNo) - 1;
    if (!(idx >= 0 && idx < lines.length)) {
      vscode.window.showWarningMessage(t('Line number {0} is out of range; not deleted.', [lineNo]));
      return;
    }
    lines.splice(idx, 1);
    fs.writeFileSync(abs, lines.join('\n'), 'utf8');
    log(`[审查面板] 已删除 ${entry.file.relPath}:${lineNo}`);
    vscode.window.setStatusBarMessage(t('Deleted {0}:{1}', [entry.file.relPath, lineNo]), 2000);
    // 焦点落到「被删行上面的那一行」：diff 重算后行号会漂移，不能用删掉的行号硬指。
    const target = Number(focusLine) > 0 ? Number(focusLine) : Math.max(1, Number(lineNo) - 1);
    await afterLineOp(entry, { focusLine: target });
  } catch (e) {
    log(`删除行失败: ${e.message}`);
    vscode.window.showErrorMessage(t('Failed to delete line: {0}', [e.message]));
  }
}

/** 只还原某一块里的某一段改动（“上面一处修改没问题、下面一处删除要单独拒绝”的场景） */
async function clusterRestoreInFile(entry, hunkIndex, clusterIndex) {
  try {
    const res = await entry.source.provider.rejectCluster(entry.file, Number(hunkIndex), Number(clusterIndex), cfg().get('contextLines', 3));
    log(`已还原 ${entry.file.relPath} 第 ${Number(hunkIndex) + 1} 块的第 ${Number(clusterIndex) + 1} 段: ${res.message || ''}`);
    vscode.window.setStatusBarMessage(t('Reverted the change in {0}', [entry.file.relPath]), 3000);
  } catch (e) {
    const msg = t('Failed to revert this section: {0}', [e.message]);
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
  pushSnapshot(entry);
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
    vscode.window.showErrorMessage(t('Failed to delete selected lines: {0}', [e.message]));
  }
}

/** 在第 line 行下面插入多行（text 按换行拆开；粘贴恢复删除内容也用这里） */
async function insertLinesBelowInFile(entry, line, text) {
  pushSnapshot(entry);
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
    vscode.window.showErrorMessage(t('Failed to insert: {0}', [e.message]));
  }
}

/** 记录"应当高亮"的文件；若此刻树不可见/没渲染完，等可见或下次刷新后再补一次 reveal */
let pendingReveal = null;

// --------------------------------------------- 文件级撤销 / 重做（覆盖行内编辑、增删行、合并行）
const fileUndoStack = [];
const fileRedoStack = [];

/** 在任何写文件操作之前调用：把「改动前的文件内容」压入撤销栈 */
function pushSnapshot(entry) {
  try {
    const abs = entry && entry.file && entry.file.absPath;
    if (!abs || !fs.existsSync(abs)) { return; }
    const content = fs.readFileSync(abs, 'utf8');
    const top = fileUndoStack[fileUndoStack.length - 1];
    if (top && top.abs === abs && top.content === content) { return; } // 与上一步相同，不重复记
    fileUndoStack.push({ abs, root: entry.source.root, relPath: entry.file.relPath, content });
    if (fileUndoStack.length > 80) { fileUndoStack.shift(); }
    fileRedoStack.length = 0; // 有新操作 → 重做栈作废
  } catch (e) { /* 记快照失败不影响主操作 */ }
}

async function undoFileOp(entry) { await restoreFrom(entry, fileUndoStack, fileRedoStack, t('Undo')); }
async function redoFileOp(entry) { await restoreFrom(entry, fileRedoStack, fileUndoStack, t('Redo')); }

async function restoreFrom(entry, from, to, word) {
  if (!entry) { return; }
  const abs = entry.file.absPath;
  let i = -1;
  for (let k = from.length - 1; k >= 0; k -= 1) {
    if (from[k].abs === abs) { i = k; break; }
  }
  if (i === -1) {
    vscode.window.setStatusBarMessage(t('No {0} operation available', [word]), 2000);
    return;
  }
  const snap = from.splice(i, 1)[0];
  try {
    if (!fs.existsSync(abs)) { throw new Error('文件已不存在'); }
    const cur = fs.readFileSync(abs, 'utf8');
    to.push({ abs, root: entry.source.root, relPath: entry.file.relPath, content: cur });
    fs.writeFileSync(abs, snap.content, 'utf8');
    log(`[审查面板] ${word} ${entry.file.relPath}`);
    vscode.window.setStatusBarMessage(t('{0} done: {1}', [word, entry.file.relPath]), 2000);
    await afterLineOp(entry, undefined);
  } catch (e) {
    const msg = t('{0} failed: {1}', [word, e.message]);
    log(msg);
    showErr(msg);
  }
}

/** 合并行：dir=up 把当前行并进上一行；dir=down 把下一行并进当前行 */
async function mergeLineInFile(entry, lineNo, dir, text) {
  pushSnapshot(entry);
  const abs = entry.file.absPath;
  if (!abs || !fs.existsSync(abs)) { return; }
  try {
    const lines = fs.readFileSync(abs, 'utf8').split('\n');
    const idx = Number(lineNo) - 1;
    if (!(idx >= 0 && idx < lines.length)) {
      vscode.window.showWarningMessage(t('Line number {0} is out of range; not merged.', [lineNo]));
      return;
    }
    if (dir === 'up') {
      if (idx === 0) { return; }
      const cur = typeof text === 'string' ? text : lines[idx];
      lines[idx - 1] = lines[idx - 1] + cur;
      lines.splice(idx, 1);
      fs.writeFileSync(abs, lines.join('\n'), 'utf8');
      log(`[审查面板] 已把 ${entry.file.relPath}:${lineNo} 并入上一行`);
      await afterLineOp(entry, { focusLine: lineNo - 1 });
      return;
    }
    if (idx + 1 >= lines.length) { return; } // 没有下一行可并
    const next = lines[idx + 1];
    lines[idx] = (typeof text === 'string' ? text : lines[idx]) + next;
    lines.splice(idx + 1, 1);
    fs.writeFileSync(abs, lines.join('\n'), 'utf8');
    log(`[审查面板] 已把 ${entry.file.relPath}:${lineNo + 1} 并入上一行`);
    await afterLineOp(entry, { focusLine: lineNo });
  } catch (e) {
    const msg = `合并行失败：${e.message}`;
    log(msg);
    showErr(msg);
  }
}

/** 行级编辑后的收尾：只复查这一个文件（全量刷新太重，行内编辑会明显卡顿）+ 面板重渲染 */
async function afterLineOp(entry, opts) {
  await refreshSingleEntry(entry);
  provider.refresh();
  updateBadges();
  if (panel && panel.entry && sameEntry(panel.entry, entry)) {
    const f = opts && opts.focusLine ? { focusLine: Number(opts.focusLine) } : undefined;
    await panel.reload(f);
  }
}

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

/**
 * 在树节点上标记当前正在审查的文件（description 里显示「◀ 审查中」）。
 * 注意：这个状态必须跨刷新保持。source 对象在每次全量刷新时都会重建，
 * 如果只挂在 source 上，自动刷新（默认 5s）/手动刷新/保存文件触发的刷新都会把标记清掉 ——
 * 表现就是「提示自己消失了，可用户其实还在审这个文件」。所以这里存模块级引用，刷新时重新挂回去。
 */
let activeFileRef = null; // { root, relPath } | null

function setActiveFile(entry) {
  if (!entry || !entry.source) { return; }
  const af = { root: entry.source.root, relPath: entry.file.relPath };
  const same = activeFileRef
    && platform.normalizeForCompare(activeFileRef.root) === platform.normalizeForCompare(af.root)
    && platform.toGitPath(activeFileRef.relPath) === platform.toGitPath(af.relPath);
  activeFileRef = af;
  entry.source.activeFile = af;
  if (!same) { provider.refresh(); } // 换了文件才需要重渲染树
}

/** 审查结束（面板被关掉）：清掉「审查中」标记 */
function clearActiveFile() {
  if (!activeFileRef) { return; }
  activeFileRef = null;
  for (const s of model.sources) { s.activeFile = null; }
  provider.refresh();
}

/** 全量刷新后把「审查中」标记重新挂到对应的新 source 对象上 */
function reapplyActiveFile(sources) {
  if (!activeFileRef) { return; }
  const root = platform.normalizeForCompare(activeFileRef.root);
  const rel = platform.toGitPath(activeFileRef.relPath);
  const hit = sources.find((s) => platform.normalizeForCompare(s.root) === root);
  if (!hit) { activeFileRef = null; return; } // 来源没了（仓库被移除等），标记一并清掉
  const stillThere = hit.files.some((f) => platform.toGitPath(f.relPath) === rel);
  if (!stillThere) { activeFileRef = null; return; } // 文件已不在列表（审查完/被排除），标记清掉
  hit.activeFile = activeFileRef;
}

async function nextUnreviewed(entry) {
  // 不加防重入锁：锁曾在异常路径卡死导致按钮"只有第一次生效"。
  // 每一步都写日志，出错弹窗 + 自动打开输出面板，绝不静默。
  try {
    log(`[next] 点击，当前文件=${entry ? entry.file.relPath : '(无)'}，总改动=${model.flat.length}`);
    await nextUnreviewedInner(entry);
  } catch (e) {
    const msg = t('Failed to go to next unreviewed: {0}', [e.message]);
    log(msg);
    outputChannel.show(true);
    showErr(msg);
  }
}

async function nextUnreviewedInner(entry) {
  if (!model.flat.length) {
    log('[next] 没有任何改动，提示后返回');
    vscode.window.showInformationMessage(t('No changes pending review'));
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
    const done = t('All files reviewed ✓');
    panel.panel.webview.html = `<html><body style="font-family:var(--vscode-font-family,sans-serif);padding:40px;font-size:15px;opacity:.8">${done}</body></html>`;
    panel.entry = null;
  }
  vscode.window.showInformationMessage(t('All files reviewed ✓'));
}

/**
 * 面板右键/按钮：把一个文件快捷写入 .crignore。
 * 规则基准 = **该 .crignore 所在的目录**，也就是包含该文件的那个打开目录。
 * 这与 .gitignore 完全一致：某个忽略文件里的规则，匹配的是「相对该忽略文件所在目录」的路径。
 * （provider 端对项目忽略文件按各自 base 锚定匹配，见 util.matchExcludeSets。）
 */
async function blockFile(entry) {
  if (!entry) { return; }
  const folders = vscode.workspace.workspaceFolders || [];
  const abs = entry.file.absPath;
  const srcRoot = entry.source && entry.source.root ? entry.source.root : null;
  // .crignore 落盘目录：优先「包含该文件的工作区目录」，否则来源根
  let target = folders.find((f) => relToFolder(f.uri.fsPath, abs) !== null);
  if (!target && srcRoot && relToFolder(srcRoot, abs) !== null) {
    log(`[blockFile] ${abs} 不在任何工作区目录下，.crignore 写到来源根 ${srcRoot}`);
    target = { uri: { fsPath: srcRoot } };
  }
  if (!target) {
    vscode.window.showWarningMessage(t('Could not compute the relative path of {0}; .crignore not written', [entry.file.relPath]));
    return;
  }
  // 规则 = 相对「该 .crignore 所在目录」的路径（同 .gitignore 语义）
  const rel = relToFolder(target.uri.fsPath, abs) || entry.file.relPath;
  let res = 'added';
  try {
    res = appendIgnoreRule(target.uri.fsPath, rel);
  } catch (e) {
    log(`写入 .crignore 失败：${e.message}`);
    showErr(t('Failed to write .crignore: {0}', [e.message]));
    return;
  }
  log(`[blockFile] 规则=${rel}（基准=.crignore 所在目录 ${target.uri.fsPath}）→ ${path.join(target.uri.fsPath, '.crignore')} (${res})`);
  // doRefresh 在已有刷新进行中会直接 return（refreshing 锁）→ 那样列表还是旧的，看起来像"没生效"。
  // 先等当前刷新结束，再强制重建一次，确保新规则立刻起作用。
  for (let i = 0; i < 40 && refreshing; i += 1) { await new Promise((r) => setTimeout(r, 50)); }
  forceRedetect = true;
  await doRefresh(true);
  provider.refresh();
  updateBadges();
  const gone = !findEntry(entry.source.root, entry.file.relPath);
  if (res === 'exists') {
    vscode.window.setStatusBarMessage(t('{0} is already in .crignore', [rel]), 3000);
  } else {
    vscode.window.setStatusBarMessage(t('Ignored {0}', [rel]), 3000);
  }
  if (!gone) {
    // 写进去了但列表里还在：把真实原因记到日志，别让用户只看到「没生效」
    log(`[blockFile] 警告：规则已写入，但 ${entry.file.relPath} 仍在列表中（规则=${rel}，基准=${target.uri.fsPath}）`);
  }
  // 屏蔽后当前文件已不在列表 → 自动跳下一个待审查，不留在空面板
  if (gone) {
    await nextUnreviewed(null);
  }
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
  unacceptHunk: async (entry, index, sig) => { await unacceptHunk(entry, index, sig); },
  toggleReviewed: async (entry) => {
    // 面板里的「标记已审查 / 取消」= git 暂存的显式入口：勾上 add、取消 reset
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
    // 打钩之后自动去下一个待审查
    if (value) { await advanceAfterReviewed(entry); }
  },
  openInEditor: async (entry, line) => { await openBaseDiff(entry, line); },
  editLine: async (entry, line, text, insertBelow, focusLine, opts) => { await editLineInFile(entry, line, text, insertBelow, focusLine, opts); },
  insertLine: async (entry, line) => { await insertLineInFile(entry, line); },
  insertAbove: async (entry, line) => { await insertLineAboveInFile(entry, line); },
  mergeLine: async (entry, line, dir, text) => { await mergeLineInFile(entry, line, dir, text); },
  undoFile: async (entry) => { await undoFileOp(entry); },
  redoFile: async (entry) => { await redoFileOp(entry); },
  saveNow: async (entry) => { vscode.window.setStatusBarMessage(t('All changes written to {0} in real time', [entry.file.relPath]), 2000); },
  deleteLine: async (entry, line, focusLine) => { await deleteLineInFile(entry, line, focusLine); },
  clusterRestore: async (entry, hunk, clus) => { await clusterRestoreInFile(entry, hunk, clus); },
  deleteLines: async (entry, lines) => { await deleteLinesInFile(entry, lines); },
  insertLinesBelow: async (entry, line, text) => { await insertLinesBelowInFile(entry, line, text); },
  copyText: async (text) => {
    // 复制走扩展宿主写剪贴板（webview 内 execCommand('copy') 不稳定）
    try { await vscode.env.clipboard.writeText(String(text == null ? '' : text)); }
    catch (e) { log(`写剪贴板失败：${e.message}`); }
  },
  next: async (entry) => { await nextUnreviewed(entry); },
  panelDisposed: () => { clearActiveFile(); },
  ctxCmd: async (entry, cmd) => {
    switch (cmd) {
      case 'openDiff': await openBaseDiff(entry); break;
      case 'accept': await acceptFile(entry); break;
      case 'reject': await rejectFile(entry); break;
      case 'mark': await handlers.toggleReviewed(entry); break;
      case 'blockFile': await blockFile(entry); break;
      case 'refresh': await doRefresh(true); provider.refresh(); updateBadges(); break;
      default: log(`[panel] 未知右键命令: ${cmd}`);
    }
  }
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
  // 单文件复查后也顺手对账一次：挡住"块都打钩了却没标记"的漏网情况
  await reconcileDecidedFiles();
  return false;
}

/**
 * 把该文件当前所有改动块一次性记为「已接受」。
 * 用于「接受全部」：文件打了钩，块级状态也得跟上，
 * 否则取消审查后所有块又变回待审查（用户反馈的 bug）。
 * 返回记下的块数。
 */
async function markAllHunksAccepted(entry) {
  try {
    const t = await entry.source.provider.getDiff(entry.file, cfg().get('contextLines', 3));
    const parsed = parseDiff(t)[0];
    const hunks = parsed ? parsed.hunks : [];
    const root = entry.source.root;
    const rel = entry.file.relPath;
    for (const h of hunks) {
      const sig = hunkSignature(h);
      await store.setHunkReviewed(root, rel, sig, true);
      await store.setHunkRejected(root, rel, sig, false);
    }
    log(`[acceptAll] ${rel} 已把 ${hunks.length} 个改动块记为已接受`);
    return hunks.length;
  } catch (e) {
    log(`[acceptAll] ${entry.file.relPath} 标记改动块失败：${e.message}`);
    return 0;
  }
}

/** 把该文件当前所有改动块一次性记为「已拒绝」 */
async function markAllHunksRejected(entry) {
  try {
    const t = await entry.source.provider.getDiff(entry.file, cfg().get('contextLines', 3));
    const parsed = parseDiff(t)[0];
    const hunks = parsed ? parsed.hunks : [];
    const root = entry.source.root;
    const rel = entry.file.relPath;
    for (const h of hunks) {
      const sig = hunkSignature(h);
      await store.setHunkRejected(root, rel, sig, true);
      await store.setHunkReviewed(root, rel, sig, false);
    }
    log(`[rejectAll] ${rel} 已把 ${hunks.length} 个改动块记为已拒绝`);
    return hunks.length;
  } catch (e) {
    log(`[rejectAll] ${entry.file.relPath} 标记改动块失败：${e.message}`);
    return 0;
  }
}

/** 清掉该文件的块级决定（文件被整体还原/删除后这些记录就没意义了） */
async function clearHunkDecisions(entry) {
  try {
    await store.clearRejectedHunks(entry.source.root, entry.file.relPath);
    const acc = store.getReviewedHunks(entry.source.root, entry.file.relPath);
    for (const sig of Object.keys(acc)) {
      await store.setHunkReviewed(entry.source.root, entry.file.relPath, sig, false);
    }
  } catch (e) {
    log(`[clearHunks] ${entry.file.relPath} 清理块级决定失败：${e.message}`);
  }
}

/**
 * 接受全部：把文件标记已审查，并把当前所有改动块记为已接受。
 * 不 git add / 不改文件内容（0.4.5 语义：接受=判断；暂存只发生在显式打勾时）
 */
/**
 * 接受全部：记录所有块为已接受，随后自动标记已审查（执行统一发生在标记那一刻：git add）。
 */
async function acceptFile(entry) {
  const p = entry.source.provider;
  const n = await markAllHunksAccepted(entry);
  // 所有块都有决定了 → 立即走自动标记（= 用户语义：处理完就标记；git add 在标记那一刻发生）
  await store.clearAutoMarkOff(entry.source.root, entry.file.relPath);
  log(`[acceptAll] ${entry.file.relPath} 已记录接受全部（${n} 块），自动标记已审查`);
  const marked = await autoMarkWhenAllHunksDone(entry);
  if (!marked) {
    await revealInTree(entry, 6);
    if (panel && panel.entry && sameEntry(panel.entry, entry)) { await panel.reload(); }
    else { provider.refresh(); }
    updateBadges();
    vscode.window.showInformationMessage(t('Accepted all changes in {0}', [entry.file.relPath]));
  }
}

/**
 * 拒绝全部：**只记录决定**，不改文件、不标记已审查。
 * 还原（含未跟踪文件删除）推迟到「标记为已审查」时由 applyPendingRejects 执行。
 */
async function rejectFile(entry) {
  const p = entry.source.provider;
  const kind = entry.file.kind;
  const isNew = kind === 'untracked' || kind === 'added';
  const n = await markAllHunksRejected(entry);
  // 所有块都有决定了 → 立即走自动标记（还原在标记那一刻执行）
  await store.clearAutoMarkOff(entry.source.root, entry.file.relPath);
  log(`[rejectAll] ${entry.file.relPath} 已记录拒绝全部（${n} 块），自动标记已审查`);
  const marked = await autoMarkWhenAllHunksDone(entry);
  if (!marked) {
    await revealInTree(entry, 6);
    if (panel && panel.entry && sameEntry(panel.entry, entry)) { await panel.reload(); }
    else { provider.refresh(); }
    updateBadges();
    vscode.window.showInformationMessage(t('Rejected all changes in {0}', [entry.file.relPath]));
  }
}

/** 校验点击的块与当前 diff 是否一致（文件被编辑过时索引会漂移） */
async function verifyHunkSig(entry, index, sig) {
  if (!sig) { return true; }
  const t = await entry.source.provider.getDiff(entry.file, cfg().get('contextLines', 3));
  const parsed = parseDiff(t)[0];
  const hunks = parsed ? parsed.hunks : [];
  return !!hunks[index] && hunkSignature(hunks[index]) === sig;
}

async function rejectHunk(entry, index, sig) {
  if (sig && !(await verifyHunkSig(entry, index, sig))) {
    vscode.window.showWarningMessage(t('The file content changed and the block position no longer matches. Please wait for refresh and retry.'));
    return;
  }
  // 只记录拒绝决定，不立即改文件——和接受块对称：执行统一发生在「标记已审查」时，
  // 之前随时可以撤销拒绝（反悔机会）
  await store.setHunkRejected(entry.source.root, entry.file.relPath, sig, true);
  await store.setHunkReviewed(entry.source.root, entry.file.relPath, sig, false); // 从已接受表移除（若之前接受过）
  // 用户又开始动手处理块了 → 解除「手动取消审查」的自动标记抑制（否则处理完了也不会自动打钩）
  await store.clearAutoMarkOff(entry.source.root, entry.file.relPath);
  log(`已记录拒绝 ${entry.file.relPath} 第 ${index + 1} 块 (sig=${sig})，标记已审查时执行还原`);
  await autoMarkWhenAllHunksDone(entry);
  if (panel && panel.entry && sameEntry(panel.entry, entry)) { await panel.reload(); }
  vscode.window.setStatusBarMessage(t('Rejected change block {0} in {1} (revert runs when marked as reviewed)', [index + 1, entry.file.relPath]), 4000);
}

/** 撤销某个块的拒绝决定（反悔） */
async function unrejectHunk(entry, index, sig) {
  await store.setHunkRejected(entry.source.root, entry.file.relPath, sig, false);
  log(`已撤销拒绝 ${entry.file.relPath} 第 ${index + 1} 块`);
  if (panel && panel.entry && sameEntry(panel.entry, entry)) { await panel.reload(); }
}

/** 取消某个块的「已接受」决定（和「撤销拒绝」对称；取消后该块回到"待审查"） */
async function unacceptHunk(entry, index, sig) {
  await store.setHunkReviewed(entry.source.root, entry.file.relPath, sig, false);
  log(`已取消接受 ${entry.file.relPath} 第 ${index + 1} 块`);
  if (panel && panel.entry && sameEntry(panel.entry, entry)) { await panel.reload(); }
  vscode.window.setStatusBarMessage(t('Cancelled acceptance of change block {0} in {1}', [index + 1, entry.file.relPath]), 3000);
}

/**
 * 执行某文件所有待执行的拒绝块（**只在标记为已审查时调用**）。
 * 从最后一个块往前还原，避免 index 漂移。
 * 「全部块都被拒绝」= 整文件放弃 → 交给 provider 的整文件还原
 * （未跟踪/新增文件会被删除，逐块还原做不到这一点）。
 * 返回实际还原的块数；-1 表示执行失败（调用方不应继续标记）。
 */
async function applyPendingRejects(entry) {
  try {
    const table = store.getRejectedHunks(entry.source.root, entry.file.relPath);
    const sigs = Object.keys(table);
    if (!sigs.length) { return 0; }
    const p = entry.source.provider;
    const diffText = await p.getDiff(entry.file, cfg().get('contextLines', 3));
    const parsed = parseDiff(diffText)[0];
    const hunks = parsed ? parsed.hunks : [];
    const allRejected = hunks.length > 0 && hunks.every((h) => table[hunkSignature(h)]);
    if (allRejected) {
      const res = await p.rejectFile(entry.file);
      await store.clearRejectedHunks(entry.source.root, entry.file.relPath);
      await clearHunkDecisions(entry);
      const msg = t('Executed full-file rejection of {0} ({1} blocks rejected)', [entry.file.relPath, hunks.length]);
      log(msg);
      vscode.window.setStatusBarMessage(msg, 3000);
      return hunks.length;
    }
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
      vscode.window.setStatusBarMessage(t('Reverted {0} rejected blocks in {1}', [applied, entry.file.relPath]), 3000);
    }
    return applied;
  } catch (e) {
    const msg = t('Failed to execute rejected blocks: {0}', [e.message]);
    log(msg);
    showErr(msg);
    return -1; // 拒绝块没执行成功就不标记已审查，保持状态一致
  }
}

async function currentSig(entry, index) {
  try {
    const t = await entry.source.provider.getDiff(entry.file, cfg().get('contextLines', 3));
    const parsed = parseDiff(t)[0];
    const hunks = parsed ? parsed.hunks : [];
    return hunks[index] ? hunkSignature(hunks[index]) : null;
  } catch (e) {
    return null;
  }
}

async function acceptHunk(entry, index, sig) {
  if (sig && !(await verifyHunkSig(entry, index, sig))) {
    vscode.window.showWarningMessage(t('The file content changed and the block position no longer matches. Please wait for refresh and retry.'));
    return;
  }
  try {
    await entry.source.provider.acceptHunk(entry.file, index, cfg().get('contextLines', 3));
  } catch (e) {
    const msg = t('Failed to accept change block {0}: {1}', [index + 1, e.message]);
    log(msg);
    showErr(msg);
    return;
  }
  await store.setHunkReviewed(entry.source.root, entry.file.relPath, sig, true);
  await store.setHunkRejected(entry.source.root, entry.file.relPath, sig, false); // 改主意：从拒绝表移除
  // 用户又开始动手处理块了 → 解除「手动取消审查」的自动标记抑制（否则处理完了也不会自动打钩）
  await store.clearAutoMarkOff(entry.source.root, entry.file.relPath);
  log(`已接受 ${entry.file.relPath} 第 ${index + 1} 块 (sig=${sig})`);
  // 接受只动暂存区/标记，工作区内容没变：不需要整表重扫
  await autoMarkWhenAllHunksDone(entry);
  if (panel && panel.entry && sameEntry(panel.entry, entry)) { await panel.reload(); }
  vscode.window.setStatusBarMessage(t('Accepted change block {0} in {1}', [index + 1, entry.file.relPath]), 3000);
}

/** 一个文件的所有改动块都有决定（接受或拒绝）→ 自动标记已审查（拒绝块在此刻执行还原）。返回是否真的标记了 */
async function autoMarkWhenAllHunksDone(entry) {
  const fresh = findEntry(entry.source.root, entry.file.relPath);
  if (!fresh || fresh.file.reviewed) { return false; }
  if (store.isAutoMarkOff(fresh.source.root, fresh.file.relPath, fresh.file.hash)) {
    log(`[autoMark] ${fresh.file.relPath} 已被手动取消审查，暂停自动标记（文件改动后恢复）`);
    return false;
  }
  try {
    const t = await fresh.source.provider.getDiff(fresh.file, cfg().get('contextLines', 3));
    const parsed = parseDiff(t)[0];
    const hunks = parsed ? parsed.hunks : [];
    if (!hunks.length) {
      log(`[autoMark] ${fresh.file.relPath} 当前解析不到改动块，跳过自动标记`);
      return false;
    }
    const acc = store.getReviewedHunks(fresh.source.root, fresh.file.relPath);
    const rej = store.getRejectedHunks(fresh.source.root, fresh.file.relPath);
    const pending = hunks.filter((h) => { const s = hunkSignature(h); return !(acc[s] || rej[s]); });
    if (pending.length) {
      log(`[autoMark] ${fresh.file.relPath} 还有 ${pending.length}/${hunks.length} 个块未决定，暂不标记`);
      return false;
    }
    await setReviewed(fresh, true); // 内部会执行所有待执行的拒绝块（还原）
    await refreshSingleEntry(fresh); // 拒绝执行后文件可能已无差异 → 从列表移除
    provider.refresh();
    updateBadges();
    log(`${fresh.file.relPath} 全部改动块已决定（接受/拒绝），自动标记已审查`);
    // 标记完就自动去下一个待审查：文件已无差异的情况 refreshSingleEntry 已经跳过了，
    // 这里处理"文件还在列表里（改动都接受了）"的情况。
    if (findEntry(fresh.source.root, fresh.file.relPath)) {
      await advanceAfterReviewed(fresh);
    } else if (panel && panel.entry && sameEntry(panel.entry, fresh)) {
      await panel.reload();
    }
    return true;
  } catch (e) {
    log(`自动打钩检查失败：${e.message}`);
    return false;
  }
}

/**
 * 兜底对账：把「所有改动块都已决定（接受/拒绝）但没被标记已审查」的文件补上标记。
 * 触发时机太多（块级点击、面板重渲染、自动刷新换掉了 model 对象、撤销拒绝…），
 * 只靠点击那一刻的检查容易漏；这里在每次刷新收尾统一对账一次，保证「全打钩」= 已审查。
 * 只处理 store 里记过块决定的文件，代价很小。
 */
let reconciling = false;
async function reconcileDecidedFiles() {
  if (reconciling) { return; }
  reconciling = true;
  try {
    for (const e of model.flat.slice()) {
      if (e.file.reviewed) { continue; }
      const root = e.source.root;
      const rel = e.file.relPath;
      // 用户手动取消审查过（且文件还没再改）→ 尊重用户，不要自动打回去
      if (store.isAutoMarkOff(root, rel, e.file.hash)) { continue; }
      const acc = store.getReviewedHunks(root, rel);
      const rej = store.getRejectedHunks(root, rel);
      if (!Object.keys(acc).length && !Object.keys(rej).length) { continue; } // 没块决定，跳过
      try {
        const t = await e.source.provider.getDiff(e.file, cfg().get('contextLines', 3));
        const parsed = parseDiff(t)[0];
        const hunks = parsed ? parsed.hunks : [];
        if (!hunks.length) { continue; }
        const allDone = hunks.every((h) => { const s = hunkSignature(h); return acc[s] || rej[s]; });
        if (!allDone) { continue; }
        log(`[对账] ${rel} 所有改动块都已决定但未标记 → 补标记已审查`);
        await setReviewed(e, true);
        await refreshSingleEntry(e);
      } catch (err) {
        log(`[对账] ${rel} 失败：${err.message}`);
      }
    }
    provider.refresh();
    updateBadges();
  } finally {
    reconciling = false;
  }
}

// ------------------------------------------------------------ 基准快照命令
async function initBaseline(arg) {
  const src = resolveSource(arg) || model.sources.find((s) => s.provider.id === 'snapshot');
  if (!src) {
    vscode.window.showInformationMessage(t('No project directory available to set a baseline.'));
    return;
  }
  if (src.provider.id !== 'snapshot') {
    vscode.window.showInformationMessage(
      t('This project is managed by {0}; its comparison baseline is {1}, so manual initialization is not needed.', [src.provider.label, src.provider.baseLabel])
    );
    return;
  }
  const info = src.provider.baselineInfo();
  const setBaseline = t('Set baseline');
  const answer = await vscode.window.showWarningMessage(
    info
      ? t('Rebuild the comparison baseline from the current file state (this overwrites the existing baseline; records of {0} files will be replaced). Continue?', [info.fileCount])
      : t('Record the current file state of {0} as the comparison baseline; changes will then be shown against it. Continue?', [src.root]),
    { modal: true },
    setBaseline
  );
  if (answer !== setBaseline) { return; }
  try {
    const res = src.provider.initBaseline();
    log(`已建立基准：${src.root}（${res.fileCount} 个文件）`);
  } catch (e) {
    vscode.window.showErrorMessage(t('Failed to set baseline: {0}', [e.message]));
    return;
  }
  await doRefresh(false);
  vscode.window.showInformationMessage(t('Current state set as the comparison baseline ({0})', [src.root]));
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
    vscode.window.showInformationMessage(t('No project directory available to update the baseline.'));
    return;
  }
  if (!src.provider.capabilities.baselineUpdate) {
    vscode.window.showInformationMessage(
      t('This project is managed by {0}; its baseline is determined by the version control system ({1}), so manual update is not needed.', [src.provider.label, src.provider.baseLabel])
    );
    return;
  }
  const only = entry ? [entry.file.relPath] : null;
  const updateBaselineLabel = t('Update baseline');
  const answer = await vscode.window.showWarningMessage(
    only
      ? t('Set the current content of {0} as the new comparison baseline? The file will no longer be shown as changed.', [only[0]])
      : t('Set the current state of all files as the new comparison baseline? All files will no longer be shown as changed.'),
    { modal: true },
    updateBaselineLabel
  );
  if (answer !== updateBaselineLabel) { return; }
  try {
    src.provider.updateBaseline(only);
    log(`已更新基准：${src.root}${only ? ' (' + only.join(',') + ')' : '（全部）'}`);
  } catch (e) {
    vscode.window.showErrorMessage(t('Failed to update baseline: {0}', [e.message]));
    return;
  }
  await doRefresh(false);
  vscode.window.showInformationMessage(only ? t('Updated baseline for {0}', [only[0]]) : t('Updated comparison baseline'));
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
      t('Change Review detected that the workspace is in a remote/WSL environment, but the extension is running on the local Windows host. Please click "Install in WSL" in the extensions panel to install the extension into the remote, otherwise git/svn paths and file operations will behave abnormally.'),
      t('Got it')
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
        const msg = t('Command {0} failed: {1}', [cmd, e && e.message ? e.message : e]);
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
      vscode.window.showInformationMessage(t('Please open a folder first, then configure exclude rules.'));
      return;
    }
    let target = folders[0];
    if (folders.length > 1) {
      const pick = await vscode.window.showQuickPick(
        folders.map((f) => ({ label: f.name || f.uri.fsPath, fsPath: f.uri.fsPath })),
        { placeHolder: t('Select the folder to configure exclude rules for') }
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
      vscode.window.showInformationMessage(t('Created .crignore: one glob per line; takes effect after save.'));
    }
  });
  register('changeReview.blockFile', async (arg) => {
    const entry = resolveArg(arg);
    if (entry) { await blockFile(entry); }
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
    await setReviewed(entry, true); // 这一步才执行：还原被拒绝的块/文件 + git add
    // 拒绝块执行后文件可能已无差异 → 单文件复查把它移出列表（内部也会处理面板）
    await refreshSingleEntry(entry);
    provider.refresh();
    updateBadges();
    vscode.window.setStatusBarMessage(t('Marked {0} as reviewed', [entry.file.relPath]), 3000);
    if (!findEntry(entry.source.root, entry.file.relPath)) { return; } // 已无差异，refreshSingleEntry 已跳下一个
    if (panel && panel.entry && sameEntry(panel.entry, entry)) { await panel.reload(); }
    await advanceAfterReviewed(entry);
  });
  register('changeReview.unmarkReviewed', async (arg) => {
    const entry = resolveArg(arg);
    if (!entry) { return; }
    await setReviewed(entry, false);
    provider.refresh();
    updateBadges();
    vscode.window.setStatusBarMessage(t('Cleared the review mark on {0}', [entry.file.relPath]), 3000);
  });
  register('changeReview.markAllReviewed', async () => {
    if (!model.flat.length) {
      vscode.window.showInformationMessage(t('No changes pending review'));
      return;
    }
    // 走 setReviewed：git 工程随标记执行 git add（与核心规则一致），拒绝块在此刻还原
    for (const e of model.flat.slice()) { await setReviewed(e, true); }
    provider.refresh();
    updateBadges();
    vscode.window.setStatusBarMessage(t('Marked {0} files as reviewed', [model.flat.length]), 3000);
  });
  register('changeReview.clearReviewed', async () => {
    for (const e of model.flat.slice()) { await setReviewed(e, false); }
    provider.refresh();
    updateBadges();
    vscode.window.setStatusBarMessage(t('Cleared all reviewed marks'), 3000);
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

module.exports = { activate, deactivate, __test: { t, zhDict } };
