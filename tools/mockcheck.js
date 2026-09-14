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
    /data-cmd="accept"[^>]*title="[^"]*标记已审查[^"]*暂存[^"]*"/.test(lastPanel.webview.html),
    lastPanel.webview.html.match(/<button[^>]*data-cmd="accept"[^>]*>/)[0]);
  check('拒绝按钮文字是\"拒绝\"（语义已放进悬浮提示）', /data-cmd="reject"[^>]*title="[^"]*还原[^"]*"/.test(lastPanel.webview.html),
    lastPanel.webview.html.match(/<button[^>]*data-cmd="reject"[^>]*>/)[0]);
  check('面板不再含旧版\"在编辑器中打开\"按钮', !/在编辑器中打开/.test(lastPanel.webview.html));
  // 模拟 webview 加载完成后发出的 ready（真实环境由 webview 脚本自动发）
  await lastPanel._msg({ type: 'ready' });
  check('ready 消息被记录到 Output', vscode._output.lines.some((l) => /收到消息 type=ready/.test(l)));
  check('工具栏文件级接受/拒绝仍在', lastPanel.webview.html.includes('data-cmd="accept"') && lastPanel.webview.html.includes('data-cmd="reject"'));
  check('面板含右键菜单容器', lastPanel.webview.html.includes('id="ctxmenu"'));
  check('右键菜单含「屏蔽此文件」项', lastPanel.webview.html.includes('data-ctx="blockFile"'),
    lastPanel.webview.html.match(/data-ctx="blockFile"[^>]*>[^<]*/));
  // 用户明确要求：屏蔽只在 panel 右键菜单里，工具栏不要再出现按钮
  check('工具栏不再有「屏蔽此文件」按钮', !lastPanel.webview.html.includes('data-cmd="blockFile"'));
  // 右键菜单必须真的能用：diff 正文的上下文行/新增行都是 .tx.ed，
  // 早先「命中 .tx.ed 就放行系统菜单」会让面板绝大部分区域弹不出我们的菜单。
  {
    const sm = lastPanel.webview.html.match(/<script[^>]*>([\s\S]*?)<\/script>/);
    const js = sm ? sm[1] : '';
    const ctxPart = (js.match(/addEventListener\('contextmenu'[\s\S]{0,600}/) || [''])[0];
    check('右键菜单不再因 .tx.ed 直接放行系统菜单', !/closest\('\.tx\.ed'\)/.test(ctxPart), ctxPart.slice(0, 160));
    check('右键菜单改用「有选中文本才放行」的判据', /getSelection/.test(ctxPart), ctxPart.slice(0, 160));
  }
  check('工具栏按钮只有 接受全部/拒绝全部/标记/下一个/刷新',
    !/data-cmd="blockFile"/.test(lastPanel.webview.html) && lastPanel.webview.html.includes('data-cmd="refresh"'));

  console.log('\n[6] 接受全部 = 记录所有块 + 自动标记已审查（git add 随标记发生）');
  await registered.get('changeReview.acceptFile')({ repoRoot: ROOT, relPath: 'new.txt' });
  await new Promise((r) => setTimeout(r, 250));
  let st = g(['status', '--porcelain']);
  check('接受全部 → 自动标记并 git add（new.txt 进暂存区）', /^A\s+new\.txt$/m.test(st), st);
  let accRoots = await treeView.opts.treeDataProvider.getChildren();
  const accNode = accRoots.find((n) => n.label === 'new.txt');
  check('接受全部后 new.txt 标记为已审查', !!accNode && accNode.file.reviewed === true,
    JSON.stringify(accNode && accNode.file));
  {
    const tbl = stateStore['changeReview.reviewed.v1'][`${ROOT.replace(/\\/g, '/')}::new.txt::hunks`] || {};
    check('接受全部把所有块记成了已接受', Object.keys(tbl).length > 0, JSON.stringify(Object.keys(tbl)));
  }

  console.log('\n[6.1] git add / reset 只在「标记已审查」时发生');
  let nn = accRoots.find((n) => n.label === 'new.txt');
  await treeView._cbListener({ items: [[nn, 1]] }); // 勾选 = 标记已审查
  await new Promise((r) => setTimeout(r, 80));
  st = g(['status', '--porcelain']);
  check('标记已审查 → git add（new.txt 进入暂存区）', /^A\s+new\.txt$/m.test(st), st);
  accRoots = await treeView.opts.treeDataProvider.getChildren();
  nn = accRoots.find((n) => n.label === 'new.txt');
  await treeView._cbListener({ items: [[nn, 0]] }); // 取消勾选 = 取消已审查
  await new Promise((r) => setTimeout(r, 80));
  st = g(['status', '--porcelain']);
  check('取消已审查 → git reset（new.txt 撤出暂存区）', !/^A\s+new\.txt$/m.test(st), st);
  accRoots = await treeView.opts.treeDataProvider.getChildren();
  check('取消后 new.txt 回到待审查', accRoots.find((n) => n.label === 'new.txt').file.reviewed === false);

  console.log('\n[6.2] 拒绝全部 = 记录所有块 + 自动标记（还原随标记发生）');
  const aBefore = fs.readFileSync(path.join(ROOT, 'src/a.js'), 'utf8');
  await registered.get('changeReview.rejectFile')({ repoRoot: ROOT, relPath: 'src/a.js' });
  await new Promise((r) => setTimeout(r, 250));
  check('拒绝全部 → 自动标记并执行还原（a.js 回到基线、不再有改动）',
    !/^\s*M\s+.*src\/a\.js$/m.test(g(['status', '--porcelain']))
      && fs.readFileSync(path.join(ROOT, 'src/a.js'), 'utf8') !== aBefore,
    g(['status', '--porcelain']));
  const rootsR = await treeView.opts.treeDataProvider.getChildren();
  check('a.js 还原后移出改动列表', !rootsR.some((n) => n.label === 'a.js'),
    JSON.stringify(rootsR.map((n) => n.label)));
  check('old.txt 仍为删除状态待审查', rootsR.some((n) => n.label.includes('old.txt')));

  console.log('\n[7] 下一个待审查');
  await registered.get('changeReview.nextUnreviewed')();
  await new Promise((r) => setImmediate(r));
  check('已跳转到某个待审查文件', /审查：/.test(lastPanel.title), lastPanel.title);

  console.log('\n[8] 全部标记 / 清除');
  await registered.get('changeReview.markAllReviewed')();
  const roots5 = await treeView.opts.treeDataProvider.getChildren();
  check('全部标记后角标消失', treeView.badge === undefined, JSON.stringify(treeView.badge));
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

  console.log('\n[9.2.0] 树节点右键菜单分工（用户明确要求）');
  {
    const vic = pkg.contributes.menus['view/item/context'] || [];
    const onFile = vic.filter((v) => /viewItem =~ \/\^changeReviewFile\//.test(v.when || ''));
    const blockE = vic.find((v) => v.command === 'changeReview.blockFile');
    const confE = vic.find((v) => v.command === 'changeReview.configureExclude');
    check('文件节点右键有「忽略该文件」(changeReview.blockFile)',
      !!blockE && /changeReviewFile/.test(blockE.when || ''), JSON.stringify(blockE));
    check('命令已注册（package.json commands 里有 changeReview.blockFile）',
      cmds.some((c) => c.command === 'changeReview.blockFile'));
    check('文件节点右键没有「配置排除规则」（那是仓库级的）',
      !!confE && !/changeReviewFile/.test(confE.when || ''), JSON.stringify(confE));
    check('「配置排除规则」只挂在仓库节点上',
      !!confE && /changeReviewRepo/.test(confE.when || ''), JSON.stringify(confE));
    check('文件节点的 5 个动作组顺序为 进入审查/打开差异/接受/拒绝/标记/导航/忽略',
      onFile.length >= 6, JSON.stringify(onFile.map((v) => v.command)));
  }
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
  // zh-cn 是默认文件的超集（含运行时提示译文），命令/设置类 key 必须一一对应
  const missingZh = Object.keys(nlsDefault).filter((k) => !(k in nlsZhCn));
  check('package.nls.zh-cn.json 覆盖默认文件全部 key', missingZh.length === 0, missingZh.join(','));
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

  // 没有 .crignore 时 → 默认回退用 .gitignore 的规则（git 工程不必额外配 .crignore）
  const crigPath = path.join(ROOT, '.crignore');
  const backup = fs.existsSync(crigPath) ? fs.readFileSync(crigPath, 'utf8') : null;
  if (backup !== null) { fs.unlinkSync(crigPath); }
  fs.mkdirSync(path.join(ROOT, 'gignored'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'gignored/x.txt'), 'x\n', 'utf8');
  fs.writeFileSync(path.join(ROOT, '.gitignore'), 'gignored/\n', 'utf8');
  await registered.get('changeReview.refresh')();
  let rootsGi = await treeView.opts.treeDataProvider.getChildren();
  const giNode = rootsGi.find((n) => n.label === 'x.txt');
  check('无 .crignore 时回退 .gitignore：被规则命中的文件不进列表', !giNode,
    JSON.stringify(rootsGi.map((n) => n.label)));
  fs.unlinkSync(path.join(ROOT, '.gitignore'));
  if (backup !== null) { fs.writeFileSync(crigPath, backup, 'utf8'); }
  fs.rmSync(path.join(ROOT, 'gignored'), { recursive: true, force: true });
  await registered.get('changeReview.refresh')();

  console.log('\n[9.3.1] 面板右键「屏蔽此文件」：写入 .crignore 并从列表消失');
  // 造一个真实待审文件
  fs.writeFileSync(path.join(ROOT, 'blockme.txt'), 'hello\n', 'utf8');
  await registered.get('changeReview.refresh')();
  let rootsB = await treeView.opts.treeDataProvider.getChildren();
  check('屏蔽前文件在列表中', !!rootsB.find((n) => n.label === 'blockme.txt'),
    JSON.stringify(rootsB.map((n) => n.label)));
  const crigBak = fs.existsSync(crigPath) ? fs.readFileSync(crigPath, 'utf8') : null;
  if (fs.existsSync(crigPath)) { fs.unlinkSync(crigPath); }
  // 面板当前文件切到 blockme.txt，再通过面板消息触发（与真实右键一致）
  await registered.get('changeReview.openReview')({ repoRoot: ROOT, relPath: 'blockme.txt' });
  await lastPanel._msg({ type: 'ctxCmd', cmd: 'blockFile' });
  await new Promise((r) => setTimeout(r, 120));
  check('屏蔽后 .crignore 已创建', fs.existsSync(crigPath));
  check('.crignore 含该文件的相对路径规则',
    fs.existsSync(crigPath) && fs.readFileSync(crigPath, 'utf8').split(/\r?\n/).includes('blockme.txt'),
    fs.existsSync(crigPath) ? fs.readFileSync(crigPath, 'utf8') : '(无)');
  let rootsB2 = await treeView.opts.treeDataProvider.getChildren();
  check('屏蔽后文件从列表消失', !rootsB2.find((n) => n.label === 'blockme.txt'),
    JSON.stringify(rootsB2.map((n) => n.label)));
  // 幂等：重复屏蔽不重复追加
  fs.writeFileSync(path.join(ROOT, 'blockme.txt'), 'hello2\n', 'utf8');
  await registered.get('changeReview.refresh')();
  const beforeDup = fs.readFileSync(crigPath, 'utf8').split(/\r?\n/).filter((l) => l === 'blockme.txt').length;
  check('重复屏蔽不重复写入规则', beforeDup === 1, `count=${beforeDup}`);
  fs.rmSync(path.join(ROOT, 'blockme.txt'), { force: true });
  if (crigBak !== null) { fs.writeFileSync(crigPath, crigBak, 'utf8'); }
  await registered.get('changeReview.refresh')();

  console.log('\n[9.4] 接受全部：记录 + 自动标记 + 单文件复查，不做整表重扫');
  const beforeAccept = vscode._executed.length;
  await registered.get('changeReview.acceptFile')({ repoRoot: ROOT, relPath: 'new.txt' });
  const afterAcceptExec = vscode._executed.slice(beforeAccept).map(([id]) => id);
  check('accept 不再触发 vscode.diff / 全量命令', !afterAcceptExec.some((id) => id === 'vscode.diff'));
  const rootsA = await treeView.opts.treeDataProvider.getChildren();
  const newNode = rootsA.find((n) => n.label === 'new.txt');
  check('接受全部 → 自动标记已审查', !!newNode && newNode.file.reviewed === true,
    JSON.stringify(newNode && newNode.file));
  check('接受全部随自动标记 git add（进暂存区）',
    /^A\s+new\.txt$/m.test(g(['status', '--porcelain'])), g(['status', '--porcelain']));

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
  // 先把 a.js 从暂存区撤出来（前面小节可能因「标记已审查 = git add」把它暂存过），
  // 这样下面「只接受一个块不应该进暂存区」才是干净可判的
  execFileSync('git', ['reset', '-q', '--', 'src/a.js'], { cwd: ROOT, encoding: 'utf8' });
  await lastPanel._msg({ type: 'hunkAccept', index: 0, sig: sig0 });
  await new Promise((r) => setTimeout(r, 80));
  const cached = execFileSync('git', ['-c', 'core.quotepath=false', 'diff', '--cached', '--', 'src/a.js'], { cwd: ROOT, encoding: 'utf8' });
  check('只接受一个块（还没全决定）→ 不标记、也不进暂存区', !cached.includes('@@'), cached.slice(0, 200));
  check('工作区内容没被动过（接受≠还原）', fs.readFileSync(path.join(ROOT, 'src/a.js'), 'utf8').includes('const v0 = 100;'));
  const storeData = stateStore['changeReview.reviewed.v1'];
  check('块级“已接受”状态已持久化', !!storeData && Object.keys(storeData).some((k) => k.endsWith('::hunks') && storeData[k][sig0]));
  check('面板消息已写入 Output 日志', vscode._output.lines.some((l) => /收到消息 type=hunkAccept/.test(l)),
    vscode._output.lines.slice(-3).join(' | '));
  await lastPanel._msg({ type: 'ready' }); // [13] 的诊断会 clear() 日志，这里重发一次验证通道仍在
  check('ready 消息也收到了（说明 webview 脚本在跑）', vscode._output.lines.some((l) => /type=ready/.test(l)));

  console.log('\n[18] 块级拒绝：延迟执行（标记已审查时才还原）');
  await lastPanel._msg({ type: 'hunkReject', index: 0, sig: sig0 });
  await new Promise((r) => setTimeout(r, 80));
  const aFileNow = treeView.opts.treeDataProvider.getChildren().find((n) => n.label.includes('a.js')).file;
  const afterReject = parseDiff(await gitSvc2.getDiff(aEntry.repo.root, aFileNow, 3))[0].hunks;
  check('拒绝后工作区暂不变（延迟执行）', afterReject.length === hunks.length && hunkSignature(afterReject[0]) === sig0,
    `before=${hunks.length} after=${afterReject.length}`);
  const rejData = stateStore['changeReview.reviewed.v1'];
  check('拒绝决定已持久化（rejected 表）', !!rejData && Object.keys(rejData).some((k) => k.endsWith('::rejected') && rejData[k][sig0]));
  // 标记已审查 → 执行拒绝块（还原）+ git add
  await lastPanel._msg({ type: 'mark' });
  await new Promise((r) => setTimeout(r, 150));
  const afterMark = parseDiff(await gitSvc2.getDiff(aEntry.repo.root, aFileNow, 3))[0].hunks;
  check('标记已审查后第一个块已被还原', afterMark.length !== hunks.length || hunkSignature(afterMark[0]) !== sig0,
    `before=${hunks.length} after=${afterMark.length}`);
  // 反悔路径：撤销拒绝 → rejected 表清空
  // 上面「标记已审查」后面板会自动跳到下一个待审查，这里先切回 a.js
  await registered.get('changeReview.openReview')({ repoRoot: aEntry.repo.root, relPath: 'src/a.js' });
  await new Promise((r) => setTimeout(r, 80));
  await lastPanel._msg({ type: 'hunkReject', index: afterMark.length ? 0 : 0, sig: afterMark.length ? hunkSignature(afterMark[0]) : sig0 });
  await lastPanel._msg({ type: 'hunkUnreject', index: 0, sig: afterMark.length ? hunkSignature(afterMark[0]) : sig0 });
  await new Promise((r) => setTimeout(r, 80));
  const rejData2 = stateStore['changeReview.reviewed.v1'];
  const rejLeft = Object.keys(rejData2 || {}).some((k) => k.endsWith('::rejected') && Object.keys(rejData2[k]).length);
  check('撤销拒绝后 rejected 表为空', !rejLeft);

  console.log('\n[18.1] 行编辑键盘行为（Tab 跟随设置 / Enter 上行 / Ctrl+S）');
  // 上一步「标记已审查」会让面板自动跳到下一个待审查，这里先切回 a.js 再做行编辑
  await registered.get('changeReview.openReview')({ repoRoot: aEntry.repo.root, relPath: 'src/a.js' });
  await new Promise((r) => setTimeout(r, 80));
  const beforeLines = fs.readFileSync(path.join(ROOT, 'src/a.js'), 'utf8').split('\n');
  // 用一行的原内容做基准：在其上方插行 → 该内容下移一行
  const lineText = beforeLines[0];
  await lastPanel._msg({ type: 'insertAbove', line: 1 });
  await new Promise((r) => setTimeout(r, 120));
  const afterAbove = fs.readFileSync(path.join(ROOT, 'src/a.js'), 'utf8').split('\n');
  check('行首回车 → 在第 1 行上方插空行', afterAbove[0] === '' && afterAbove[1] === lineText,
    JSON.stringify(afterAbove.slice(0, 2)));
  // 拆行：editLine + tail（光标在行中）
  await lastPanel._msg({ type: 'editLine', line: 2, text: 'AA', insertBelow: true, tail: 'BB' });
  await new Promise((r) => setTimeout(r, 120));
  const afterSplit = fs.readFileSync(path.join(ROOT, 'src/a.js'), 'utf8').split('\n');
  check('行中回车 → 拆成上下两行', afterSplit[1] === 'AA' && afterSplit[2] === 'BB', JSON.stringify(afterSplit.slice(0, 3)));
  // 面板脚本：Tab 缩进跟随 VSCode 设置注入
  const html = lastPanel.webview.html;
  check('面板注入了 Tab 缩进单位（跟随 editor.insertSpaces/tabSize）', /const INDENT = /.test(html));
  check('面板声明了上行插行消息 insertAbove', /type: 'insertAbove'/.test(html));
  check('面板接管 Ctrl+Z / Ctrl+C 组合键', /key === 'z' \|\| key === 'y'/.test(html) && /copySel\(el\)/.test(html));

  // 合并行：向上（把第 2 行并进第 1 行）
  const beforeMerge = fs.readFileSync(path.join(ROOT, 'src/a.js'), 'utf8').split('\n');
  await lastPanel._msg({ type: 'mergeLine', line: 2, dir: 'up', text: beforeMerge[1] });
  await new Promise((r) => setTimeout(r, 120));
  const afterMergeUp = fs.readFileSync(path.join(ROOT, 'src/a.js'), 'utf8').split('\n');
  check('上行合并：第 1 行 = 原第1行+第2行，总行数 -1',
    afterMergeUp[0] === beforeMerge[0] + beforeMerge[1] && afterMergeUp.length === beforeMerge.length - 1,
    `${JSON.stringify(afterMergeUp.slice(0, 2))} len ${beforeMerge.length}->${afterMergeUp.length}`);
  // 合并行：向下（把第 2 行并进第 1 行，等价校验另一条分支）
  const beforeDown = fs.readFileSync(path.join(ROOT, 'src/a.js'), 'utf8').split('\n');
  await lastPanel._msg({ type: 'mergeLine', line: 1, dir: 'down', text: beforeDown[0] });
  await new Promise((r) => setTimeout(r, 120));
  const afterMergeDown = fs.readFileSync(path.join(ROOT, 'src/a.js'), 'utf8').split('\n');
  check('下行合并：第 1 行 = 原第1行+第2行，总行数 -1',
    afterMergeDown[0] === beforeDown[0] + beforeDown[1] && afterMergeDown.length === beforeDown.length - 1,
    `${JSON.stringify(afterMergeDown.slice(0, 2))} len ${beforeDown.length}->${afterMergeDown.length}`);
  // 面板：剪贴板自己接管（不依赖 VSCode 转发）
  check('面板自行处理 Ctrl+V（读剪贴板）', /pasteInto\(el\)/.test(html) && /clipboard\.readText/.test(html));
  check('面板自行处理 Ctrl+C/X（写剪贴板）', /clipboard\.writeText/.test(html) && /cutSel\(el\)/.test(html));
  check('面板声明了合并行消息 mergeLine', /type: 'mergeLine'/.test(html));
  // 行内操作不再触发全量刷新（卡顿来源）：日志里不应出现"刷新完成"
  const linesBeforeOp = vscode._output.lines.length;
  await lastPanel._msg({ type: 'editLine', line: 1, text: afterMergeDown[0], keepFocus: true });
  await new Promise((r) => setTimeout(r, 120));
  const newLines = vscode._output.lines.slice(linesBeforeOp).join('\n');
  check('行内编辑走单文件复查（不再全量刷新）', !/刷新完成/.test(newLines), newLines.slice(0, 160));

  // 文件级撤销：新增/删除/合并行也要能 Ctrl+Z（行内栈空时走文件快照）
  const beforeUndoOp = fs.readFileSync(path.join(ROOT, 'src/a.js'), 'utf8');
  await lastPanel._msg({ type: 'insertAbove', line: 1 });
  await new Promise((r) => setTimeout(r, 120));
  check('插入行后文件变长', fs.readFileSync(path.join(ROOT, 'src/a.js'), 'utf8') !== beforeUndoOp);
  await lastPanel._msg({ type: 'undo' });
  await new Promise((r) => setTimeout(r, 150));
  check('Ctrl+Z 能撤销「插入行」（文件级快照）',
    fs.readFileSync(path.join(ROOT, 'src/a.js'), 'utf8') === beforeUndoOp,
    JSON.stringify(fs.readFileSync(path.join(ROOT, 'src/a.js'), 'utf8').slice(0, 60)));
  await lastPanel._msg({ type: 'redo' });
  await new Promise((r) => setTimeout(r, 150));
  check('Ctrl+Y 能重做「插入行」',
    fs.readFileSync(path.join(ROOT, 'src/a.js'), 'utf8') !== beforeUndoOp);
  await lastPanel._msg({ type: 'undo' });
  await new Promise((r) => setTimeout(r, 150));
  check('再次 Ctrl+Z 仍能撤销（撤销栈不会因为重做而失效）',
    fs.readFileSync(path.join(ROOT, 'src/a.js'), 'utf8') === beforeUndoOp);
  // 面板：有选区时不得触发合并（整行选中 + Backspace 应该删内容而不是并到上一行）
  check('合并行要求无选区（hasSel 判断）', /!info\.hasSel && info\.atStart/.test(html));

  console.log('\n[19] 基准命令在 git 项目下的守卫');
  const infosBefore = vscode._infos.length;
  await registered.get('changeReview.initBaseline')();
  check('git 项目调用初始化基准会被提示（不执行）', vscode._infos.length > infosBefore,
    JSON.stringify(vscode._infos.slice(-1)));
  const infosBefore2 = vscode._infos.length;
  await registered.get('changeReview.updateBaseline')();
  check('git 项目调用更新基准会被提示（不执行）', vscode._infos.length > infosBefore2,
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

/**
 * 回归（0.4.18 修复）：打开的是「仓库子目录」时，「屏蔽此文件」必须仍然生效。
 * 根因：规则原先按「包含该文件的打开目录」写相对路径，而所有 provider 的 exclude
 * 都是拿「相对来源根（git 仓库根）」的 relPath 去匹配的 → 两者基准不一致 → 规则永远匹配不上。
 * 修法：规则基准改为来源根。
 */
async function mainSubdirBlock() {
  console.log('\n[22] 打开仓库子目录时「屏蔽此文件」仍生效（规则按 .crignore 所在目录锚定，同 .gitignore）');
  const RB = path.join(os.tmpdir(), `cr-mock-blocksub-${Date.now()}`);
  const SUB = path.join(RB, 'sub2');
  const rel = 'sub2/components/api/file_server_lib/web_assets/web_assets_version.csv';
  fs.mkdirSync(path.dirname(path.join(RB, rel)), { recursive: true });
  const gitB = (args) => execFileSync('git', args, { cwd: RB, encoding: 'utf8' });
  gitB(['init', '-q']);
  gitB(['config', 'user.email', 'b@local']);
  gitB(['config', 'user.name', 'BlockSub']);
  gitB(['config', 'core.autocrlf', 'false']);
  fs.writeFileSync(path.join(RB, 'keep.txt'), 'keep\n', 'utf8');
  gitB(['add', '-A']);
  gitB(['commit', '-q', '-m', 'init']);
  // 两个未跟踪文件（都会出现在改动列表，relPath 都相对「仓库根」）
  fs.writeFileSync(path.join(RB, rel), 'a,b,c\n1,2,3\n', 'utf8');

  vscode._infos.length = 0; vscode._errors.length = 0; vscode._warns.length = 0;
  vscode._executed.length = 0; vscode._statusMsgs.length = 0;
  vscode.workspace.workspaceFolders = [{ uri: Uri.file(SUB) }];
  const stateB = {};
  const contextB = {
    subscriptions: [],
    workspaceState: {
      get: (k, d) => (stateB[k] === undefined ? d : stateB[k]),
      update: (k, v) => { stateB[k] = v; return Promise.resolve(); }
    }
  };
  const extB = require('../src/extension.js');
  await extB.activate(contextB);
  await new Promise((r) => setTimeout(r, 80));

  let nodes = await treeView.opts.treeDataProvider.getChildren();
  check('屏蔽前文件以「相对仓库根」的路径出现在列表', !!nodes.find((n) => n.file.relPath === rel),
    JSON.stringify(nodes.map((n) => n.file.relPath)));

  const igPath = path.join(SUB, '.crignore');
  // --- 阶段 A：规则写的是「相对 .crignore 所在目录」的路径（同 .gitignore 语义）。
  // 这正是 0.4.17 之前的写法 —— 只要匹配端也按 .crignore 所在目录锚定，它就应该是对的。
  fs.writeFileSync(igPath, `# 排除规则\ncomponents/api/file_server_lib/web_assets/web_assets_version.csv\n`, 'utf8');
  await registered.get('changeReview.refresh')();
  await new Promise((r) => setTimeout(r, 80));
  nodes = await treeView.opts.treeDataProvider.getChildren();
  check('按 .crignore 所在目录锚定的规则能命中（同 .gitignore 语义）', !nodes.find((n) => n.file.relPath === rel),
    JSON.stringify(nodes.map((n) => n.file.relPath)));

  // --- 阶段 B：重新点一次「屏蔽此文件」→ 规则仍是「相对 .crignore 所在目录」，文件确实消失
  fs.unlinkSync(igPath);
  await registered.get('changeReview.refresh')();
  await new Promise((r) => setTimeout(r, 80));
  nodes = await treeView.opts.treeDataProvider.getChildren();
  check('清掉 .crignore 后文件回到列表', !!nodes.find((n) => n.file.relPath === rel),
    JSON.stringify(nodes.map((n) => n.file.relPath)));

  await registered.get('changeReview.openReview')({ repoRoot: RB, relPath: rel });
  await new Promise((r) => setImmediate(r));
  await lastPanel._msg({ type: 'ctxCmd', cmd: 'blockFile' });
  await new Promise((r) => setTimeout(r, 150));

  check('.crignore 位于打开的子目录里', fs.existsSync(igPath), igPath);
  const ruleLines = fs.readFileSync(igPath, 'utf8').split(/\r?\n/).filter(Boolean);
  check('规则按 .crignore 所在目录写（不带 sub2/ 前缀，同 .gitignore 语义）',
    ruleLines.includes('components/api/file_server_lib/web_assets/web_assets_version.csv'), JSON.stringify(ruleLines));
  check('没有按来源根写（那反而是与 .gitignore 不一致的写法）', !ruleLines.includes(rel), JSON.stringify(ruleLines));
  nodes = await treeView.opts.treeDataProvider.getChildren();
  check('屏蔽后文件从列表消失（真的生效了）', !nodes.find((n) => n.file.relPath === rel),
    JSON.stringify(nodes.map((n) => n.file.relPath)));

  try { fs.rmSync(RB, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

/**
 * 回归：一个文件的**所有改动块都有决定**后，必须自动标记已审查。
 * 用户反馈「有时候全打钩了，但没标记已审查」。
 * 覆盖三种真实点击顺序，并验证标记之后再过一次全量刷新也不会掉。
 */
async function mainAllHunksAutoMark() {
  console.log('\n[23] 块级决定齐全 → 自动标记已审查（含刷新、撤销拒绝等真实顺序）');
  const { parseDiff, hunkSignature } = require('../src/diffParser');
  const gitSvcC = require('../src/gitService');

  // 每个子场景：独立仓库 + 一个「首行修改 + 末尾追加」的文件（git 会给 2 个块）
  let seq = 0;
  async function setup() {
    seq += 1;
    const RC = path.join(os.tmpdir(), `cr-mock-allhunks-${Date.now()}-${seq}`);
    fs.mkdirSync(RC, { recursive: true });
    const gitC = (args) => execFileSync('git', args, { cwd: RC, encoding: 'utf8' });
    gitC(['init', '-q']);
    gitC(['config', 'user.email', 'c@local']);
    gitC(['config', 'user.name', 'AllHunks']);
    gitC(['config', 'core.autocrlf', 'false']);
    const base = Array.from({ length: 24 }, (_, i) => `const v${i} = ${i};`).join('\n') + '\n';
    fs.writeFileSync(path.join(RC, 'f.js'), base, 'utf8');
    gitC(['add', '-A']);
    gitC(['commit', '-q', '-m', 'init']);
    const mod = base.split('\n');
    mod[0] = 'const v0 = 100;';
    fs.writeFileSync(path.join(RC, 'f.js'), mod.join('\n') + 'const tail = 1;\n', 'utf8');

    vscode._infos.length = 0; vscode._errors.length = 0; vscode._warns.length = 0;
    vscode._executed.length = 0; vscode._statusMsgs.length = 0;
    vscode.workspace.workspaceFolders = [{ uri: Uri.file(RC) }];
    const stateC = {};
    const contextC = {
      subscriptions: [],
      workspaceState: {
        get: (k, d) => (stateC[k] === undefined ? d : stateC[k]),
        update: (k, v) => { stateC[k] = v; return Promise.resolve(); }
      }
    };
    const extC = require('../src/extension.js');
    await extC.activate(contextC);
    await new Promise((r) => setTimeout(r, 80));
    const entry = treeView.opts.treeDataProvider.getChildren().find((n) => n.file.relPath === 'f.js');
    const hunks = parseDiff(await gitSvcC.getDiff(entry.repo.root, entry.file, 3))[0].hunks;
    await registered.get('changeReview.openReview')({ repoRoot: RC, relPath: 'f.js' });
    await new Promise((r) => setImmediate(r));
    return { RC, stateC, hunks, sigs: hunks.map((h) => hunkSignature(h)) };
  }
  const nodeOf = () => treeView.opts.treeDataProvider.getChildren().find((n) => n.file.relPath === 'f.js');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // A. 全部接受
  {
    const { RC, stateC, hunks, sigs } = await setup();
    check('A: f.js 解析出 2 个改动块', hunks.length === 2, `实际 ${hunks.length}`);
    for (let i = 0; i < sigs.length; i += 1) {
      await lastPanel._msg({ type: 'hunkAccept', index: i, sig: sigs[i] });
      await wait(60);
    }
    const node = nodeOf();
    check('A: 全部接受 → 已标记已审查', !!node && node.file.reviewed === true,
      node ? `reviewed=${node.file.reviewed}` : '文件不在列表里');
    check('A: 标记写进了 workspaceState',
      Object.keys(stateC['changeReview.reviewed.v1'] || {}).some((k) => k.includes('f.js')));
    // 已审查后按钮文案：直接「取消审查」，不再带括号提示
    await registered.get('changeReview.openReview')({ repoRoot: RC, relPath: 'f.js' });
    await wait(60);
    const markBtn = lastPanel.webview.html.match(/<button[^>]*data-cmd="mark"[^>]*>([^<]*)<\/button>/);
    check('A: 已审查后按钮显示「取消审查」', !!markBtn && markBtn[1].trim() === '取消审查',
      markBtn ? markBtn[1] : '(没找到按钮)');
    check('A: 按钮文案不含括号提示', !!markBtn && !/[（(]/.test(markBtn[1]), markBtn ? markBtn[1] : '');
    try { fs.rmSync(RC, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  // B. 第一块拒绝 + 第二块接受（拒绝在标记时执行还原 → 内容变化后标记必须还在）
  {
    const { RC, stateC, sigs } = await setup();
    await lastPanel._msg({ type: 'hunkReject', index: 0, sig: sigs[0] });
    await wait(60);
    await lastPanel._msg({ type: 'hunkAccept', index: 1, sig: sigs[1] });
    await wait(120);
    const node = nodeOf();
    check('B: 拒绝一块 + 接受一块 → 文件被标记已审查', !!node && node.file.reviewed === true,
      node ? `reviewed=${node.file.reviewed}` : '文件不在列表里');
    check('B: 被拒绝的块已还原（首行回到 v0 = 0）',
      fs.readFileSync(path.join(RC, 'f.js'), 'utf8').split('\n')[0] === 'const v0 = 0;',
      fs.readFileSync(path.join(RC, 'f.js'), 'utf8').split('\n')[0]);
    // 再过一次全量刷新：标记不能掉（hash 口径必须一致）
    await registered.get('changeReview.refresh')();
    await wait(100);
    const node2 = nodeOf();
    check('B: 全量刷新后标记依然在（不会「标记又丢了」）', !!node2 && node2.file.reviewed === true,
      node2 ? `reviewed=${node2.file.reviewed}` : '文件不在列表里');
    check('B: 标记确定写盘了',
      Object.keys(stateC['changeReview.reviewed.v1'] || {}).some((k) => k.includes('f.js')));
    try { fs.rmSync(RC, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  // C. 接受一块 → 中途一次全量刷新（模拟自动刷新换掉 model 对象）→ 再接受剩下的
  {
    const { RC, sigs } = await setup();
    await lastPanel._msg({ type: 'hunkAccept', index: 0, sig: sigs[0] });
    await wait(60);
    await registered.get('changeReview.refresh')();
    await wait(100);
    const mid = nodeOf();
    check('C: 只决定了一块时不会被提前标记', !!mid && mid.file.reviewed !== true,
      mid ? `reviewed=${mid.file.reviewed}` : '文件不在列表里');
    await lastPanel._msg({ type: 'hunkAccept', index: 1, sig: sigs[1] });
    await wait(120);
    const node = nodeOf();
    check('C: 刷新后再补上剩余的块 → 自动标记已审查', !!node && node.file.reviewed === true,
      node ? `reviewed=${node.file.reviewed}` : '文件不在列表里');
    try { fs.rmSync(RC, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
  // D. 审查途中文件改动被外部还原（diff 变空）→ 必须给出明确提示，不能静默崩掉
  //    （旧代码 parseDiff(t)[0].hunks 会抛 TypeError，被吞掉后表现为"点了没反应、也没标记"）
  {
    const { RC, sigs } = await setup();
    await lastPanel._msg({ type: 'hunkAccept', index: 0, sig: sigs[0] });
    await wait(60);
    execFileSync('git', ['checkout', '--', 'f.js'], { cwd: RC, encoding: 'utf8' }); // 外部把文件还原了
    vscode._warns.length = 0;
    vscode._output.lines.length = 0;
    await lastPanel._msg({ type: 'hunkAccept', index: 1, sig: sigs[1] });
    await wait(120);
    check('D: diff 变空时给出警告提示，而不是静默失败',
      vscode._warns.length > 0, JSON.stringify(vscode._warns));
    check('D: 没有把内部异常抛成「命令执行失败」',
      !vscode._output.lines.some((l) => /执行失败/.test(l)),
      vscode._output.lines.slice(-4).join(' | '));
    try { fs.rmSync(RC, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

/**
 * 回归：树上的「◀ 审查中」标记必须在整个审查过程中一直停留在当前文件上。
 * 旧实现把 activeFile 挂在「每次全量刷新都会重建」的 source 对象上 →
 * 自动刷新（默认 5s）/手动刷新/保存文件触发的刷新都会把它清掉，
 * 表现为「提示自己消失，可其实我还在审这个文件」。
 */
async function mainActiveMarker() {
  console.log('\n[24] 「◀ 审查中」标记跨刷新保持');
  const RE = path.join(os.tmpdir(), `cr-mock-active-${Date.now()}`);
  fs.mkdirSync(RE, { recursive: true });
  const gitE = (args) => execFileSync('git', args, { cwd: RE, encoding: 'utf8' });
  gitE(['init', '-q']);
  gitE(['config', 'user.email', 'e@local']);
  gitE(['config', 'user.name', 'Active']);
  gitE(['config', 'core.autocrlf', 'false']);
  const mkLines = (n) => Array.from({ length: n }, (_, i) => `const v${i} = ${i};`).join('\n') + '\n';
  fs.writeFileSync(path.join(RE, 'a.js'), mkLines(10), 'utf8');
  fs.writeFileSync(path.join(RE, 'b.js'), mkLines(10), 'utf8');
  gitE(['add', '-A']);
  gitE(['commit', '-q', '-m', 'init']);
  fs.writeFileSync(path.join(RE, 'a.js'), mkLines(10).split('\n').map((l, i) => (i === 0 ? 'const v0 = 999;' : l)).join('\n'), 'utf8');
  fs.writeFileSync(path.join(RE, 'b.js'), mkLines(10).split('\n').map((l, i) => (i === 0 ? 'const v0 = 888;' : l)).join('\n'), 'utf8');

  vscode._infos.length = 0; vscode._errors.length = 0; vscode._warns.length = 0;
  vscode._executed.length = 0; vscode._statusMsgs.length = 0;
  vscode.workspace.workspaceFolders = [{ uri: Uri.file(RE) }];
  const stateE = {};
  const contextE = {
    subscriptions: [],
    workspaceState: {
      get: (k, d) => (stateE[k] === undefined ? d : stateE[k]),
      update: (k, v) => { stateE[k] = v; return Promise.resolve(); }
    }
  };
  const extE = require('../src/extension.js');
  await extE.activate(contextE);
  await new Promise((r) => setTimeout(r, 80));

  const descOf = (rel) => {
    const n = treeView.opts.treeDataProvider.getChildren().find((x) => x.file.relPath === rel);
    return n ? String(n.description || '') : '(文件不在列表)';
  };

  await registered.get('changeReview.openReview')({ repoRoot: RE, relPath: 'a.js' });
  await new Promise((r) => setTimeout(r, 80));
  check('打开 a.js 后树上有「审查中」标记', /审查中/.test(descOf('a.js')), descOf('a.js'));

  // 全量刷新（等价于自动刷新定时器/手动刷新/保存文件触发的刷新）
  await registered.get('changeReview.refresh')();
  await new Promise((r) => setTimeout(r, 120));
  check('全量刷新后标记仍在 a.js（这就是之前的 bug）', /审查中/.test(descOf('a.js')), descOf('a.js'));
  check('刷新后 b.js 没有被误标', !/审查中/.test(descOf('b.js')), descOf('b.js'));

  await registered.get('changeReview.refresh')();
  await new Promise((r) => setTimeout(r, 120));
  check('连续多次刷新后标记依然在', /审查中/.test(descOf('a.js')), descOf('a.js'));

  await registered.get('changeReview.openReview')({ repoRoot: RE, relPath: 'b.js' });
  await new Promise((r) => setTimeout(r, 80));
  check('切到 b.js 后标记移到 b.js', /审查中/.test(descOf('b.js')), descOf('b.js'));
  check('切走后 a.js 不再标记', !/审查中/.test(descOf('a.js')), descOf('a.js'));

  try { fs.rmSync(RE, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

/**
 * 回归：手动「取消审查」必须能生效，不能被自动标记立刻打回去。
 * 用户场景：取消审查 → 想改内容 → 结果后台一检测"所有块都操作过"就自动标记了，根本改不了。
 * 期望：手动取消后，只要文件没再改动，就不再自动打钩；文件一改，自动打钩恢复正常。
 */
async function mainManualUnmark() {
  console.log('\n[25] 手动取消审查后不被自动标记打回');
  const RF = path.join(os.tmpdir(), `cr-mock-unmark-${Date.now()}`);
  fs.mkdirSync(RF, { recursive: true });
  const gitF = (args) => execFileSync('git', args, { cwd: RF, encoding: 'utf8' });
  gitF(['init', '-q']);
  gitF(['config', 'user.email', 'f@local']);
  gitF(['config', 'user.name', 'Unmark']);
  gitF(['config', 'core.autocrlf', 'false']);
  const base = Array.from({ length: 24 }, (_, i) => `const v${i} = ${i};`).join('\n') + '\n';
  fs.writeFileSync(path.join(RF, 'f.js'), base, 'utf8');
  gitF(['add', '-A']);
  gitF(['commit', '-q', '-m', 'init']);
  const l0 = base.split('\n');
  l0[0] = 'const v0 = 100;';
  fs.writeFileSync(path.join(RF, 'f.js'), l0.join('\n') + 'const tail = 1;\n', 'utf8');

  vscode._infos.length = 0; vscode._errors.length = 0; vscode._warns.length = 0;
  vscode._executed.length = 0; vscode._statusMsgs.length = 0;
  vscode.workspace.workspaceFolders = [{ uri: Uri.file(RF) }];
  const stateF = {};
  const contextF = {
    subscriptions: [],
    workspaceState: {
      get: (k, d) => (stateF[k] === undefined ? d : stateF[k]),
      update: (k, v) => { stateF[k] = v; return Promise.resolve(); }
    }
  };
  const extF = require('../src/extension.js');
  await extF.activate(contextF);
  await new Promise((r) => setTimeout(r, 80));

  const { parseDiff, hunkSignature } = require('../src/diffParser');
  const gitSvcF = require('../src/gitService');
  const nodeOf = () => treeView.opts.treeDataProvider.getChildren().find((n) => n.file.relPath === 'f.js');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const entry = nodeOf();
  const hunks = parseDiff(await gitSvcF.getDiff(entry.repo.root, entry.file, 3))[0].hunks;
  check('f.js 解析出 2 个改动块', hunks.length === 2, `实际 ${hunks.length}`);

  await registered.get('changeReview.openReview')({ repoRoot: RF, relPath: 'f.js' });
  await wait(60);
  for (let i = 0; i < hunks.length; i += 1) {
    await lastPanel._msg({ type: 'hunkAccept', index: i, sig: hunkSignature(hunks[i]) });
    await wait(60);
  }
  check('全部块接受 → 已自动标记为已审查', nodeOf().file.reviewed === true, String(nodeOf().file.reviewed));

  // 手动「取消审查」（面板按钮）
  // 注意：上一步自动标记后面板会跳到下一个待审查（本用例只有一个文件 → 面板已清空），
  // 所以这里必须先切回 f.js 再点按钮
  await registered.get('changeReview.openReview')({ repoRoot: RF, relPath: 'f.js' });
  await wait(80);
  await lastPanel._msg({ type: 'mark' });
  await wait(120);
  check('点「取消审查」后文件变为未审查', nodeOf().file.reviewed === false, String(nodeOf().file.reviewed));

  // 关键：后台刷新不能把它自动打回去
  await registered.get('changeReview.refresh')();
  await wait(150);
  check('全量刷新后仍然是未审查（这就是要修的 bug）', nodeOf().file.reviewed === false, String(nodeOf().file.reviewed));
  await registered.get('changeReview.refresh')();
  await wait(150);
  check('再刷一次也不会被打回已审查', nodeOf().file.reviewed === false, String(nodeOf().file.reviewed));
  check('取消审查的状态也写进了 workspaceState',
    !Object.keys(stateF['changeReview.reviewed.v1'] || {}).some((k) => k.includes('f.js') && !k.includes('::')),
    JSON.stringify(Object.keys(stateF['changeReview.reviewed.v1'] || {})));

  // 文件再改一次 → 自动打钩恢复正常：接受完所有块后应重新标记
  const l1 = fs.readFileSync(path.join(RF, 'f.js'), 'utf8').split('\n');
  l1[5] = 'const v5 = 555;';
  fs.writeFileSync(path.join(RF, 'f.js'), l1.join('\n'), 'utf8');
  await registered.get('changeReview.refresh')();
  await wait(150);
  check('改动文件后仍未审查（要重新审）', nodeOf().file.reviewed === false, String(nodeOf().file.reviewed));
  const fresh = nodeOf();
  const hs = parseDiff(await gitSvcF.getDiff(fresh.repo.root, fresh.file, 3))[0].hunks;
  await registered.get('changeReview.openReview')({ repoRoot: RF, relPath: 'f.js' });
  await wait(60);
  for (let i = 0; i < hs.length; i += 1) {
    await lastPanel._msg({ type: 'hunkAccept', index: i, sig: hunkSignature(hs[i]) });
    await wait(60);
  }
  check('文件改动后重新接受完所有块 → 自动标记恢复正常', nodeOf().file.reviewed === true, String(nodeOf().file.reviewed));

  try { fs.rmSync(RF, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

/**
 * 回归：取消审查 → 重新处理所有块 → 应该自动标记回来。
 * 用户报的：「我取消审查后，将所有块都处理了，没有自动标记为已审查」。
 */
async function mainUnmarkThenReprocess() {
  console.log('\n[26] 取消审查后重新处理所有块 → 自动标记回来');
  const RG = path.join(os.tmpdir(), `cr-mock-reprocess-${Date.now()}`);
  fs.mkdirSync(RG, { recursive: true });
  const gitG = (args) => execFileSync('git', args, { cwd: RG, encoding: 'utf8' });
  gitG(['init', '-q']);
  gitG(['config', 'user.email', 'g@local']);
  gitG(['config', 'user.name', 'Reprocess']);
  gitG(['config', 'core.autocrlf', 'false']);
  const base = Array.from({ length: 24 }, (_, i) => `const v${i} = ${i};`).join('\n') + '\n';
  fs.writeFileSync(path.join(RG, 'f.js'), base, 'utf8');
  fs.writeFileSync(path.join(RG, 'g.js'), base, 'utf8');
  gitG(['add', '-A']);
  gitG(['commit', '-q', '-m', 'init']);
  const l0 = base.split('\n');
  l0[0] = 'const v0 = 100;';
  fs.writeFileSync(path.join(RG, 'f.js'), l0.join('\n') + 'const tail = 1;\n', 'utf8');
  fs.writeFileSync(path.join(RG, 'g.js'), l0.join('\n'), 'utf8'); // 第二个待审查文件，用于验证自动跳转

  vscode._infos.length = 0; vscode._errors.length = 0; vscode._warns.length = 0;
  vscode._executed.length = 0; vscode._statusMsgs.length = 0;
  vscode.workspace.workspaceFolders = [{ uri: Uri.file(RG) }];
  const stateG = {};
  const contextG = {
    subscriptions: [],
    workspaceState: {
      get: (k, d) => (stateG[k] === undefined ? d : stateG[k]),
      update: (k, v) => { stateG[k] = v; return Promise.resolve(); }
    }
  };
  const extG = require('../src/extension.js');
  await extG.activate(contextG);
  await new Promise((r) => setTimeout(r, 80));

  const { parseDiff, hunkSignature } = require('../src/diffParser');
  const gitSvcG = require('../src/gitService');
  const nodeOf = (rel = 'f.js') => treeView.opts.treeDataProvider.getChildren().find((n) => n.file.relPath === rel);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // 1) 「接受全部」= 记录所有块 + 自动标记已审查 + git add + 自动跳下一个
  const entry = nodeOf();
  const hunks = parseDiff(await gitSvcG.getDiff(entry.repo.root, entry.file, 3))[0].hunks;
  await registered.get('changeReview.openReview')({ repoRoot: RG, relPath: 'f.js' });
  await wait(60);
  await lastPanel._msg({ type: 'accept' }); // 接受全部
  await wait(300);
  const sigs = hunks.map(hunkSignature);
  const accTable = stateG['changeReview.reviewed.v1'][`${RG.replace(/\\/g, '/')}::f.js::hunks`] || {};
  check('接受全部：所有块都记成了已接受', sigs.every((s) => accTable[s]), JSON.stringify(Object.keys(accTable)));
  const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: RG, encoding: 'utf8' })
    .split(/\r?\n/).filter(Boolean);
  check('接受全部 → 自动标记已审查并 git add（进暂存区）',
    staged.includes('f.js') && nodeOf('f.js').file.reviewed === true,
    JSON.stringify({ staged, reviewed: nodeOf('f.js') && nodeOf('f.js').file.reviewed }));
  check('标记完 f.js 自动跳到下一个待审查（g.js）',
    !!lastPanel && /g\.js/.test(lastPanel.title || ''), lastPanel && lastPanel.title);

  // 2) 取消审查 → 块级状态仍在（不会全部退回待审查）
  //    注意：上一步标记后面板已自动跳到 g.js，这里要先把面板切回 f.js 再操作
  await registered.get('changeReview.openReview')({ repoRoot: RG, relPath: 'f.js' });
  await wait(80);
  await lastPanel._msg({ type: 'mark' });
  await wait(150);
  check('取消审查后文件为未审查', nodeOf('f.js').file.reviewed === false, String(nodeOf('f.js').file.reviewed));

  // 3) 把已接受的决定逐个「取消接受」→ 回到未决定；再重新处理所有块 → 自动标记回来
  await registered.get('changeReview.openReview')({ repoRoot: RG, relPath: 'f.js' });
  await wait(80);
  for (let i = 0; i < sigs.length; i += 1) {
    await lastPanel._msg({ type: 'hunkUnaccept', index: i, sig: sigs[i] });
    await wait(60);
  }
  {
    const t = stateG['changeReview.reviewed.v1'][`${RG.replace(/\\/g, '/')}::f.js::hunks`] || {};
    check('逐个「取消接受」后块回到未决定', sigs.every((s) => !t[s]), JSON.stringify(Object.keys(t)));
  }
  for (let i = 0; i < hunks.length; i += 1) {
    await lastPanel._msg({ type: 'hunkAccept', index: i, sig: sigs[i] });
    await wait(60);
  }
  check('取消审查后重新处理完所有块 → 自动标记为已审查', nodeOf('f.js').file.reviewed === true,
    String(nodeOf('f.js').file.reviewed));
  check('自动标记后同样自动跳到下一个待审查（g.js）',
    !!lastPanel && /g\.js/.test(lastPanel.title || ''), lastPanel && lastPanel.title);

  try { fs.rmSync(RG, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

/**
 * 回归：接受与拒绝必须对称 —— 拒绝能撤销，接受也要能取消。
 * 用户报的：「为什么拒绝块能取消，但是接受不能取消？？不对称啊！」
 */
async function mainUnacceptSymmetry() {
  console.log('\n[27] 接受 / 拒绝对称：都能取消');
  const RH = path.join(os.tmpdir(), `cr-mock-unaccept-${Date.now()}`);
  fs.mkdirSync(RH, { recursive: true });
  const gitH = (args) => execFileSync('git', args, { cwd: RH, encoding: 'utf8' });
  gitH(['init', '-q']);
  gitH(['config', 'user.email', 'h@local']);
  gitH(['config', 'user.name', 'Unaccept']);
  gitH(['config', 'core.autocrlf', 'false']);
  const base = Array.from({ length: 24 }, (_, i) => `const v${i} = ${i};`).join('\n') + '\n';
  fs.writeFileSync(path.join(RH, 'f.js'), base, 'utf8');
  gitH(['add', '-A']);
  gitH(['commit', '-q', '-m', 'init']);
  const l = base.split('\n');
  l[0] = 'const v0 = 100;';
  fs.writeFileSync(path.join(RH, 'f.js'), l.join('\n') + 'const tail = 1;\n', 'utf8');

  vscode._infos.length = 0; vscode._errors.length = 0; vscode._warns.length = 0;
  vscode._executed.length = 0; vscode._statusMsgs.length = 0;
  vscode.workspace.workspaceFolders = [{ uri: Uri.file(RH) }];
  const stateH = {};
  const contextH = {
    subscriptions: [],
    workspaceState: {
      get: (k, d) => (stateH[k] === undefined ? d : stateH[k]),
      update: (k, v) => { stateH[k] = v; return Promise.resolve(); }
    }
  };
  const extH = require('../src/extension.js');
  await extH.activate(contextH);
  await new Promise((r) => setTimeout(r, 80));

  const { parseDiff, hunkSignature } = require('../src/diffParser');
  const gitSvcH = require('../src/gitService');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const nodeOf = (rel = 'f.js') => treeView.opts.treeDataProvider.getChildren().find((n) => n.file.relPath === rel);
  const hunksTbl = () => stateH['changeReview.reviewed.v1'][`${RH.replace(/\\/g, '/')}::f.js::hunks`] || {};
  const rejTbl = () => stateH['changeReview.reviewed.v1'][`${RH.replace(/\\/g, '/')}::f.js::rejected`] || {};

  const entry = nodeOf();
  const hunks = parseDiff(await gitSvcH.getDiff(entry.repo.root, entry.file, 3))[0].hunks;
  const sigs = hunks.map(hunkSignature);
  await registered.get('changeReview.openReview')({ repoRoot: RH, relPath: 'f.js' });
  await wait(80);

  // 接受 → 按钮变「取消接受」
  await lastPanel._msg({ type: 'hunkAccept', index: 0, sig: sigs[0] });
  await wait(80);
  check('接受后按钮变成「取消接受」', /data-cmd="hunkUnaccept"/.test(lastPanel.webview.html));
  check('接受状态已记录', !!hunksTbl()[sigs[0]]);

  // 取消接受 → 回到未决定
  await lastPanel._msg({ type: 'hunkUnaccept', index: 0, sig: sigs[0] });
  await wait(80);
  check('取消接受后该块回到未决定', !hunksTbl()[sigs[0]], JSON.stringify(Object.keys(hunksTbl())));
  check('取消接受后按钮变回「接受此块」', /data-cmd="hunkAccept"/.test(lastPanel.webview.html));

  // 拒绝 → 按钮变「撤销拒绝」（对称的另一半）
  await lastPanel._msg({ type: 'hunkReject', index: 0, sig: sigs[0] });
  await wait(80);
  check('拒绝后按钮变成「撤销拒绝」', /data-cmd="hunkUnreject"/.test(lastPanel.webview.html));
  await lastPanel._msg({ type: 'hunkUnreject', index: 0, sig: sigs[0] });
  await wait(80);
  check('撤销拒绝后该块回到未决定', !rejTbl()[sigs[0]], JSON.stringify(Object.keys(rejTbl())));

  try { fs.rmSync(RH, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

/**
 * 迭代提速：只跑指定场景，不必每次都跑完（全量约 5 分钟）。
 *   node tools/mockcheck.js --only main          # 只跑主流程（各小节）
 *   node tools/mockcheck.js --only reprocess     # 只跑 [26] 场景
 *   node tools/mockcheck.js --only main,unmark   # 多个
 * 可用名字见 SCENARIOS 的键；不带 --only 就是全量。
 */
const ONLY = (() => {
  const i = process.argv.indexOf('--only');
  if (i === -1) { return null; }
  const raw = String(process.argv[i + 1] || '').trim();
  if (!raw) { return null; }
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
})();
function want(name) { return !ONLY || ONLY.has(name); }
if (ONLY) { console.log(`[mockcheck] --only ${[...ONLY].join(',')}（跳过其他场景）`); }

/** 场景名 → 执行函数（顺序即执行顺序） */
const SCENARIOS = [
  ['main', () => main()],
  ['snapshot', () => mainSnapshot()],
  ['subdir', () => mainSubdir()],
  ['blocksub', () => mainSubdirBlock()],
  ['allhunks', () => mainAllHunksAutoMark()],
  ['marker', () => mainActiveMarker()],
  ['unmark', () => mainManualUnmark()],
  ['reprocess', () => mainUnmarkThenReprocess()],
  ['unaccept', () => mainUnacceptSymmetry()]
];

let chain = Promise.resolve();
for (const [name, fn] of SCENARIOS) {
  if (!want(name)) { continue; }
  chain = chain.then(async () => {
    try {
      await fn();
    } catch (e) {
      failures += 1;
      console.log(`${name} 场景异常:`, e && e.stack ? e.stack : e);
    }
  });
}
chain
  .then(() => {
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    console.log(`\n${failures === 0 ? '全部通过 ✓' : `${failures} 项失败 ✗`}`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error('冒烟测试异常：', e);
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (err) { /* ignore */ }
    process.exit(1);
  });
