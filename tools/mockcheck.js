'use strict';

/**
 * 用 mock 的 vscode API 跑一遍扩展主流程（树视图 / 徽章 / 复选框 / 审查面板）。
 * 运行：node tools/mockcheck.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log(`  ✓ ${name}`); } else { failures += 1; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
}

// ---------- mock vscode ----------
class EventEmitter {
  constructor() { this.listeners = []; this.event = (l) => { this.listeners.push(l); return { dispose() {} }; }; }
  fire(e) { this.listeners.forEach((l) => l(e)); }
}
class TreeItem {
  constructor(label, state) { this.label = label; this.collapsibleState = state; }
}
class ThemeIcon { constructor(id) { this.id = id; } }
class MarkdownString { constructor(v) { this.value = v; } }
class Position { constructor(l, c) { this.line = l; this.character = c; } }
class Range { constructor(a, b) { this.a = a; this.b = b; } }
class Selection { constructor(a, b) { this.a = a; this.b = b; } }
const Uri = {
  file: (p) => ({ scheme: 'file', fsPath: p, path: p.replace(/\\/g, '/'), toString: () => `file:///${p.replace(/\\/g, '/')}` }),
  from: (o) => ({ scheme: o.scheme, path: o.path, query: o.query || '', toString: () => `${o.scheme}://${o.path}?${o.query || ''}` })
};

let treeView = null;
let statusBar = null;
let lastPanel = null;
const registered = new Map();
const config = {
  includeUntracked: true,
  sortReviewedLast: true,
  autoRefreshInterval: 0,
  contextLines: 3,
  showStatusBar: true
};

const vscode = {
  EventEmitter, TreeItem, ThemeIcon, MarkdownString, Position, Range, Selection, Uri,
  version: '1.136.1',
  env: { remoteName: undefined, uiKind: 1, language: 'zh-cn' },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  TreeItemCheckboxState: { Unchecked: 0, Checked: 1 },
  ViewColumn: { Active: -1 },
  StatusBarAlignment: { Left: 1 },
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({ get: (k, d) => (config[k] === undefined ? d : config[k]) }),
    onDidSaveTextDocument: () => ({ dispose() {} }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
    registerTextDocumentContentProvider: (scheme, provider) => { vscode._headProvider = provider; return { dispose() {} }; },
    openTextDocument: (p) => Promise.resolve({ uri: { fsPath: typeof p === 'string' ? p : (p && p.fsPath) }, languageId: 'ignore' })
  },
  window: {
    activeTextEditor: null,
    activeTextEditor: null,
    createOutputChannel: () => {
      const ch = { lines: [], appendLine(s) { this.lines.push(s); }, clear() { this.lines.length = 0; }, show() {}, dispose() {} };
      vscode._output = ch;
      return ch;
    },
    setStatusBarMessage: (m) => { vscode._statusMsgs.push(m); return { dispose() {} }; },
    createTreeView: (id, opts) => {
      treeView = {
        id, opts, badge: undefined, message: undefined, selection: [], visible: true,
        onDidChangeCheckboxState: (l) => { treeView._cbListener = l; return { dispose() {} }; },
        dispose() {}
      };
      return treeView;
    },
    createStatusBarItem: () => {
      statusBar = { text: '', tooltip: '', command: '', show() { this.shown = true; }, hide() { this.shown = false; }, dispose() {} };
      return statusBar;
    },
    createWebviewPanel: (type, title, col, options) => {
      lastPanel = {
        title: '', visible: true, _options: options || {},
        webview: { html: '', cspSource: 'vscode-webview:', onDidReceiveMessage: (l) => { lastPanel._msg = l; } },
        onDidDispose: (l) => { lastPanel._dispose = l; },
        reveal() { lastPanel.revealed = true; },
        dispose() {}
      };
      return lastPanel;
    },
    showTextDocument: (uri, opts) => {
      const doc = { uri, opts, selection: null, revealRange() { doc.revealed = true; } };
      vscode._openedDocs.push(doc);
      return Promise.resolve(doc);
    },
    showInformationMessage: (m) => { vscode._infos.push(m); return Promise.resolve(undefined); },
    showErrorMessage: (m) => { vscode._errors.push(m); return Promise.resolve(undefined); },
    showWarningMessage: (m, o, btn) => { vscode._warns.push(m); return Promise.resolve(btn); }
  },
  commands: {
    registerCommand: (id, fn) => { registered.set(id, fn); return { dispose() {} }; },
    executeCommand: (id, ...args) => { vscode._executed.push([id, args]); return Promise.resolve(); }
  },
  _infos: [], _errors: [], _warns: [], _executed: [], _statusMsgs: [], _output: null, _openedDocs: []
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') { return vscode; }
  return origLoad.apply(this, arguments);
};

// ---------- 临时仓库 ----------
const ROOT = path.join(os.tmpdir(), `cr-mock-${Date.now()}`);
function g(args) { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }); }
function write(rel, content) {
  const p = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

async function main() {
  fs.mkdirSync(ROOT, { recursive: true });
  g(['init', '-q']);
  g(['config', 'user.email', 'm@check.local']);
  g(['config', 'user.name', 'Mock Check']);
  g(['config', 'core.autocrlf', 'false']);
  g(['config', 'commit.gpgsign', 'false']);
  write('src/a.js', Array.from({ length: 20 }, (_, i) => `const v${i} = ${i};`).join('\n') + '\n');
  write('old.txt', 'x\n');
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'init']);
  write('src/a.js', Array.from({ length: 20 }, (_, i) => (i === 1 ? `const v1 = 999;` : `const v${i} = ${i};`)).join('\n') + '\n');
  fs.unlinkSync(path.join(ROOT, 'old.txt'));
  write('new.txt', 'hello\nworld\n');

  vscode.workspace.workspaceFolders = [{ uri: Uri.file(ROOT) }];
  const stateStore = {};
  const context = {
    subscriptions: [],
    workspaceState: {
      get: (k, d) => (stateStore[k] === undefined ? d : stateStore[k]),
      update: (k, v) => { stateStore[k] = v; return Promise.resolve(); }
    }
  };

  const ext = require('../src/extension.js');
  await ext.activate(context);

  console.log('\n[1] 激活与树视图');
  const roots = await treeView.opts.treeDataProvider.getChildren();
  check('列出 3 个改动文件', roots.length === 3, JSON.stringify(roots.map((n) => n.file.relPath)));
  check('文件名正确', roots.some((n) => n.label === 'a.js') && roots.some((n) => n.label === 'new.txt'));
  check('带 +N −M 描述', /\+1 −1/.test(roots.find((n) => n.label === 'a.js').description), roots.find((n) => n.label === 'a.js').description);
  check('复选框初始为未勾选', roots.every((n) => n.checkboxState === 0));
  check('点击命令已挂上', !!roots[0].command && roots[0].command.command === 'changeReview.openReview');

  console.log('\n[2] 徽章与状态栏');
  check('视图角标 = 待审查数 3', treeView.badge && treeView.badge.value === 3, JSON.stringify(treeView.badge));
  check('状态栏显示 0/3 已审查', /0\/3/.test(statusBar.text), statusBar.text);
  check('状态栏已显示', statusBar.shown === true);

  console.log('\n[3] 勾选复选框');
  const a = roots.find((n) => n.label === 'a.js');
  // 监听器是 async（勾选=git add 是真实 I/O），必须等它返回，不能只 setImmediate
  await treeView._cbListener({ items: [[a, 1]] });
  await new Promise((r) => setTimeout(r, 80));
  const roots2 = await treeView.opts.treeDataProvider.getChildren();
  check('a.js 变为已审查', roots2.find((n) => n.label === 'a.js').file.reviewed === true);
  check('勾选已审查即 git add（a.js 进入暂存区）',
    /^M\s+src\/a\.js$/m.test(g(['status', '--porcelain'])), g(['status', '--porcelain']));
  check('角标降为 2', treeView.badge.value === 2, JSON.stringify(treeView.badge));
  check('状态栏显示 1/3', /1\/3/.test(statusBar.text), statusBar.text);
  check('审查状态已持久化', !!stateStore['changeReview.reviewed.v1'] && Object.keys(stateStore['changeReview.reviewed.v1']).length === 1);
  check('已审查项 contextValue 切换', roots2.find((n) => n.label === 'a.js').contextValue === 'changeReviewFileDone');

  console.log('\n[4] 再次修改文件后自动失效');
  fs.appendFileSync(path.join(ROOT, 'src/a.js'), '// touched\n', 'utf8');
  await registered.get('changeReview.refresh')();
  const roots3 = await treeView.opts.treeDataProvider.getChildren();
  check('a.js 打钩被自动取消', roots3.find((n) => n.label === 'a.js').file.reviewed === false);
  check('角标回到 3', treeView.badge.value === 3, JSON.stringify(treeView.badge));

  console.log('\n[5] 审查模式面板');
  await registered.get('changeReview.openReview')({ repoRoot: ROOT, relPath: 'src/a.js' });
  await new Promise((r) => setImmediate(r));
  check('面板已创建并聚焦', !!lastPanel && lastPanel.revealed === true);
  check('标题含文件名', /a\.js/.test(lastPanel.title), lastPanel.title);
  check('HTML 含文件路径', lastPanel.webview.html.includes('src/a.js'));
  check('HTML 含 diff 行', lastPanel.webview.html.includes('const v1 = 999;'));
  check('HTML 含接受/拒绝按钮', lastPanel.webview.html.includes('data-cmd="accept"') && lastPanel.webview.html.includes('data-cmd="reject"'));
  check('HTML 含块级还原按钮', lastPanel.webview.html.includes('data-cmd="hunkReject"'));
  check('HTML 有 CSP nonce', /script-src 'nonce-/.test(lastPanel.webview.html));
  check('webview 已开启 enableScripts（上一版就是漏了它导致按钮全死）', lastPanel._options.enableScripts === true,
    JSON.stringify(lastPanel._options));
  // 回归（0.4.7 bug）：buildHtml 是模板字符串，脚本内的 '\n' 会先被模板转义成真换行 →
  // 整段内联脚本语法错误 → 面板所有按钮/快捷键全失效。用 new Function 只解析不执行验证。
  const scriptMatch = lastPanel.webview.html.match(/<script[^>]*>([\s\S]*?)<\/script>/);
  let scriptOk = false;
  if (scriptMatch) {
    try { new Function(scriptMatch[1]); scriptOk = true; } catch (e) { scriptOk = false; }
  }
  check('面板内联脚本语法可解析（无转义破坏）', scriptOk, scriptMatch ? 'script len=' + scriptMatch[1].length : 'no script');
  check('HTML 含块级接受/拒绝按钮', lastPanel.webview.html.includes('hunkAccept') && lastPanel.webview.html.includes('hunkReject'));
  check('HTML 会上报 ready 消息', lastPanel.webview.html.includes("type: 'ready'"));
  // 接受/拒绝按钮文字精简，语义说明放在原生 title 上悬浮显示
  check('接受按钮语义放进悬浮提示（不再声明 git add）',
    /data-cmd="accept"[^>]*title="[^"]*标记为已审查[^"]*暂存[^"]*"/.test(lastPanel.webview.html),
    lastPanel.webview.html.match(/<button[^>]*data-cmd="accept"[^>]*>/)[0]);
  check('拒绝按钮文字是\"拒绝\"（语义已放进悬浮提示）', /data-cmd="reject"[^>]*title="[^"]*还原[^"]*"/.test(lastPanel.webview.html),
    lastPanel.webview.html.match(/<button[^>]*data-cmd="reject"[^>]*>/)[0]);
  check('面板不再含旧版\"在编辑器中打开\"按钮', !/在编辑器中打开/.test(lastPanel.webview.html));
  // 模拟 webview 加载完成后发出的 ready（真实环境由 webview 脚本自动发）
  await lastPanel._msg({ type: 'ready' });
  check('ready 消息被记录到 Output', vscode._output.lines.some((l) => /收到消息 type=ready/.test(l)));
  check('工具栏文件级接受/拒绝仍在', lastPanel.webview.html.includes('data-cmd="accept"') && lastPanel.webview.html.includes('data-cmd="reject"'));

  // 缩进跟随 VSCode 设置（0.4.12 bug：Tab 硬塞真 \t，insertSpaces 时被浏览器按 8 列渲染，
  // 表现为"设了 4 却给 8"）。这里做静态断言 + 算法边界验证。
  const indentM = lastPanel.webview.html.match(/window\.__CR_INDENT__ = (\{[^}]*\})/);
  check('面板注入了缩进设置 __CR_INDENT__', !!indentM, indentM ? indentM[1] : 'MISSING');
  if (indentM) {
    const ind = JSON.parse(indentM[1]);
    check('缩进设置来自 editor.tabSize（mock 默认 4）', ind.tabSize === 4, JSON.stringify(ind));
    check('缩进设置来自 editor.insertSpaces（mock 默认 true）', ind.insertSpaces === true, JSON.stringify(ind));
  }
  check('Tab 分支按 insertSpaces 选择空格/制表符', /INDENT\.insertSpaces \? spaces\(/.test(lastPanel.webview.html));
  // execCommand('delete') 只出现在 Shift+Tab 反缩进分支里（其余分支都用 insertText）
  check('Shift+Tab 反缩进分支存在', /e\.shiftKey/.test(lastPanel.webview.html) && /execCommand\('delete'\)/.test(lastPanel.webview.html));
  check('不再无条件插入制表符', !/insertText', false, '\\t';\s*\n\s*return;\s*\n\s*\}/.test(lastPanel.webview.html));
  // 算法边界：与 webview 内表达式保持一致（lead=行首空白长度, TAB_SIZE=4）
  const TS = 4;
  const indentNeed = (lead) => TS - (lead % TS);                 // 补到下一个 tab stop
  const outdentCut = (lead) => Math.min((lead % TS) || TS, lead); // 回退到上一个 tab stop
  check('缩进补齐：0→4 / 2→2 / 4→4 / 6→2 / 8→4',
    [indentNeed(0), indentNeed(2), indentNeed(4), indentNeed(6), indentNeed(8)].join(',') === '4,2,4,2,4',
    [indentNeed(0), indentNeed(2), indentNeed(4), indentNeed(6), indentNeed(8)].join(','));
  check('反缩进：1→1 / 4→4 / 6→2 / 8→4 / 0→0',
    [outdentCut(1), outdentCut(4), outdentCut(6), outdentCut(8), outdentCut(0)].join(',') === '1,4,2,4,0',
    [outdentCut(1), outdentCut(4), outdentCut(6), outdentCut(8), outdentCut(0)].join(','));
  // 对齐性质（VSCode 的真实行为）：缩进后 / 反缩进后，行首空白都落在 tab stop 上。
  // 注意：不保证精确抵消——1 个空格按 Tab 补到 4，再 Shift+Tab 会退回 0（按 stop 对齐，非按字符回退）。
  check('缩进后行首对齐到 tab stop', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].every((l) => (l + indentNeed(l)) % TS === 0));
  check('反缩进后行首对齐到 tab stop', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].every((l) => (l - outdentCut(l)) % TS === 0));
  check('反缩进不越过行首', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].every((l) => outdentCut(l) <= l));

  console.log('\n[6] 接受 / 拒绝（0.4.5：接受不再 git add）');
  await registered.get('changeReview.acceptFile')({ repoRoot: ROOT, relPath: 'new.txt' });
  await new Promise((r) => setTimeout(r, 60));
  let st = g(['status', '--porcelain']);
  check('接受只标记已审查、不 git add', !/^A\s+new\.txt$/m.test(st), st);
  let accRoots = await treeView.opts.treeDataProvider.getChildren();
  check('接受后 new.txt 已标记为已审查', accRoots.find((n) => n.label === 'new.txt').file.reviewed === true);

  console.log('\n[6.1] git 暂存只在「标记为已审查」时发生（勾选 add / 取消 reset）');
  let nn = accRoots.find((n) => n.label === 'new.txt');
  await treeView._cbListener({ items: [[nn, 1]] }); // 勾选 = 标记为已审查
  await new Promise((r) => setTimeout(r, 80));
  st = g(['status', '--porcelain']);
  check('勾选已审查 → git add（new.txt 进入暂存区）', /^A\s+new\.txt$/m.test(st), st);
  accRoots = await treeView.opts.treeDataProvider.getChildren();
  nn = accRoots.find((n) => n.label === 'new.txt');
  await treeView._cbListener({ items: [[nn, 0]] }); // 取消勾选 = 取消已审查
  await new Promise((r) => setTimeout(r, 80));
  st = g(['status', '--porcelain']);
  check('取消已审查 → git reset（new.txt 撤出暂存区）', !/^A\s+new\.txt$/m.test(st), st);
  accRoots = await treeView.opts.treeDataProvider.getChildren();
  check('取消后 new.txt 回到待审查', accRoots.find((n) => n.label === 'new.txt').file.reviewed === false);

  await registered.get('changeReview.rejectFile')({ repoRoot: ROOT, relPath: 'src/a.js' });
  await new Promise((r) => setTimeout(r, 60));
  const roots4 = await treeView.opts.treeDataProvider.getChildren();
  check('拒绝后 a.js 移出列表', !roots4.some((n) => n.label === 'a.js'), JSON.stringify(roots4.map((n) => n.label)));
  check('old.txt 仍为删除状态待审查', roots4.some((n) => n.label.includes('old.txt')));

  console.log('\n[7] 下一个待审查');
  await registered.get('changeReview.nextUnreviewed')();
  await new Promise((r) => setImmediate(r));
  check('已跳转到某个待审查文件', /审查：/.test(lastPanel.title), lastPanel.title);

  console.log('\n[8] 全部标记 / 清除');
  await registered.get('changeReview.markAllReviewed')();
  const roots5 = await treeView.opts.treeDataProvider.getChildren();
  check('全部标记后角标消失', treeView.badge === undefined, JSON.stringify(treeView.badge));
  check('提示全部审查完', /已审查/.test(treeView.message || ''), treeView.message);
  await registered.get('changeReview.clearReviewed')();
  const roots6 = await treeView.opts.treeDataProvider.getChildren();
  check('清除后角标恢复', treeView.badge.value === roots6.length);

  console.log('\n[9] 命令注册完整性');
  const need = ['changeReview.refresh', 'changeReview.openReview', 'changeReview.acceptFile', 'changeReview.rejectFile',
    'changeReview.markReviewed', 'changeReview.unmarkReviewed', 'changeReview.markAllReviewed', 'changeReview.clearReviewed',
    'changeReview.nextUnreviewed', 'changeReview.openDiff', 'changeReview.revealFile', 'changeReview.focusView',
    'changeReview.initBaseline', 'changeReview.updateBaseline', 'changeReview.configureExclude'];
  check(`${need.length} 个命令全部注册 (${need.filter((n) => registered.has(n)).length}/${need.length})`,
    need.every((n) => registered.has(n)), need.filter((n) => !registered.has(n)).join(','));

  console.log('\n[9.1] 快捷键声明');
  const pkg = require('../package.json');
  const kb = (pkg.contributes && pkg.contributes.keybindings) || [];
  const kbCommands = kb.map((k) => k.command);
  check(`keybindings 数 >= 6 (实际 ${kb.length})`, kb.length >= 6, JSON.stringify(kbCommands));
  check('acceptFile 绑定 ctrl+shift+a', kbCommands.indexOf('changeReview.acceptFile') !== -1);
  check('rejectFile 绑定 ctrl+shift+r', kbCommands.indexOf('changeReview.rejectFile') !== -1);
  check('markReviewed 绑定 ctrl+shift+m', kbCommands.indexOf('changeReview.markReviewed') !== -1);
  check('unmarkReviewed 绑定 ctrl+shift+m', kbCommands.indexOf('changeReview.unmarkReviewed') !== -1);
  check('nextUnreviewed 绑定 alt+n', kbCommands.indexOf('changeReview.nextUnreviewed') !== -1);
  check('openReview 绑定 ctrl+enter', kbCommands.indexOf('changeReview.openReview') !== -1);
  check('快捷键都限定在 Change Review 视图聚焦时生效',
    kb.every((k) => /focusedView == changeReview\.files/.test(k.when || '')));

  console.log('\n[9.2] 命令标题与标题栏图标声明');
  const cmds = pkg.contributes.commands;
  const withPrefix = cmds.filter((c) => /^Change Review:/.test(c.title || ''));
  check(`没有任何命令标题带 "Change Review:" 前缀（共 ${cmds.length} 条命令）`, withPrefix.length === 0,
    withPrefix.map((c) => c.title).join(' | '));
  const vt = (pkg.contributes.menus['view/title'] || []);
  // 命令 title 现在用 %key% 占位符（nls.json），命令面板里看到的文字由 nls 文件解析后呈现
  check('refresh 命令 title 用 %cmd.refresh% 占位符（i18n）',
    cmds.find((c) => c.command === 'changeReview.refresh').title === '%cmd.refresh%');
  const refreshE = vt.find((v) => v.command === 'changeReview.refresh');
  const nextE = vt.find((v) => v.command === 'changeReview.nextUnreviewed');
  // 图标必须出现在 menu entry 里（VSCode 1.85+ 严格要求）
  check('「刷新」在 view/title 有显式 icon $(refresh)',
    !!refreshE && refreshE.icon === '$(refresh)', JSON.stringify(refreshE));
  // 「下一个待审查」图标按钮已按用户要求从 view/title 移除（命令本身保留在命令面板）
  check('「下一个待审查」已不在 view/title（图标按钮已移除）',
    !nextE, JSON.stringify(nextE));
  const initE = vt.find((v) => v.command === 'changeReview.initBaseline');
  const updateE = vt.find((v) => v.command === 'changeReview.updateBaseline');
  check('「初始化基准」只在没有基准的项目显示', !!initE && /!changeReview\.hasBaseline/.test(initE.when || ''), JSON.stringify(initE));
  check('「更新基准」只在快照基准项目显示（git/svn 不再出现）',
    !!updateE && /changeReview\.snapshotActive/.test(updateE.when || ''), JSON.stringify(updateE));
  check('标题栏导航区只保留 refresh/next/基准按钮（最多 3 个位置，避免按钮过多挤成文字）',
    new Set(vt.filter((v) => /^navigation/.test(v.group || '')).map((v) => v.group)).size <= 3);

  console.log('\n[9.2.1] 多语言（i18n）声明');
  const fs2 = require('fs');
  const nlsDefault = JSON.parse(fs2.readFileSync(path.join(__dirname, '..', 'package.nls.json'), 'utf8'));
  const nlsZhCn = JSON.parse(fs2.readFileSync(path.join(__dirname, '..', 'package.nls.zh-cn.json'), 'utf8'));
  check('package.nls.json 至少 30 个 key', Object.keys(nlsDefault).length >= 30, String(Object.keys(nlsDefault).length));
  check('package.nls.zh-cn.json 与 nls 默认文件 key 数一致',
    Object.keys(nlsDefault).length === Object.keys(nlsZhCn).length,
    `default=${Object.keys(nlsDefault).length} zh=${Object.keys(nlsZhCn).length}`);
  const placeholders = new Set();
  cmds.forEach((c) => {
    const m = /%([\w.]+)%/.exec(c.title || '');
    if (m) { placeholders.add(m[1]); }
  });
  const missing = Array.from(placeholders).filter((k) => !(k in nlsDefault));
  check(`所有 %cmd.*% 占位符在两个 nls 文件中都有定义（缺失：${missing.join(',') || '无'}）`, missing.length === 0);

  console.log('\n[9.2.2] Activity Bar 图标');
  check('Activity Bar 容器引用 resources/icon.svg',
    pkg.contributes.viewsContainers.activitybar[0].icon === 'resources/icon.svg');
  check('icon.svg 文件存在',
    fs2.existsSync(path.join(__dirname, '..', 'resources', 'icon.svg')));

  console.log('\n[9.3] 排除规则入口：打开项目 .crignore 而非插件设置');
  await registered.get('changeReview.configureExclude')();
  const openSettings = vscode._executed.filter(([id]) => id === 'workbench.action.openSettings').pop();
  check('「配置排除规则…」不再写进插件设置', !openSettings);
  check('已在工作区根创建 .crignore',
    fs.existsSync(path.join(ROOT, '.crignore')), path.join(ROOT, '.crignore'));
  const openedAny = vscode._openedDocs.some((d) => {
    const u = d && d.uri;
    const fp = u && (u.fsPath || (u.uri && u.uri.fsPath));
    return !!fp && fp.endsWith('.crignore');
  });
  check('已打开该 .crignore 供直接编辑', openedAny);
  // 模拟用户在文件里填了排除规则并保存
  fs.writeFileSync(path.join(ROOT, '.crignore'), '# test\n**/dist/**\n', 'utf8');
  check('排除规则能写回磁盘', fs.readFileSync(path.join(ROOT, '.crignore'), 'utf8').includes('**/dist/**'));

  console.log('\n[9.4] 接受不再整表重扫、不 git add：只标记已审查');
  const beforeAccept = vscode._executed.length;
  await registered.get('changeReview.acceptFile')({ repoRoot: ROOT, relPath: 'new.txt' });
  const afterAcceptExec = vscode._executed.slice(beforeAccept).map(([id]) => id);
  check('accept 不再触发 vscode.diff / 全量命令', !afterAcceptExec.some((id) => id === 'vscode.diff'));
  const rootsA = await treeView.opts.treeDataProvider.getChildren();
  const newNode = rootsA.find((n) => n.label === 'new.txt');
  check('接受后列表里 new.txt 仍存在且已被标记', !!newNode && newNode.file.reviewed === true, JSON.stringify(newNode && newNode.file));
  check('接受未 git add（new.txt 仍在工作区、不在暂存区）',
    !/^A\s+new\.txt$/m.test(g(['status', '--porcelain'])), g(['status', '--porcelain']));

  console.log('\n[9.5] 对比块内就地编辑（编辑不跳文件，改完同步写回）');
  const beforeBytes = fs.readFileSync(path.join(ROOT, 'src/a.js'), 'utf8');
  fs.appendFileSync(path.join(ROOT, 'src/a.js'), 'const extraForEdit = 1;\n', 'utf8');
  await registered.get('changeReview.refresh')();
  await registered.get('changeReview.openReview')({ repoRoot: ROOT, relPath: 'src/a.js' });
  await new Promise((r) => setImmediate(r));
  check('面板当前显示 a.js', /a\.js/.test(lastPanel.title), lastPanel.title);
  check('面板不再内嵌 textarea 编辑器', !/<textarea[^>]*id="editor"/.test(lastPanel.webview.html));
  check('不再有单独的「编辑」按钮', !/data-cmd="edit"/.test(lastPanel.webview.html));
  check('每个改动块有「跳转」按钮', /data-cmd="goto"/.test(lastPanel.webview.html));
  check('对比块里的行可就地编辑（contenteditable 且带文件行号）',
    /class="tx ed" contenteditable="true"[^>]*data-line="\d+"/.test(lastPanel.webview.html),
    (lastPanel.webview.html.match(/<span class="tx ed"[^>]*>/) || [''])[0]);
  check('被删除的行不可编辑（避免误改）',
    !/class="row del"[\s\S]{0,200}?contenteditable/.test(lastPanel.webview.html));
  // 模拟在对比块里改某一行：editLine 消息 → 写回文件对应行
  const linesBefore = fs.readFileSync(path.join(ROOT, 'src/a.js'), 'utf8').split('\n');
  const newText = linesBefore[0] + ' // inline-edited';
  await lastPanel._msg({ type: 'editLine', line: 1, text: newText });
  await new Promise((r) => setImmediate(r));
  const linesAfter = fs.readFileSync(path.join(ROOT, 'src/a.js'), 'utf8').split('\n');
  check('在对比块里改行后已写回文件对应行', linesAfter[0] === newText, JSON.stringify(linesAfter[0]));
  check('其它行没被带坏', linesAfter.length === linesBefore.length && linesAfter[1] === linesBefore[1]);
  // 行级增删：「+行」插入空行 /「删行」删除该行
  const aPath = path.join(ROOT, 'src/a.js');
  await lastPanel._msg({ type: 'insertLine', line: 1 });
  await new Promise((r) => setTimeout(r, 60));
  const linesIns = fs.readFileSync(aPath, 'utf8').split('\n');
  check('「+行」在该行下面插入空行', linesIns.length === linesAfter.length + 1 && linesIns[1] === '',
    JSON.stringify(linesIns.slice(0, 4)));
  // 0.4.5：行级「+行 / 删行」悬浮按钮已按用户要求移除，键盘（Enter / Backspace / Del / Ctrl+Del）保留
  check('不再有行级「+行 / 删行」按钮',
    !/data-cmd="insertLine"/.test(lastPanel.webview.html) && !/data-cmd="deleteLine"/.test(lastPanel.webview.html));
  check('键盘删行仍可用（Backspace/Del/Ctrl+Del → deleteLine）',
    /type: 'deleteLine'/.test(lastPanel.webview.html));
  await lastPanel._msg({ type: 'deleteLine', line: 2 });
  await new Promise((r) => setTimeout(r, 60));
  const linesDel = fs.readFileSync(aPath, 'utf8').split('\n');
  check('「删行」删除对应行', linesDel.length === linesAfter.length && linesDel[1] === linesAfter[1],
    JSON.stringify(linesDel.slice(0, 4)));
  // 回归（0.4.2 bug 12）：键盘删行 —— 空行上 Backspace/Delete、或 Ctrl+Del 触发 deleteLine
  check('键盘删行：keydown 监听 Backspace/Delete + Ctrl 删除整行',
    /e\.key === 'Backspace' \|\| e\.key === 'Delete'/.test(lastPanel.webview.html)
      && /type: 'deleteLine'/.test(lastPanel.webview.html),
    '');
  // 提示文案以用户手改的短版为准（「行内也可直接编辑」），不再强制长版说明——测试不得覆盖用户的文案偏好
  check('提示文案是用户定的短版', /class="tip">行内也可直接编辑</.test(lastPanel.webview.html));
  // 回归（0.4.3.1）：删行焦点规则 —— 空行删完回上一行，内容行焦点留在原位（行号漂移修复）
  check('删行焦点规则：空行→上一行，内容行→原位',
    /focusLine: empty \? Math\.max\(1, line - 1\) : line/.test(lastPanel.webview.html));
  // 回归：残留的「显示编辑器」按钮（内嵌编辑器已删除，该按钮是死代码）
  check('不再有残留的「显示编辑器」按钮',
    !/data-cmd="toggleEditor"/.test(lastPanel.webview.html) && !/显示编辑器/.test(lastPanel.webview.html));
  // 0.4.6 交互重构：多选/簇/粘贴整套已移除（跳转=原生对比视图，编辑在对比编辑器里做）
  check('不再有多选/簇/粘贴残留（selbar、data-h、insertLinesBelow 全部清除）',
    !/selbar/.test(lastPanel.webview.html) && !/data-h="/.test(lastPanel.webview.html)
      && !/insertLinesBelow/.test(lastPanel.webview.html) && !/clusterRestore/.test(lastPanel.webview.html));
  check('跳转（goto → 原生新旧对比视图）', /data-cmd="goto"/.test(lastPanel.webview.html));
  // 回归：块头按钮必须始终占位，否则 hover 会改变块高度、下方所有块抖动
  check('块头按钮始终占位（visibility 而非 display:none，hover 不改高度）',
    /\.hunk-head \.hact \{[^}]*visibility: hidden/.test(lastPanel.webview.html)
      && !/\.hact \{[^}]*display: none/.test(lastPanel.webview.html));
  // 回归：接受/拒绝按钮风格统一（与 diff 同色系）
  check('接受按钮用统一的 ok 绿样式', /class="ok" data-cmd="accept"/.test(lastPanel.webview.html));
  check('拒绝按钮用统一的 danger 红样式', /class="danger" data-cmd="reject"/.test(lastPanel.webview.html));
  // 还原回去，避免影响后续测试
  fs.writeFileSync(path.join(ROOT, 'src/a.js'), beforeBytes, 'utf8');

  console.log('\n[10] 基准内容提供器');
  await registered.get('changeReview.openDiff')({ repoRoot: ROOT, relPath: 'new.txt' });
  check('调用 vscode.diff', vscode._executed.some(([id]) => id === 'vscode.diff'));
  const headUri = vscode._executed.filter(([id]) => id === 'vscode.diff').pop()[1][0];
  check('left 为 change-review-base scheme', headUri.scheme === 'change-review-base', headUri.scheme);
  const content = await vscode._headProvider.provideTextDocumentContent(headUri);
  check('新增文件的基准版本为空', content === '', JSON.stringify(content));
  const oldHeadUri = { scheme: 'change-review-base', path: '/old.txt', query: 'root=' + encodeURIComponent(ROOT), toString: () => 'x' };
  const oldContent = await vscode._headProvider.provideTextDocumentContent(oldHeadUri);
  check('删除文件能取到基准内容（HEAD 里有 old.txt）', oldContent === 'x\n', JSON.stringify(oldContent));

  console.log('\n[11] 无参数命令回退到当前编辑器（此前会静默无操作）');
  fs.appendFileSync(path.join(ROOT, 'src/a.js'), 'const extra = 1;\n', 'utf8');
  await registered.get('changeReview.refresh')();
  const roots7 = await treeView.opts.treeDataProvider.getChildren();
  const aNode = roots7.find((n) => n.label === 'a.js');
  check('a.js 回到待审查', aNode && aNode.file.reviewed === false);
  // 不传参数，只靠“当前打开的文件”定位
  vscode.window.activeTextEditor = { document: { uri: Uri.file(aNode.file.absPath) } };
  await registered.get('changeReview.markReviewed')();
  const roots8 = await treeView.opts.treeDataProvider.getChildren();
  check('无参数也能标记成功', roots8.find((n) => n.label === 'a.js').file.reviewed === true);
  check('给出了状态栏反馈', vscode._statusMsgs.some((m) => /已标记/.test(m)), vscode._statusMsgs.join('|'));
  vscode.window.activeTextEditor = null;

  console.log('\n[12] 找不到目标时给出提示而不是静默');
  if (lastPanel) { lastPanel.visible = false; }
  vscode.window.activeTextEditor = { document: { uri: Uri.file(path.join(ROOT, 'not-in-list.js')) } };
  const warnsBefore = vscode._warns.length;
  await registered.get('changeReview.acceptFile')({ repoRoot: '/not/exist', relPath: 'nope.js' });
  check('弹出了提示而不是静默无操作', vscode._warns.length > warnsBefore, JSON.stringify(vscode._warns.slice(-1)));
  vscode.window.activeTextEditor = null;
  if (lastPanel) { lastPanel.visible = true; }

  console.log('\n[14] 平台分支');
  const plat = require('../src/platform');
  check('候选 git 与当前平台匹配', plat.IS_WIN ? plat.gitCandidates().some((c) => /git\.exe$/.test(c)) : plat.gitCandidates().indexOf('/usr/bin/git') !== -1);
  check('Windows 路径识别', plat.isWindowsPath('C:\\repo') && plat.isWindowsPath('C:/repo') && !plat.isWindowsPath('/home/u'));
  check('POSIX 路径识别', plat.isPosixAbsPath('/home/u') && !plat.isPosixAbsPath('C:/x'));
  check('路径比较忽略分隔符差异', plat.samePath('C:\\a\\b', 'C:/a/b') === plat.IS_WIN);
  check('toGitPath 统一为正斜杠', plat.toGitPath('src\\a.js').indexOf('\\') === -1);

  console.log('\n[15] 模拟 Linux/WSL 分支');
  const realPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  delete require.cache[require.resolve('../src/platform')];
  const linuxPlat = require('../src/platform');
  const cands = linuxPlat.gitCandidates();
  check('Linux 候选含 /usr/bin/git', cands.indexOf('/usr/bin/git') !== -1, cands.join(','));
  check('Linux 候选不含 git.exe', !cands.some((c) => /\.exe$/.test(c)), cands.join(','));
  check('能识别 Windows 版 git 返回的 C:/ 路径', linuxPlat.isWindowsPath('C:/Users/x/repo'));
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  delete require.cache[require.resolve('../src/platform')];

  console.log('\n[16] git 路径配置错误时自动回落');
  const gitSvc = require('../src/gitService');
  gitSvc.setGitPath('/definitely/not/a/git/binary');
  gitSvc.resetGit();
  const info = await gitSvc.getGitInfo();
  check('跳过无效路径并回落到系统 git', /git version/.test(info.version), info.bin);
  gitSvc.setGitPath('');
  gitSvc.resetGit();

  console.log('\n[17] 块级接受：webview 消息 → 只标记已接受（0.4.5 起不再 git apply --cached）');
  // 制造两个相距较远的块：文件头一行 + 文件尾追加
  const aLines = fs.readFileSync(path.join(ROOT, 'src/a.js'), 'utf8').split('\n');
  aLines[0] = 'const v0 = 100;';
  fs.writeFileSync(path.join(ROOT, 'src/a.js'), aLines.join('\n'), 'utf8');
  fs.appendFileSync(path.join(ROOT, 'src/a.js'), 'const another = 2;\n', 'utf8');
  await registered.get('changeReview.refresh')();
  const gitSvc2 = require('../src/gitService');
  const { parseDiff, hunkSignature } = require('../src/diffParser');
  const aEntry = treeView.opts.treeDataProvider.getChildren().find((n) => n.label === 'a.js');
  const diffText = await gitSvc2.getDiff(aEntry.repo.root, aEntry.file, 3);
  const hunks = parseDiff(diffText)[0].hunks;
  check('a.js 有 >=2 个块', hunks.length >= 2, `实际 ${hunks.length}`);
  const sig0 = hunkSignature(hunks[0]);
  // 先让面板显示 a.js（面板当前可能停留在别的文件上，真实使用中就是“点开哪个文件就作用于哪个”）
  await registered.get('changeReview.openReview')({ repoRoot: aEntry.repo.root, relPath: 'src/a.js' });
  await lastPanel._msg({ type: 'hunkAccept', index: 0, sig: sig0 });
  await new Promise((r) => setTimeout(r, 80));
  const cached = execFileSync('git', ['-c', 'core.quotepath=false', 'diff', '--cached', '--', 'src/a.js'], { cwd: ROOT, encoding: 'utf8' });
  check('接受此块不再进暂存区（--cached diff 为空）', !cached.includes('@@'), cached.slice(0, 200));
  check('工作区内容没被动过（接受≠还原）', fs.readFileSync(path.join(ROOT, 'src/a.js'), 'utf8').includes('const v0 = 100;'));
  const storeData = stateStore['changeReview.reviewed.v1'];
  check('块级“已接受”状态已持久化', !!storeData && Object.keys(storeData).some((k) => k.endsWith('::hunks') && storeData[k][sig0]));
  check('面板消息已写入 Output 日志', vscode._output.lines.some((l) => /收到消息 type=hunkAccept/.test(l)),
    vscode._output.lines.slice(-3).join(' | '));
  await lastPanel._msg({ type: 'ready' }); // [13] 的诊断会 clear() 日志，这里重发一次验证通道仍在
  check('ready 消息也收到了（说明 webview 脚本在跑）', vscode._output.lines.some((l) => /type=ready/.test(l)));

  console.log('\n[18] 块级拒绝：延迟执行（标记为已审查时才还原）');
  await lastPanel._msg({ type: 'hunkReject', index: 0, sig: sig0 });
  await new Promise((r) => setTimeout(r, 80));
  const aFileNow = treeView.opts.treeDataProvider.getChildren().find((n) => n.label.includes('a.js')).file;
  const afterReject = parseDiff(await gitSvc2.getDiff(aEntry.repo.root, aFileNow, 3))[0].hunks;
  check('拒绝后工作区暂不变（延迟执行）', afterReject.length === hunks.length && hunkSignature(afterReject[0]) === sig0,
    `before=${hunks.length} after=${afterReject.length}`);
  const rejData = stateStore['changeReview.reviewed.v1'];
  check('拒绝决定已持久化（rejected 表）', !!rejData && Object.keys(rejData).some((k) => k.endsWith('::rejected') && rejData[k][sig0]));
  // 标记为已审查 → 执行拒绝块（还原）+ git add
  await lastPanel._msg({ type: 'mark' });
  await new Promise((r) => setTimeout(r, 150));
  const afterMark = parseDiff(await gitSvc2.getDiff(aEntry.repo.root, aFileNow, 3))[0].hunks;
  check('标记已审查后第一个块已被还原', afterMark.length !== hunks.length || hunkSignature(afterMark[0]) !== sig0,
    `before=${hunks.length} after=${afterMark.length}`);
  // 反悔路径：撤销拒绝 → rejected 表清空
  await lastPanel._msg({ type: 'hunkReject', index: afterMark.length ? 0 : 0, sig: afterMark.length ? hunkSignature(afterMark[0]) : sig0 });
  await lastPanel._msg({ type: 'hunkUnreject', index: 0, sig: afterMark.length ? hunkSignature(afterMark[0]) : sig0 });
  await new Promise((r) => setTimeout(r, 80));
  const rejData2 = stateStore['changeReview.reviewed.v1'];
  const rejLeft = Object.keys(rejData2 || {}).some((k) => k.endsWith('::rejected') && Object.keys(rejData2[k]).length);
  check('撤销拒绝后 rejected 表为空', !rejLeft);

  console.log('\n[19] 基准命令在 git 项目下的守卫');
  const infosBefore = vscode._infos.length;
  await registered.get('changeReview.initBaseline')();
  check('git 项目调用初始化基准会被提示“无需手动初始化”', vscode._infos.length > infosBefore && /git|Git/.test(vscode._infos.slice(-1)[0] || ''),
    JSON.stringify(vscode._infos.slice(-1)));
  const infosBefore2 = vscode._infos.length;
  await registered.get('changeReview.updateBaseline')();
  check('git 项目调用更新基准会被提示“由 git 管理”', vscode._infos.length > infosBefore2 && /Git/.test(vscode._infos.slice(-1)[0] || ''),
    JSON.stringify(vscode._infos.slice(-1)));
  check('hasBaseline context 已置为 true（不显示欢迎页）', vscode._executed.some(([id, a]) => id === 'setContext' && a[0] === 'changeReview.hasBaseline' && a[1] === true));
}

async function mainSnapshot() {
  // 无 git / svn 的工作区：验证探测走“快照基准”并弹欢迎 context=false
  const ROOT2 = path.join(os.tmpdir(), `cr-mock-snap-${Date.now()}`);
  const GLOBAL = path.join(os.tmpdir(), `cr-mock-glob-${Date.now()}`);
  fs.mkdirSync(path.join(ROOT2, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(ROOT2, 'src.txt'), 'a\nb\n', 'utf8');
  fs.writeFileSync(path.join(ROOT2, 'sub/keep.txt'), 'k\n', 'utf8');
  vscode.workspace.workspaceFolders = [{ uri: Uri.file(ROOT2) }];
  config.forceVcs = 'auto';
  config.gitPath = '/definitely/not/exist/git';
  // 让 git 探测也找不到（目录里没有 .git），snapshot 兜底
  const stateStore2 = {};
  const context2 = {
    subscriptions: [],
    globalStorageUri: { fsPath: GLOBAL },
    workspaceState: {
      get: (k, d) => (stateStore2[k] === undefined ? d : stateStore2[k]),
      update: (k, v) => { stateStore2[k] = v; return Promise.resolve(); }
    }
  };
  const ext = require('../src/extension.js');
  // 重新激活（模拟另一个窗口），先退掉上次实例
  await registered.get('changeReview.clearReviewed')();
  await ext.activate(context2);
  console.log('\n[20] 无版本控制项目 → 快照基准');
  const children = await treeView.opts.treeDataProvider.getChildren();
  check('没有文件改动（还没建基准）', children.length === 0 || children.length === 1, children.length);
  check('hasBaseline context = false（显示欢迎页）', vscode._executed.some(([id, a]) => id === 'setContext' && a[0] === 'changeReview.hasBaseline' && a[1] === false),
    JSON.stringify(vscode._executed.filter(([id]) => id === 'setContext')));

  const warnsBefore = vscode._warns.length;
  await registered.get('changeReview.initBaseline')();
  check('建立基准有确认弹窗', vscode._warns.length > warnsBefore, JSON.stringify(vscode._warns.slice(-1)));
  await new Promise((r) => setImmediate(r));
  const filesAfterInit = await treeView.opts.treeDataProvider.getChildren();
  const n1 = filesAfterInit.length;
  check('建立基准后无改动（列表为空）', n1 === 0, JSON.stringify(filesAfterInit.map((x) => x.label)));

  // 改一个文件 → 应出现
  fs.writeFileSync(path.join(ROOT2, 'src.txt'), 'a\nb\nc\n', 'utf8');
  await registered.get('changeReview.refresh')();
  const filesAfterEdit = await treeView.opts.treeDataProvider.getChildren();
  check('修改文件后出现在列表', filesAfterEdit.length === 1 && filesAfterEdit[0].label === 'src.txt',
    JSON.stringify(filesAfterEdit.map((x) => x.label)));
  check('+1 行', /\+1/.test(filesAfterEdit[0].description), filesAfterEdit[0].description);

  // 打开面板看 diff
  await registered.get('changeReview.openReview')({ repoRoot: ROOT2, relPath: 'src.txt' });
  await new Promise((r) => setImmediate(r));
  check('快照 diff 渲染出新增行', /class="row add"/.test(lastPanel.webview.html) && /<span class="tx ed"[^>]*>c<\/span>/.test(lastPanel.webview.html),
    (lastPanel.webview.html.match(/<span class="tx[^>]*>[^<]*<\/span>/) || [''])[0]);
  check('面板提示对比基准', /对比/.test(lastPanel.webview.html));

  // 更新基准
  const infos3 = vscode._infos.length;
  await registered.get('changeReview.updateBaseline')();
  check('更新基准有确认', vscode._warns.length > warnsBefore);
  await new Promise((r) => setImmediate(r));
  const filesAfterUpdate = await treeView.opts.treeDataProvider.getChildren();
  check('更新基准后改动清零', filesAfterUpdate.length === 0, JSON.stringify(filesAfterUpdate.map((x) => x.label)));
  check('基准文件已写入 globalStorage', fs.existsSync(path.join(GLOBAL, 'snapshots')));

  // 回归：新建文件（untracked）→ 直接更新基准，也必须把它纳入基准、差异清零
  fs.writeFileSync(path.join(ROOT2, 'brand-new.txt'), 'hello\n', 'utf8');
  await registered.get('changeReview.refresh')();
  const filesWithNew = await treeView.opts.treeDataProvider.getChildren();
  check('新建文件以 untracked 出现在列表', filesWithNew.length === 1 && filesWithNew[0].label === 'brand-new.txt',
    JSON.stringify(filesWithNew.map((x) => x.label)));
  await registered.get('changeReview.updateBaseline')();
  await new Promise((r) => setImmediate(r));
  const filesAfterUpdate2 = await treeView.opts.treeDataProvider.getChildren();
  check('未标记审查、直接更新基准后新文件差异也清零', filesAfterUpdate2.length === 0,
    JSON.stringify(filesAfterUpdate2.map((x) => x.label)));

  // 回归（0.4.2 bug 10）：树里选中了某个文件时，标题栏 ↑（无参数）必须仍是「全量」更新，
  // 不能静默回落成「只更新选中文件」。两个文件都有差异、只选中其中一个 → 更新后必须全部清零。
  fs.writeFileSync(path.join(ROOT2, 'f1.txt'), 'one\n', 'utf8');
  fs.writeFileSync(path.join(ROOT2, 'f2.txt'), 'two\n', 'utf8');
  await registered.get('changeReview.refresh')();
  const twoFiles = await treeView.opts.treeDataProvider.getChildren();
  check('两个文件都出现在列表', twoFiles.length === 2, JSON.stringify(twoFiles.map((x) => x.label)));
  treeView.selection = [twoFiles[0]]; // 模拟用户在树里选中了第一个文件
  await registered.get('changeReview.updateBaseline')(); // 标题栏 ↑：无参数
  await new Promise((r) => setImmediate(r));
  const afterFullUpdate = await treeView.opts.treeDataProvider.getChildren();
  check('选中文件时点 ↑ 仍全量更新（其余文件差异也清零）', afterFullUpdate.length === 0,
    JSON.stringify(afterFullUpdate.map((x) => x.label)));
  treeView.selection = [];

  try { fs.rmSync(ROOT2, { recursive: true, force: true }); fs.rmSync(GLOBAL, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

async function mainSubdir() {
  // 用户场景：git 根 A 下并行 prj1/prj2，VSCode 只打开 A/prj1 → 改动列表必须只含 prj1
  console.log('\n[21] 打开仓库的子目录 → 只显示该目录改动');
  const ROOT3 = path.join(os.tmpdir(), `cr-mock-sub-${Date.now()}`);
  fs.mkdirSync(path.join(ROOT3, 'prj1', 'src'), { recursive: true });
  fs.mkdirSync(path.join(ROOT3, 'prj2', 'src'), { recursive: true });
  const git3 = (args) => execFileSync('git', args, { cwd: ROOT3, encoding: 'utf8' });
  git3(['init', '-q']);
  git3(['config', 'user.email', 's@local']);
  git3(['config', 'user.name', 'Sub']);
  git3(['config', 'core.autocrlf', 'false']);
  const mkContent = () => Array.from({ length: 10 }, (_, i) => `const v${i} = ${i};`).join('\n') + '\n';
  fs.writeFileSync(path.join(ROOT3, 'prj1/src/app.js'), mkContent(), 'utf8');
  fs.writeFileSync(path.join(ROOT3, 'prj1/README.md'), 'prj1\n', 'utf8');
  fs.writeFileSync(path.join(ROOT3, 'prj2/src/app.js'), mkContent(), 'utf8');
  fs.writeFileSync(path.join(ROOT3, 'prj2/README.md'), 'prj2\n', 'utf8');
  git3(['add', '-A']);
  git3(['commit', '-q', '-m', 'init']);
  const l = mkContent().split('\n');
  l[0] = 'const v0 = 100;';
  fs.writeFileSync(path.join(ROOT3, 'prj1/src/app.js'), l.join('\n'), 'utf8');
  fs.writeFileSync(path.join(ROOT3, 'prj1/README.md'), 'prj1 changed\n', 'utf8');
  fs.writeFileSync(path.join(ROOT3, 'prj2/README.md'), 'prj2 CHANGED\n', 'utf8');

  // 重置为 auto + 系统 git
  config.forceVcs = 'auto';
  config.gitPath = '';
  const gitSvc = require('../src/gitService');
  gitSvc.setGitPath('');
  gitSvc.resetGit();
  vscode._infos.length = 0; vscode._errors.length = 0; vscode._warns.length = 0; vscode._executed.length = 0; vscode._statusMsgs.length = 0;

  vscode.workspace.workspaceFolders = [{ uri: Uri.file(path.join(ROOT3, 'prj1')) }];
  const stateStore3 = {};
  const context3 = {
    subscriptions: [],
    workspaceState: {
      get: (k, d) => (stateStore3[k] === undefined ? d : stateStore3[k]),
      update: (k, v) => { stateStore3[k] = v; return Promise.resolve(); }
    }
  };
  const ext = require('../src/extension.js');
  await ext.activate(context3);
  await new Promise((r) => setTimeout(r, 80));
  const children = await treeView.opts.treeDataProvider.getChildren();
  const rels = children.map((n) => n.file.relPath).sort();
  console.log('    子目录视角:', rels.join(', '));
  check('只显示 prj1 内 2 个改动', children.length === 2 && rels.every((r) => r.startsWith('prj1/')),
    JSON.stringify(rels));
  check('不显示 prj2 的改动', !rels.some((r) => r.startsWith('prj2/')), JSON.stringify(rels));
  check('角标 = 2', treeView.badge && treeView.badge.value === 2, JSON.stringify(treeView.badge));
  check('状态栏 0/2', /0\/2/.test(statusBar.text), statusBar.text);

  // 打开 prj1 下文件的审查面板
  await registered.get('changeReview.openReview')({ repoRoot: ROOT3, relPath: 'prj1/src/app.js' });
  await new Promise((r) => setImmediate(r));
  check('子目录内文件能进入审查面板', !!lastPanel && /app\.js/.test(lastPanel.title), lastPanel && lastPanel.title);
  check('面板 diff 显示该文件改动', lastPanel.webview.html.includes('const v0 = 100;'));

  // 标记 prj1/src/app.js 已审查 → 角标 1
  await registered.get('changeReview.markReviewed')({ repoRoot: ROOT3, relPath: 'prj1/src/app.js' });
  await new Promise((r) => setImmediate(r));
  check('子目录内标记已审查后角标为 1', treeView.badge.value === 1, JSON.stringify(treeView.badge));
  try { fs.rmSync(ROOT3, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

main()
  .then(async () => {
    try {
      await mainSnapshot();
    } catch (e) {
      failures += 1;
      console.log('快照场景异常:', e && e.stack ? e.stack : e);
    }
    try {
      await mainSubdir();
    } catch (e) {
      failures += 1;
      console.log('子目录场景异常:', e && e.stack ? e.stack : e);
    }
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    console.log(`\n${failures === 0 ? '全部通过 ✓' : `${failures} 项失败 ✗`}`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error('冒烟测试异常：', e);
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (err) { /* ignore */ }
    process.exit(1);
  });
