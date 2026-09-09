'use strict';

const vscode = require('vscode');
const path = require('path');
const { parseDiff, hunkSignature } = require('./diffParser');
const { KIND_LABEL } = require('./treeProvider');
// 面板底部显示当前扩展版本，便于在"功能异常"时一眼确认 webview 用的是不是新脚本
let PANEL_VERSION = '0.4.12';
try { PANEL_VERSION = require('../package.json').version; } catch (e) { /* ignore */ }

// ---------- 面板内文字 i18n（随 VSCode 显示语言自动切换，中英双语） ----------
const PANEL_I18N = {
  zh: {
    next: '下一个待审查',
    nextTitle: '跳到下一个未审查的文件',
    refresh: '刷新',
    refreshTitle: '重新扫描改动',
    tip: '行内也可直接编辑',
    acceptAll: '接受全部',
    acceptAllTitle: '接受这些改动并标记为已审查（不动文件内容与 git 暂存区；暂存在「标记为已审查」时发生）',
    rejectAll: '拒绝全部',
    hunkAccept: '接受此块',
    hunkAcceptTitle: '接受这个改动块（标记为已接受，不动文件内容与暂存区；暂存在「标记为已审查」时发生）',
    hunkReject: '拒绝此块',
    hunkRejectTitle: '记录拒绝这个改动块（不立即改文件；标记为已审查时统一执行还原，之前可反悔）',
    hunkRejectedBadge: '拒绝·待执行',
    hunkUnreject: '撤销拒绝',
    hunkUnrejectTitle: '取消这个块的拒绝决定，恢复为未决定状态',
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
      // 已记录拒绝：按钮变「撤销拒绝」，给用户反悔机会（还原发生在标记为已审查时）
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
  // 缩进设置（由宿主按 VSCode 的 editor.tabSize / editor.insertSpaces 下发），
  // 缺失时退回 4 空格，保证离线预览 / 老调用方也能正常工作。
  const indentSrc = ctx.indent || {};
  const indentJson = JSON.stringify({
    tabSize: Math.max(1, Number(indentSrc.tabSize) || 4),
    insertSpaces: indentSrc.insertSpaces !== false
  });
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
     还原发生在「标记为已审查」时；一眼能和未处理的块区分开 */
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
    <button class="${file.reviewed ? 'on' : ''}" data-cmd="mark" title="切换这个文件是否已审查">${file.reviewed ? '已审查 ✓（点击取消）' : '标记为已审查'}</button>
    <button class="secondary" data-cmd="next" title="${t('nextTitle')}">${t('next')}</button>
    <button class="secondary" data-cmd="refresh" title="${t('refreshTitle')}">${t('refresh')}</button>
    <span class="tip">${t('tip')}</span>
  </div>
  <div class="diff">${hunks}</div>
  <div class="ver" id="panelVer">Change Review v${escapeHtml(PANEL_VERSION)} · lang=${escapeHtml(vscode.env.language || 'en')} · ui=${panelLang()}</div>
<script nonce="${n}">
  window.__CR_INDENT__ = ${indentJson};
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

  // 缩进：跟随 VSCode 的 editor.tabSize / editor.insertSpaces（由宿主下发）
  var INDENT = window.__CR_INDENT__ || { tabSize: 4, insertSpaces: true };
  var TAB_SIZE = Math.max(1, parseInt(INDENT.tabSize, 10) || 4);
  function spaces(n) { return new Array(Math.max(0, n) + 1).join(' '); }

  // contenteditable 里可能被浏览器插进 <br>/<div>，字符偏移不等于 DOM 偏移，需要映射
  function pointAt(el, offset) {
    var pos = 0;
    var walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
    var nd;
    while ((nd = walk.nextNode())) {
      var len = nd.nodeValue.length;
      if (pos + len >= offset) { return { node: nd, off: offset - pos }; }
      pos += len;
    }
    return { node: el, off: el.childNodes.length };
  }
  function selectRange(el, from, to) {
    var a = pointAt(el, from), b = pointAt(el, to);
    var r = document.createRange();
    try { r.setStart(a.node, a.off); r.setEnd(b.node, b.off); }
    catch (err) { r.selectNodeContents(el); }
    var s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }
  // 光标在元素内的字符偏移（拿不到就返回 -1）
  function caretAt(el) {
    var s = getSelection();
    if (!s || !s.rangeCount) { return -1; }
    var pre = document.createRange();
    pre.selectNodeContents(el);
    try { pre.setEnd(s.getRangeAt(0).endContainer, s.getRangeAt(0).endOffset); }
    catch (err) { return -1; }
    return pre.toString().length;
  }

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
  document.addEventListener('keydown', (e) => {
    const el = e.target.closest && e.target.closest('.tx.ed');
    if (!el) { return; }
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
      // Tab / Shift+Tab = 缩进 / 反缩进，跟随 VSCode 的 editor.tabSize / editor.insertSpaces。
      // 不再硬塞一个真制表符：insertSpaces=true 时要用空格，否则浏览器按 8 列渲染 \\t，
      // 看起来就是"我设的是 4，它给我 8"。
      e.preventDefault();
      var txt = el.textContent || '';
      var lm = txt.match(/^([ \\t]*)/);
      var lead = lm ? lm[1].length : 0;
      var cur = caretAt(el);
      if (cur < 0) { cur = 0; }
      if (e.shiftKey) {
        // 反缩进：从行首缩进区回退到上一个 tab stop（只碰空白）
        if (!lead) { return; }
        var cut = lead % TAB_SIZE || TAB_SIZE;
        if (cut > lead) { cut = lead; }
        selectRange(el, lead - cut, lead);
        document.execCommand('delete');
        return;
      }
      if (cur <= lead) {
        // 光标在行首缩进区：补到下一个 tab stop（列对齐，而不是简单加一个单位）
        selectRange(el, lead, lead);
        document.execCommand('insertText', false, INDENT.insertSpaces ? spaces(TAB_SIZE - (lead % TAB_SIZE)) : '\\t');
        return;
      }
      // 行中间：插一个缩进单位
      document.execCommand('insertText', false, INDENT.insertSpaces ? spaces(TAB_SIZE) : '\\t');
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
      // Ctrl+S = 立即保存这一行并刷新 diff（等价于手动“写回并重算”）
      e.preventDefault();
      const text = el.textContent;
      if (text === el.dataset.orig) { return; } // 没改动就不用重渲染
      el.dataset.orig = text;
      vscode.postMessage({ type: 'editLine', line: Number(el.dataset.line), text: text, keepFocus: true });
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      // Enter = 在这行下面插入一行：先把当前行写回（连着 insertBelow 一次发送），重渲染后焦点落到新行
      e.preventDefault();
      const text = el.textContent;
      el.dataset.orig = text; // 让随后的 focusout 误判不了重复提交
      vscode.postMessage({ type: 'editLine', line: Number(el.dataset.line), text: text, insertBelow: true });
      return;
    }
    const isDelKey = e.key === 'Backspace' || e.key === 'Delete';
    const rowDel = isDelKey && (el.textContent === '' && !e.ctrlKey && !e.metaKey)
      || (e.key === 'Delete' && (e.ctrlKey || e.metaKey)); // 空行上按 Backspace/Delete，或 Ctrl+Del
    if (rowDel) {
      // 删除整行（bug 12）。空行删完焦点回上一行，内容行（Ctrl+Del）焦点留在原位
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
        case 'hunkAccept': await this.handlers.acceptHunk(this.entry, msg.index, msg.sig); break;
        case 'hunkReject': await this.handlers.rejectHunk(this.entry, msg.index, msg.sig); break;
        case 'hunkUnreject': await this.handlers.unrejectHunk(this.entry, msg.index, msg.sig); break;
        case 'editLine': await this.handlers.editLine(this.entry, msg.line, msg.text, msg.insertBelow, msg.keepFocus ? msg.line : undefined); break;
        case 'insertLine': await this.handlers.insertLine(this.entry, msg.line); break;
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

    // 缩进跟随 VSCode 设置（editor.tabSize / editor.insertSpaces）。
    // 之前面板里 Tab 硬塞一个真 \t：insertSpaces=true 时用错了字符，
    // 而 webview 渲染 \t 默认按 8 列走 → 表现为"我设的是 4，它给我 8"。
    const editorCfg = vscode.workspace.getConfiguration('editor');
    const indent = {
      tabSize: Math.max(1, Number(editorCfg.get('tabSize', 4)) || 4),
      insertSpaces: editorCfg.get('insertSpaces', true) !== false
    };

    panel.webview.html = buildHtml({
      file: entry.file,
      parsed,
      sourceLabel: src.label,
      repoName: src.name,
      baseLabel: src.baseLabel,
      rejectTitle,
      indent,
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
