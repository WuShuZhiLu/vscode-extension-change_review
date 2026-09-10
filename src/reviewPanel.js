'use strict';

const vscode = require('vscode');
const path = require('path');
const { parseDiff, hunkSignature } = require('./diffParser');
const { KIND_LABEL } = require('./treeProvider');
// 面板底部显示当前扩展版本，便于在"功能异常"时一眼确认 webview 用的是不是新脚本
let PANEL_VERSION = '0.4.16';
try { PANEL_VERSION = require('../package.json').version; } catch (e) { /* ignore */ }

// Tab 键插入的内容跟随 VSCode 编辑器设置（editor.insertSpaces / editor.tabSize）
const EDITOR_INDENT = (() => {
  try {
    const c = vscode.workspace.getConfiguration('editor');
    const spaces = c.get('insertSpaces', true);
    const size = Number(c.get('tabSize', 4)) || 4;
    return spaces ? ' '.repeat(size) : '\t';
  } catch (e) { return '  '; } // 读不到就退化为两个空格
})();
const EDITOR_INDENT_LITERAL = JSON.stringify(EDITOR_INDENT);

// ---------- 面板内文字 i18n（随 VSCode 显示语言自动切换，中英双语） ----------
const PANEL_I18N = {
  zh: {
    next: '下一个待审查',
    nextTitle: '跳到下一个未审查的文件',
    refresh: '刷新',
    refreshTitle: '重新扫描改动',
    tip: '行内也可直接编辑',
    acceptAll: '接受全部',
    acceptAllTitle: '接受这些改动并标记已审查（不动文件内容与 git 暂存区；暂存在「标记已审查」时发生）',
    rejectAll: '拒绝全部',
    hunkAccept: '接受此块',
    hunkAcceptTitle: '接受这个改动块（标记为已接受，不动文件内容与暂存区；暂存在「标记已审查」时发生）',
    hunkReject: '拒绝此块',
    hunkRejectTitle: '记录拒绝这个改动块（不立即改文件；标记已审查时统一执行还原，之前可反悔）',
    hunkRejectedBadge: '拒绝·待执行',
    hunkUnreject: '撤销拒绝',
    hunkUnrejectTitle: '取消这个块的拒绝决定，恢复为未决定状态',
    blockFile: '屏蔽此文件',
    blockFileTitle: '把这个文件写入 .crignore，之后不再出现在改动列表里',
    blockFileDone: '已屏蔽 ✓',
    ctxAccept: '接受全部改动',
    ctxReject: '拒绝全部改动',
    ctxMarkReviewed: '标记已审查',
    ctxUnmarkReviewed: '取消审查',
    btnMark: '标记已审查',
    btnUnmark: '取消审查',
    btnMarkTitle: '切换这个文件是否已审查',
    ctxBlock: '屏蔽此文件',
    ctxOpenDiff: '打开新旧对比',
    ctxRefresh: '刷新列表',
    ctxCopyPath: '复制文件路径',
    goto: '跳转',
    gotoTitle: '打开新旧对比视图，定位到该块（右侧可直接编辑）',
    noDiff: '没有可显示的文本差异',
    binaryDiff: '二进制文件，无文本差异',
    largeFile: '文件超过大小限制，未保存基准内容，无法显示逐行差异',
    noDiffsTitle: '该文件已没有与对比基准的差异。',
    edHint: '可直接改这行，改完自动写回文件',
    delHint: '这行已被删除，不在当前文件里',
    kinds: { modified: '修改', added: '新增', deleted: '删除', renamed: '重命名', untracked: '未跟踪', conflict: '冲突', ignored: '忽略' }
  },
  en: {
    next: 'Next to review',
    nextTitle: 'Jump to next unreviewed file',
    refresh: 'Refresh',
    refreshTitle: 'Rescan changes',
    tip: 'Inline editing available',
    acceptAll: 'Accept all',
    acceptAllTitle: 'Accept these changes and mark as reviewed (does not touch file content or git staging; staging happens on "Mark as reviewed")',
    rejectAll: 'Reject all',
    hunkAccept: 'Accept block',
    hunkAcceptTitle: 'Accept this change block (mark as accepted; staging happens on "Mark as reviewed")',
    hunkReject: 'Reject block',
    hunkRejectTitle: 'Mark this block as rejected (file is not changed yet; reverts are applied when the file is marked as reviewed)',
    hunkRejectedBadge: 'Rejected · pending',
    hunkUnreject: 'Undo reject',
    hunkUnrejectTitle: 'Cancel the reject decision for this block (back to undecided)',
    blockFile: 'Ignore this file',
    blockFileTitle: 'Add this file to .crignore so it stops showing up in the change list',
    blockFileDone: 'Ignored ✓',
    ctxAccept: 'Accept all changes',
    ctxReject: 'Reject all changes',
    ctxMarkReviewed: 'Mark as reviewed',
    ctxUnmarkReviewed: 'Unmark reviewed',
    btnMark: 'Mark as reviewed',
    btnUnmark: 'Unmark reviewed',
    btnMarkTitle: 'Toggle whether this file is reviewed',
    ctxBlock: 'Ignore this file (write to .crignore)',
    ctxOpenDiff: 'Open old/new diff',
    ctxRefresh: 'Refresh list',
    ctxCopyPath: 'Copy file path',
    goto: 'Jump',
    gotoTitle: 'Open old/new diff view at this block (right side is editable)',
    noDiff: 'No text differences to show',
    binaryDiff: 'Binary file, no text diff',
    largeFile: 'File exceeds size limit; baseline content not saved, cannot show line-by-line diff',
    noDiffsTitle: 'This file no longer differs from the comparison baseline.',
    edHint: 'Edit inline; changes are saved back to the file automatically',
    delHint: 'This line was deleted and is not in the current file',
    kinds: { modified: 'Modified', added: 'Added', deleted: 'Deleted', renamed: 'Renamed', untracked: 'Untracked', conflict: 'Conflict', ignored: 'Ignored' }
  }
};

function panelLang() {
  // 支持设置强制指定：changeReview.uiLanguage = auto | zh | en（auto 时跟随 VSCode 显示语言）
  try {
    const forced = (vscode.workspace.getConfiguration('changeReview').get('uiLanguage', 'auto') || 'auto').toLowerCase();
    if (forced === 'zh' || forced === 'en') { return forced; }
  } catch (e) { /* 配置读取失败则走自动检测 */ }
  const lang = (vscode.env.language || 'en').toLowerCase();
  return lang.startsWith('zh') ? 'zh' : 'en';
}

function t(key) {
  const lang = panelLang();
  return (PANEL_I18N[lang] && PANEL_I18N[lang][key]) || PANEL_I18N.en[key] || key;
}


function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}


function nonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i += 1) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

function renderRows(hunk, autoFocusLine) {
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;
  const out = [];
  for (const line of hunk.lines) {
    if (line.type === 'meta') {
      out.push(`<div class="row meta"><span class="ln"></span><span class="ln"></span><span class="mk"></span><span class="tx">${escapeHtml(line.text)}</span></div>`);
      continue;
    }
    if (line.type === 'add') {
      const af = autoFocusLine === newNo ? ' data-autofocus="1"' : '';
      out.push(`<div class="row add"><span class="ln"></span><span class="ln">${newNo}</span><span class="mk">+</span><span class="tx ed" contenteditable="true" spellcheck="false" data-line="${newNo}" title="${t('edHint')}"${af}>${escapeHtml(line.text)}</span></div>`);
      newNo += 1;
      continue;
    }
    if (line.type === 'del') {
      out.push(`<div class="row del"><span class="ln">${oldNo}</span><span class="ln"></span><span class="mk">−</span><span class="tx" title="${t('delHint')}">${escapeHtml(line.text)}</span></div>`);
      oldNo += 1;
      continue;
    }
    const af = autoFocusLine === newNo ? ' data-autofocus="1"' : '';
    out.push(`<div class="row ctx"><span class="ln">${oldNo}</span><span class="ln">${newNo}</span><span class="mk"> </span><span class="tx ed" contenteditable="true" spellcheck="false" data-line="${newNo}" title="${t('edHint')}"${af}>${escapeHtml(line.text)}</span></div>`);
    oldNo += 1;
    newNo += 1;
  }
  return out.join('\n');
}

function renderHunk(hunk, index, opts) {
  const sig = hunkSignature(hunk);
  const reviewed = !!(opts.reviewedSigs && opts.reviewedSigs[sig]);
  const rejected = !!(opts.rejectedSigs && opts.rejectedSigs[sig]);
  const actions = [];
  if (opts.canAcceptHunk) {
    actions.push(`<button class="mini ok" data-cmd="hunkAccept" data-index="${index}" data-sig="${sig}" title="${t('hunkAcceptTitle')}">${t('hunkAccept')}</button>`);
  }
  if (opts.canRevertHunk) {
    if (rejected) {
      // 已记录拒绝：按钮变「撤销拒绝」，给用户反悔机会（还原发生在标记已审查时）
      actions.push(`<button class="mini" data-cmd="hunkUnreject" data-index="${index}" data-sig="${sig}" title="${t('hunkUnrejectTitle')}">${t('hunkUnreject')}</button>`);
    } else {
      actions.push(`<button class="mini danger" data-cmd="hunkReject" data-index="${index}" data-sig="${sig}" title="${t('hunkRejectTitle')}">${t('hunkReject')}</button>`);
    }
  }
  actions.push(`<button class="mini" data-cmd="goto" data-line="${hunk.newStart}" title="${t('gotoTitle')}">${t('goto')}</button>`);

  return `
  <div class="hunk${reviewed ? ' done' : ''}${rejected ? ' rej' : ''}" data-start="${hunk.newStart}">
    <div class="hunk-head">
      <span class="range">${escapeHtml(hunk.header)}</span>
      <span class="hc"><i class="a">+${hunk.added}</i><i class="d">−${hunk.removed}</i></span>
      ${reviewed ? '<span class="donebadge">已接受 ✓</span>' : ''}
      ${rejected && !reviewed ? `<span class="rejbadge">${t('hunkRejectedBadge')}</span>` : ''}
      <span class="spacer"></span>
      <span class="hact">${actions.join('')}</span>
    </div>
    <div class="rows">${renderRows(hunk, opts.autoFocusLine)}</div>
  </div>`;
}

function buildHtml(ctx) {
  const n = nonce();
  const file = ctx.file;
  const parsed = ctx.parsed;
  const reviewedSigs = ctx.reviewedSigs || {};
  // 文件已整体接受（已审查）后，块级接受/拒绝按钮隐藏——整体已经定了，再点块级是矛盾操作
  const fileAccepted = !!file.reviewed;
  const canRevertHunk = !fileAccepted && file.kind !== 'deleted' && file.kind !== 'conflict' && !parsed.binary;
  const canAcceptHunk = canRevertHunk;

  const doneCount = parsed.hunks.filter((h) => reviewedSigs[hunkSignature(h)]).length;
  const hunks = parsed.hunks.length
    ? parsed.hunks.map((h, i) => renderHunk(h, i, { canAcceptHunk, canRevertHunk, reviewedSigs, rejectedSigs: ctx.rejectedSigs, autoFocusLine: ctx.autoFocusLine })).join('\n')
    : `<div class="empty">${parsed.binary ? t('binaryDiff') : (file.large ? t('largeFile') : t('noDiff'))}</div>`;

  const label = t('kinds')[file.kind] || file.kind;
  const acceptLabel = t('acceptAll');
  const acceptTitle = t('acceptAllTitle');
  const rejectLabel = t('rejectAll');
  const rejectTitle = ctx.rejectTitle || (panelLang() === 'zh' ? '放弃改动，将文件还原到对比基准' : 'Discard changes and restore file to baseline');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${ctx.cspSource} 'unsafe-inline'; script-src 'nonce-${n}';" />
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0 0 24px 0;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-editor-foreground);
    background: var(--vscode-editor-background);
  }
  .bar {
    position: sticky; top: 0; z-index: 5;
    padding: 10px 12px 8px 12px;
    background: var(--vscode-editor-background);
    border-bottom: 1px solid var(--vscode-panel-border, transparent);
  }
  .path { font-weight: 600; font-size: 13px; }
  .badge {
    display: inline-block; margin-left: 8px; padding: 1px 6px; border-radius: 10px;
    font-size: 11px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  }
  .sub { margin-top: 4px; font-size: 12px; opacity: .8; }
  .stat { margin-left: 8px; font-variant-numeric: tabular-nums; }
  .stat .a { color: #3fb950; }
  .stat .d { color: #f85149; }
  .toolbar { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 12px 10px 12px; align-items: center; }
  .toolbar .tip { margin-left: auto; font-size: 11px; opacity: .6; }
  /* 统一按钮风格：同一套描边基础，只用颜色区分语义，且与 diff 配色一致（绿=新增/接受，红=删除/拒绝） */
  button {
    font-family: inherit; font-size: 12px; line-height: 18px; cursor: pointer;
    display: inline-flex; align-items: center;
    background: transparent; color: var(--vscode-foreground);
    border: 1px solid var(--vscode-panel-border, #555); border-radius: 4px; padding: 3px 10px;
  }
  button:hover { background: var(--vscode-list-hoverBackground); }
  button.ok { color: #3fb950; border-color: #3fb950; }
  button.ok:hover { background: rgba(63, 185, 80, .15); }
  button.danger { color: #f85149; border-color: #f85149; }
  button.danger:hover { background: rgba(248, 81, 73, .15); }
  button.on { color: #3fb950; border-color: #3fb950; background: rgba(63, 185, 80, .12); }
  button.secondary { /* 中性按钮：与基础样式一致 */ }
  button.mini { padding: 1px 6px; font-size: 11px; line-height: 16px; }
  button.mini.ok { color: #3fb950; border-color: #3fb950; }
  button.mini.danger { color: #f85149; border-color: #f85149; }
  .hunk { margin: 0 0 12px 0; border: 1px solid var(--vscode-panel-border, #333); border-radius: 6px; overflow: hidden; background: var(--vscode-editor-background); }
  .hunk.done .rows { opacity: .5; }
  /* 已记录拒绝（待执行）的块：整块红色氛围——头部红底、行变暗、红徽章、红色左条，
     还原发生在「标记已审查」时；一眼能和未处理的块区分开 */
  .hunk.rej { box-shadow: inset 3px 0 0 #f85149; }
  .hunk.rej .hunk-head { background: rgba(248, 81, 73, .14); }
  .hunk.rej .rows .row { opacity: .45; }
  .rejbadge { font-size: 11px; color: #f85149; font-weight: 600; }
  .hunk-head {
    display: flex; align-items: center; gap: 10px;
    min-height: 30px;
    padding: 6px 12px; background: var(--vscode-editorGroupHeader-tabsBackground, #1f1f1f);
    border-bottom: 1px solid var(--vscode-panel-border, transparent);
    position: sticky; top: 0;
  }
  .hunk-head .spacer { flex: 1; }
  .hunk-head .range { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; opacity: .75; }
  .hunk-head .hc i { font-style: normal; font-size: 11px; margin-right: 6px; font-variant-numeric: tabular-nums; }
  .hc .a { color: #3fb950; }
  .hc .d { color: #f85149; }
  .donebadge { font-size: 11px; color: #3fb950; }
  /* 关键：按钮始终占位，只用 visibility 控制显隐。
     若用 display:none 会在 hover 时改变块头高度，导致下方所有块上下抖动。 */
  .hunk-head .hact { display: inline-flex; gap: 6px; visibility: hidden; white-space: nowrap; flex: none; }
  .hunk:hover .hact { visibility: visible; }
  .rows { font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 12px); line-height: 1.55; }
  .row { display: grid; grid-template-columns: 52px 52px 16px 1fr; position: relative; }
  .row .ln { text-align: right; padding-right: 10px; opacity: .4; user-select: none; }
  .row .mk { text-align: center; user-select: none; color: var(--vscode-editorLineNumber-foreground, #6e7681); }
  .row .tx { white-space: pre-wrap; word-break: break-all; padding-right: 12px; }
  /* 行背景直接用按钮/徽章同款色相（#3fb950 / #f85149）派生，
     不再用主题变量 diffEditor-insertedLineBackground——那套绿和我们的绿不是一个色 */
  .row.add { background: rgba(63, 185, 80, .20); box-shadow: inset 2px 0 0 #3fb950; }
  .row.add .mk, .row.add .ln:nth-child(2) { color: #3fb950; font-weight: 600; }
  .row.del { background: rgba(248, 81, 73, .16); box-shadow: inset 2px 0 0 #f85149; }
  .row.del .mk, .row.del .ln:nth-child(1) { color: #f85149; font-weight: 600; }
  .row.meta { opacity: .6; font-style: italic; background: transparent; box-shadow: none; }
  /* 对比块里的行可直接编辑：平时无痕，悬浮/聚焦时给一点提示 */
  .tx.ed { outline: none; border-radius: 2px; }
  .tx.ed:hover { background: var(--vscode-list-hoverBackground); cursor: text; }
  .tx.ed:focus { background: var(--vscode-editor-selectionBackground, rgba(63,185,80,.18)); box-shadow: inset 0 0 0 1px var(--vscode-focusBorder, #3fb950); }
  .empty { padding: 20px 12px; opacity: .7; }
  .state { margin-left: 8px; font-size: 11px; padding: 1px 6px; border-radius: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .ver { text-align: right; font-size: 10px; opacity: .4; padding: 6px 14px 4px; user-select: none; }
  /* 面板右键菜单：在 panel 内任意位置右键弹出（VSCode webview 不提供原生菜单） */
  .ctxmenu {
    position: fixed; z-index: 50; min-width: 180px; padding: 4px 0;
    background: var(--vscode-menu-background, #252526);
    color: var(--vscode-menu-foreground, var(--vscode-foreground));
    border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border, #454545));
    border-radius: 5px; box-shadow: 0 4px 12px rgba(0, 0, 0, .35);
    font-size: 12px; user-select: none;
  }
  .ctxmenu[hidden] { display: none; }
  .ctxmenu .mi { padding: 5px 14px; cursor: pointer; white-space: nowrap; }
  .ctxmenu .mi:hover { background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)); }
  .ctxmenu .sep { height: 1px; margin: 4px 0; background: var(--vscode-menu-separatorBackground, var(--vscode-panel-border, #454545)); }
</style>
</head>
<body>
  <div class="bar">
    <div>
      <span class="path">${escapeHtml(file.relPath)}</span>
      <span class="badge">${escapeHtml(label)}</span>
      ${file.staged ? '<span class="badge">已暂存</span>' : ''}
      ${file.reviewed ? '<span class="state">已审查 ✓</span>' : ''}
    </div>
    <div class="sub">
      <span class="stat"><span class="a">+${file.added}</span> <span class="d">−${file.removed}</span></span>
      <span> · ${parsed.hunks.length} 个改动块${parsed.hunks.length ? `（已接受 ${doneCount}）` : ''} · ${escapeHtml(ctx.sourceLabel || ctx.repoName || '')} · 对比 ${escapeHtml(ctx.baseLabel || '')}</span>
    </div>
  </div>
  <div class="toolbar">
    <button class="ok" data-cmd="accept" title="${escapeHtml(acceptTitle)}">${escapeHtml(acceptLabel)}</button>
    <button class="danger" data-cmd="reject" title="${escapeHtml(rejectTitle)}">${escapeHtml(rejectLabel)}</button>
    <button class="${file.reviewed ? 'on' : ''}" data-cmd="mark" title="${escapeHtml(t('btnMarkTitle'))}">${file.reviewed ? escapeHtml(t('btnUnmark')) : escapeHtml(t('btnMark'))}</button>
    <button class="secondary" data-cmd="next" title="${t('nextTitle')}">${t('next')}</button>
    <button class="secondary" data-cmd="blockFile" title="${t('blockFileTitle')}">${t('blockFile')}</button>
    <button class="secondary" data-cmd="refresh" title="${t('refreshTitle')}">${t('refresh')}</button>
    <span class="tip">${t('tip')}</span>
  </div>
  <div class="diff">${hunks}</div>
  <div class="ver" id="panelVer">Change Review v${escapeHtml(PANEL_VERSION)} · lang=${escapeHtml(vscode.env.language || 'en')} · ui=${panelLang()}</div>
  <div class="ctxmenu" id="ctxmenu" hidden>
    <div class="mi" data-ctx="openDiff">${escapeHtml(t('ctxOpenDiff'))}</div>
    <div class="sep"></div>
    <div class="mi" data-ctx="accept">${escapeHtml(t('ctxAccept'))}</div>
    <div class="mi" data-ctx="reject">${escapeHtml(t('ctxReject'))}</div>
    <div class="mi" data-ctx="mark">${escapeHtml(file.reviewed ? t('ctxUnmarkReviewed') : t('ctxMarkReviewed'))}</div>
    <div class="sep"></div>
    <div class="mi" data-ctx="blockFile">${escapeHtml(t('ctxBlock'))}</div>
    <div class="sep"></div>
    <div class="mi" data-ctx="copyPath">${escapeHtml(t('ctxCopyPath'))}</div>
    <div class="mi" data-ctx="refresh">${escapeHtml(t('ctxRefresh'))}</div>
  </div>
<script nonce="${n}">
  // 整个脚本体用 try 包住：单点异常不至于让所有按钮/快捷键全部失效，
  // 异常同时 post 回扩展输出面板，便于排查"什么都没反应"的真实原因。
  // acquireVsCodeApi() 在同一个 webview 面板里只能调用一次！
  // 第二次 panel.show() 替换 HTML 后脚本重跑，再次调用会 throw → 所有按钮死掉。
  // 修法：优先从 window 取缓存的 API 引用（第一次调用时存上去的），取不到才 acquire。
  let vscode = null;
  try { vscode = window.__crVsCodeApi || acquireVsCodeApi(); } catch (e) { /* already acquired */ }
  if (!vscode) { try { vscode = acquireVsCodeApi(); } catch (e2) { /* give up */ } }
  try { if (vscode) { window.__crVsCodeApi = vscode; } } catch (_) {}
  if (!vscode) {
    // 实在拿不到 API：面板上直接显示错误，不再静默
    document.body.innerHTML = '<div style="padding:20px;color:#f85149">Change Review: 无法初始化 webview API，请关闭面板后重新打开。</div>';
    throw new Error('acquireVsCodeApi failed and no cached reference');
  }
  try { // 整个脚本体包在 try 里：单点异常不至于让所有按钮/快捷键全部失效

  // 删行消息：focusLine 决定删完后焦点去哪。
  // 规则（确定性，不依赖删完重算的 diff 行号，避免行号漂移导致焦点乱跳）：
  //   被删的是空行（通常是刚 Enter 出来的）→ 回到上一行（line-1），
  //   被删的是内容行 → 焦点留在原位（下一行顶上来，line 不变，等于往下审）。
  function deleteMsg(rowEl, line) {
    const ed = rowEl && rowEl.querySelector('.tx.ed');
    const empty = !ed || (ed.textContent || '').replace(/\\s/g, '') === '';
    return {
      type: 'deleteLine',
      line: line,
      focusLine: empty ? Math.max(1, line - 1) : line
    };
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-cmd]');
    if (!btn) { return; }
    const msg = { type: btn.dataset.cmd };
    if (btn.dataset.index !== undefined) { msg.index = Number(btn.dataset.index); }
    if (btn.dataset.sig !== undefined) { msg.sig = btn.dataset.sig; }
    if (btn.dataset.line !== undefined) { msg.line = Number(btn.dataset.line); }
    if (msg.type === 'deleteLine') {
      const m = deleteMsg(btn.closest('.row'), Number(btn.dataset.line));
      msg.focusLine = m.focusLine;
    }
    vscode.postMessage(msg);
  });

  // 直接在对比块里改：聚焦时记下原文，失焦/回车时若变了就同步回文件对应行
  function commitEdit(el) {
    const line = Number(el.dataset.line);
    const text = el.textContent;
    if (!line || text === el.dataset.orig) { return; }
    el.dataset.orig = text;
    vscode.postMessage({ type: 'editLine', line: line, text: text });
  }
  document.addEventListener('focusin', (e) => {
    const el = e.target.closest && e.target.closest('.tx.ed');
    if (el && el.dataset.orig === undefined) { el.dataset.orig = el.textContent; }
  });
  document.addEventListener('focusout', (e) => {
    const el = e.target.closest && e.target.closest('.tx.ed');
    if (el) { commitEdit(el); }
  });
  const INDENT = ${EDITOR_INDENT_LITERAL}; // 跟随 editor.insertSpaces / editor.tabSize

  // ---- 光标位置判断：用于 Enter 插行方向（最左→上方插行，最右→下方插行，中间→拆行）
  function nextEditable(el) {
    const rows = Array.prototype.slice.call(document.querySelectorAll('.tx.ed[data-line]'));
    const i = rows.indexOf(el);
    return i >= 0 ? rows[i + 1] : null;
  }
  function caretInfo(el) {
    try {
      const s = getSelection();
      if (!s.rangeCount) { return { atStart: false, atEnd: true, offset: String(el.textContent || '').length }; }
      const r = s.getRangeAt(0);
      const pre = document.createRange();
      pre.selectNodeContents(el);
      pre.setEnd(r.startContainer, r.startOffset);
      const post = document.createRange();
      post.selectNodeContents(el);
      post.setStart(r.endContainer, r.endOffset);
      return {
        atStart: pre.toString().length === 0,
        atEnd: post.toString().length === 0,
        offset: pre.toString().length,
        hasSel: !s.isCollapsed
      };
    } catch (e) { return { atStart: false, atEnd: true, offset: String(el.textContent || '').length, hasSel: false }; }
  }

  // ---- 剪贴板：优先 navigator.clipboard（webview 里 execCommand('copy'/'cut'/'paste') 常被拦）
  function flatten(t) { return String(t == null ? '' : t).replace(/\\s*\\r?\\n\\s*/g, ' '); }
  function writeClip(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => { try { document.execCommand('copy'); } catch (_) {} });
        return;
      }
    } catch (e) { /* 落到 execCommand */ }
    try { document.execCommand('copy'); } catch (_) {}
  }
  function selText(el) {
    try {
      const s = getSelection();
      if (s && s.toString()) { return s.toString(); }
    } catch (e) { /* ignore */ }
    return el.textContent || '';
  }
  function insertText(el, text) {
    try { document.execCommand('insertText', false, text); }
    catch (e) { el.textContent = (el.textContent || '') + text; }
    if (!el.dataset.orig) { el.dataset.orig = ''; }
    lastText.set(String(el.dataset.line), el.textContent);
  }
  function copySel(el) {
    const txt = selText(el);
    if (!txt) { return; }
    writeClip(txt);
  }
  function cutSel(el) {
    const txt = selText(el);
    writeClip(txt);
    try {
      const s = getSelection();
      if (s && !s.isCollapsed) {
        s.getRangeAt(0).deleteContents();
      } else {
        el.textContent = '';
      }
    } catch (e) { el.textContent = ''; }
    el.dataset.orig = el.textContent;
    lastText.set(String(el.dataset.line), el.textContent);
    vscode.postMessage({ type: 'editLine', line: Number(el.dataset.line), text: el.textContent, keepFocus: true });
  }
  function pasteInto(el) {
    const doInsert = (t) => { const s = flatten(t); if (s) { insertText(el, s); } };
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        navigator.clipboard.readText().then(doInsert).catch(() => { try { document.execCommand('paste'); } catch (_) {} });
        return;
      }
    } catch (e) { /* 落到 execCommand */ }
    try { document.execCommand('paste'); } catch (_) {}
  }

  // ---- 每行一个简易撤销栈：跨越面板重渲染也能 Ctrl+Z / Ctrl+Shift+Z
  const undoMap = new Map();
  const redoMap = new Map();
  let lastText = new Map();
  document.addEventListener('input', (e) => {
    const el = e.target.closest && e.target.closest('.tx.ed');
    if (!el) { return; }
    const line = el.dataset.line;
    const prev = lastText.has(line) ? lastText.get(line) : (el.dataset.orig || '');
    if (prev !== el.textContent) {
      const st = undoMap.get(line) || [];
      st.push(prev);
      if (st.length > 50) { st.shift(); }
      undoMap.set(line, st);
      redoMap.set(line, []);
      lastText.set(line, el.textContent);
    }
  });
  function writeLine(el, text, extra) {
    const line = Number(el.dataset.line);
    el.textContent = text;
    el.dataset.orig = text;
    lastText.set(String(line), text);
    vscode.postMessage(Object.assign({ type: 'editLine', line: line, text: text, keepFocus: true }, extra || {}));
  }
  function undo(el) {
    const line = el.dataset.line;
    const st = undoMap.get(line) || [];
    if (!st.length) { return; }
    const v = st.pop();
    const rd = redoMap.get(line) || [];
    rd.push(el.textContent);
    redoMap.set(line, rd);
    writeLine(el, v);
  }
  function redo(el) {
    const line = el.dataset.line;
    const rd = redoMap.get(line) || [];
    if (!rd.length) { return; }
    const v = rd.pop();
    const st = undoMap.get(line) || [];
    st.push(el.textContent);
    undoMap.set(line, st);
    writeLine(el, v);
  }

  document.addEventListener('keydown', (e) => {
    const el = e.target.closest && e.target.closest('.tx.ed');
    const key = (e.key || '').toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    // Ctrl+S / Ctrl+Z / Ctrl+Y / Ctrl+A 在面板任意位置都接管（VSCode 会先截获这些组合键）
    if (mod && key === 's') {
      e.preventDefault();
      const target = el || document.activeElement && document.activeElement.closest && document.activeElement.closest('.tx.ed');
      if (target) {
        const text = target.textContent;
        target.dataset.orig = text;
        lastText.set(String(target.dataset.line), text);
        vscode.postMessage({ type: 'editLine', line: Number(target.dataset.line), text: text, keepFocus: true });
      } else {
        vscode.postMessage({ type: 'saveNow' });
      }
      return;
    }
    if (!el) { return; }
    if (mod && (key === 'z' || key === 'y')) {
      // Ctrl+Z 撤销 / Ctrl+Y 或 Ctrl+Shift+Z 重做（VSCode 会截获，必须 prevent + stop）
      e.preventDefault();
      try { e.stopPropagation(); } catch (err) { /* ignore */ }
      if (key === 'y' || e.shiftKey) {
        const rd = redoMap.get(el.dataset.line) || [];
        if (!rd.length) { vscode.postMessage({ type: 'redo' }); return; } // 行内栈空 → 走文件级重做（新增/删除/合并行也能恢复）
        redo(el);
      } else {
        const st = undoMap.get(el.dataset.line) || [];
        if (!st.length) { vscode.postMessage({ type: 'undo' }); return; } // 行内栈空 → 走文件级撤销
        undo(el);
      }
      return;
    }
    if (mod && key === 'a') {
      // Ctrl+A：只选中当前这一行的文本，不选中整个面板
      e.preventDefault();
      try {
        const r = document.createRange();
        r.selectNodeContents(el);
        const s = getSelection();
        s.removeAllRanges();
        s.addRange(r);
      } catch (err) { /* ignore */ }
      return;
    }
    if (mod && (key === 'c' || key === 'x')) {
      // Ctrl+C / Ctrl+X：自己走剪贴板 API（VSCode 会截获原生复制/剪切，光靠 execCommand 常常没反应）
      e.preventDefault();
      try { e.stopPropagation(); } catch (err) { /* ignore */ }
      if (key === 'c') { copySel(el); } else { cutSel(el); }
      return;
    }
    if (mod && key === 'v') {
      // Ctrl+V：主动读剪贴板再插入，不依赖浏览器默认粘贴（webview 里经常不触发）
      e.preventDefault();
      try { e.stopPropagation(); } catch (err) { /* ignore */ }
      pasteInto(el);
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      // 编辑某一行时，↑/↓ 在可编辑行之间切换（失焦会先把当前行写回）
      e.preventDefault();
      const cells = Array.prototype.slice.call(document.querySelectorAll('.tx.ed[data-line]'));
      const i = cells.indexOf(el);
      const next = e.key === 'ArrowUp' ? cells[i - 1] : cells[i + 1];
      if (next) {
        next.focus();
        try {
          const r = document.createRange();
          r.selectNodeContents(next);
          r.collapse(e.key === 'ArrowUp');
          const s = getSelection();
          s.removeAllRanges();
          s.addRange(r);
        } catch (err) { /* ignore */ }
      }
      return;
    }
    if (e.key === 'Tab') {
      // Tab = 插入一个缩进单位（跟随 editor.insertSpaces / editor.tabSize），不是跳焦点
      e.preventDefault();
      document.execCommand('insertText', false, INDENT);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      // Enter 的方向按光标位置定：
      //   光标在最左 → 在这行上面插空行（焦点留在本行，内容被顶下去）
      //   光标在最右 → 在这行下面插空行（焦点落到新行，和以前一致）
      //   光标在中间 → 像编辑器一样拆行（光标前留在本行，光标后成为下一行）
      e.preventDefault();
      const info = caretInfo(el);
      const full = el.textContent || '';
      el.dataset.orig = full; // 让随后的 focusout 误判不了重复提交
      lastText.set(String(el.dataset.line), full);
      if (!info.hasSel && info.atStart) {
        vscode.postMessage({ type: 'insertAbove', line: Number(el.dataset.line) });
      } else if (info.atEnd) {
        vscode.postMessage({ type: 'editLine', line: Number(el.dataset.line), text: full, insertBelow: true });
      } else {
        const before = full.slice(0, info.offset);
        const after = full.slice(info.offset);
        vscode.postMessage({ type: 'editLine', line: Number(el.dataset.line), text: before, insertBelow: true, tail: after });
      }
      return;
    }
    // 合并行：Backspace 在行首 → 并到上一行；Delete 在行尾 → 把下一行并上来
    // 合并行：只在「没有选区」且光标贴边时才合并。
    // 有选区时（比如整行选中后按 Backspace）必须走默认删除行为，否则会把内容并到上一行。
    if ((e.key === 'Backspace' || e.key === 'Delete') && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      const info = caretInfo(el);
      const cur = Number(el.dataset.line);
      const mergeUp = e.key === 'Backspace' && !info.hasSel && info.atStart && cur > 1;
      const mergeDown = e.key === 'Delete' && !info.hasSel && info.atEnd;
      if (mergeUp || mergeDown) {
        if (mergeDown && !nextEditable(el)) { /* 没有下一行可并，交给默认行为 */ }
        else {
          e.preventDefault();
          el.dataset.orig = el.textContent;
          lastText.set(String(el.dataset.line), el.textContent);
          el.blur();
          vscode.postMessage({ type: 'mergeLine', line: cur, dir: mergeUp ? 'up' : 'down', text: el.textContent });
          return;
        }
      }
    }
    const isDelKey = e.key === 'Backspace' || e.key === 'Delete';
    // 删行：空行上按 Backspace/Delete、Ctrl+Del、Ctrl+Shift+K（编辑器同款删行键）
    const ctrlShiftK = e.key === 'K' && e.shiftKey && (e.ctrlKey || e.metaKey);
    const rowDel = isDelKey && (el.textContent === '' && !e.ctrlKey && !e.metaKey)
      || (e.key === 'Delete' && (e.ctrlKey || e.metaKey))
      || ctrlShiftK; // 内容行也能整行删（Ctrl+Shift+K）
    if (rowDel) {
      // 删除整行（bug 12）。空行删完焦点回上一行，内容行（Ctrl+Del / Ctrl+Shift+K）焦点留在原位
      e.preventDefault();
      el.dataset.orig = el.textContent; // 防止 blur 时把内容当编辑提交
      el.blur();
      const m = deleteMsg(el.closest('.row'), Number(el.dataset.line));
      vscode.postMessage(m);
      return;
    }
    if (e.key === 'Escape') { el.textContent = el.dataset.orig || ''; el.blur(); }
  });
  // 粘贴：含换行的文本折叠为单行（真正的多行编辑在跳转打开的对比视图里做）
  document.addEventListener('paste', (e) => {
    const el = e.target.closest && e.target.closest('.tx.ed');
    if (!el) { return; }
    e.preventDefault();
    const t = ((e.clipboardData || window.clipboardData).getData('text') || '');
    document.execCommand('insertText', false, t.replace(/\\s*\\r?\\n\\s*/g, ' '));
  });

  // ---- 右键菜单：在面板任意位置右键弹出（webview 里 VSCode 不给原生菜单）
  const ctxEl = document.getElementById('ctxmenu');
  function hideCtx() { if (ctxEl) { ctxEl.hidden = true; } }
  function showCtx(x, y) {
    if (!ctxEl) { return; }
    ctxEl.hidden = false;
    // 先显示再量尺寸，避免靠右/靠下被裁切
    const rect = ctxEl.getBoundingClientRect();
    const px = Math.min(x, window.innerWidth - rect.width - 4);
    const py = Math.min(y, window.innerHeight - rect.height - 4);
    ctxEl.style.left = Math.max(4, px) + 'px';
    ctxEl.style.top = Math.max(4, py) + 'px';
  }
  document.addEventListener('contextmenu', (e) => {
    // 行内编辑时保留浏览器默认菜单（复制/粘贴），其余位置弹出我们的菜单
    if (e.target.closest && e.target.closest('.tx.ed')) { return; }
    e.preventDefault();
    showCtx(e.clientX, e.clientY);
  });
  if (ctxEl) {
    ctxEl.addEventListener('click', (e) => {
      const mi = e.target.closest('.mi');
      if (!mi) { return; }
      const cmd = mi.dataset.ctx;
      hideCtx();
      if (cmd === 'copyPath') {
        vscode.postMessage({ type: 'copyText', text: ${JSON.stringify(file.absPath)} });
        return;
      }
      vscode.postMessage({ type: 'ctxCmd', cmd: cmd });
    });
  }
  document.addEventListener('click', (e) => { if (!e.target.closest || !e.target.closest('.ctxmenu')) { hideCtx(); } });
  document.addEventListener('scroll', hideCtx, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { hideCtx(); } });

  // 插入行后重渲染：把焦点放到新行（光标移到行尾）
  const af = document.querySelector('[data-autofocus]');
  if (af) {
    af.focus();
    try {
      const r = document.createRange();
      r.selectNodeContents(af);
      r.collapse(false);
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(r);
    } catch (err) { /* ignore */ }
  }

  } catch (e) {
    // 把错误回传给扩展输出面板，避免"啥都不响应"无据可查
    try { vscode && vscode.postMessage({ type: 'log', level: 'error', text: '[panel:init] ' + (e && e.stack || e) }); } catch (_) {}
  }
  try { vscode && vscode.postMessage({ type: 'ready' }); } catch (_) {}
</script>
</body>
</html>`;
}

class ReviewPanel {
  constructor(handlers) {
    this.handlers = handlers;
    this.panel = null;
    this.entry = null;
  }

  ensurePanel() {
    if (this.panel) { return this.panel; }
    this.panel = vscode.window.createWebviewPanel(
      'changeReview.review',
      'Change Review',
      vscode.ViewColumn.Active,
      {
        enableScripts: true, // 关键：该选项默认为 false，不开则内联脚本完全不执行，按钮全部失效
        enableFindWidget: true,
        // 不保留上下文：扩展升级后重新打开面板时一定用新脚本，避免旧 DOM 残留在 webview
        // 里导致"所有功能突然失效"的假象。
        retainContextWhenHidden: false
      }
    );
    this.panel.onDidDispose(() => { this.panel = null; });
    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    return this.panel;
  }

  async onMessage(msg) {
    this.handlers.log(`[审查面板] 收到消息 type=${msg && msg.type} index=${msg && msg.index} sig=${msg && msg.sig}`);
    if (!this.entry) { return; }
    try {
      switch (msg.type) {
        case 'ready': break;
        case 'accept': await this.handlers.accept(this.entry); break;
        case 'reject': await this.handlers.reject(this.entry); break;
        case 'mark': await this.handlers.toggleReviewed(this.entry); break;
        case 'edit': await this.handlers.openInEditor(this.entry, msg.line); break;
        case 'next': await this.handlers.next(this.entry); break;
        case 'refresh': await this.handlers.refresh(); break;
        case 'blockFile': await this.handlers.blockFile(this.entry); break;
        case 'ctxCmd': await this.handlers.ctxCmd(this.entry, msg.cmd); break;
        case 'hunkAccept': await this.handlers.acceptHunk(this.entry, msg.index, msg.sig); break;
        case 'hunkReject': await this.handlers.rejectHunk(this.entry, msg.index, msg.sig); break;
        case 'hunkUnreject': await this.handlers.unrejectHunk(this.entry, msg.index, msg.sig); break;
        case 'editLine': await this.handlers.editLine(this.entry, msg.line, msg.text, msg.insertBelow, msg.keepFocus ? msg.line : undefined, { tail: msg.tail }); break;
        case 'insertLine': await this.handlers.insertLine(this.entry, msg.line); break;
        case 'insertAbove': await this.handlers.insertAbove(this.entry, msg.line); break;
        case 'saveNow': await this.handlers.saveNow(this.entry); break;
        case 'mergeLine': await this.handlers.mergeLine(this.entry, msg.line, msg.dir, msg.text); break;
        case 'undo': await this.handlers.undoFile(this.entry); break;
        case 'redo': await this.handlers.redoFile(this.entry); break;
        case 'deleteLine': await this.handlers.deleteLine(this.entry, msg.line, msg.focusLine); break;
        case 'clusterRestore': await this.handlers.clusterRestore(this.entry, msg.hunk, msg.clus); break;
        case 'deleteLines': await this.handlers.deleteLines(this.entry, msg.lines); break;
        case 'insertLinesBelow': await this.handlers.insertLinesBelow(this.entry, msg.line, msg.text); break;
        case 'copyText': await this.handlers.copyText(msg.text); break;
        case 'log': if (this.handlers.log) { this.handlers.log(msg.text); } break;
        case 'goto': await this.handlers.openInEditor(this.entry, msg.line); break;
        default: this.handlers.log(`[审查面板] 未知消息类型: ${msg && msg.type}`);
      }
    } catch (e) {
      this.handlers.log(`[审查面板] 处理失败: ${e && e.stack ? e.stack : e}`);
      vscode.window.showErrorMessage(`Change Review: ${e && e.message ? e.message : e}`);
    }
  }

  /** 打开/刷新审查面板显示某个文件 */
  async show(entry) {
    this.entry = entry;
    this.ensurePanel();
    await this.render();
    this.panel.reveal(undefined, false);
  }

  async reload(opts) {
    if (!this.entry || !this.panel) { return; }
    const fresh = this.handlers.resolve(this.entry.source.root, this.entry.file.relPath);
    if (!fresh) {
      this.entry = null;
      this.panel.webview.html = '<html><body style="font-family:var(--vscode-font-family);padding:20px">该文件已没有与对比基准的差异。</body></html>';
      return;
    }
    this.entry = fresh;
    this.focusLine = opts && opts.focusLine ? opts.focusLine : null;
    await this.render();
  }

  async render() {
    const entry = this.entry;
    const panel = this.ensurePanel();
    const cfg = vscode.workspace.getConfiguration('changeReview');
    const contextLines = cfg.get('contextLines', 3);
    const diffText = await entry.source.provider.getDiff(entry.file, contextLines);
    const parsedAll = parseDiff(diffText);
    const parsed = parsedAll[0] || { hunks: [], binary: false, isNew: false, isDeleted: false };
    const src = entry.source;
    panel.title = `审查：${path.basename(entry.file.relPath)}`;
    const rejectTitle = src.provider.id === 'git'
      ? '放弃改动，将文件还原到上次提交 (HEAD)'
      : (src.provider.id === 'svn' ? '放弃改动，将文件还原到 SVN BASE' : '放弃改动，将文件还原到对比基准');

    panel.webview.html = buildHtml({
      file: entry.file,
      parsed,
      sourceLabel: src.label,
      repoName: src.name,
      baseLabel: src.baseLabel,
      rejectTitle,
      reviewedSigs: this.handlers.getReviewedHunks(src.root, entry.file.relPath) || {},
      rejectedSigs: this.handlers.getRejectedHunks ? (this.handlers.getRejectedHunks(src.root, entry.file.relPath) || {}) : {},
      cspSource: panel.webview.cspSource,
      autoFocusLine: this.focusLine
    });
    this.focusLine = null; // 只在下次重渲染前生效一次
  }

  dispose() {
    if (this.panel) { this.panel.dispose(); this.panel = null; }
  }
}

module.exports = { ReviewPanel, buildHtml, escapeHtml };
