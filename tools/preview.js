'use strict';

/**
 * 生成审查面板的静态预览 HTML（脱离 VSCode 也能看到长什么样）。
 * 运行：node tools/preview.js
 */

const fs = require('fs');
const path = require('path');
const Module = require('module');

// 最小 vscode mock，只为让模块可加载
const vscodeMock = {
  EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} },
  TreeItem: class { constructor(l, s) { this.label = l; this.collapsibleState = s; } },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  TreeItemCheckboxState: { Unchecked: 0, Checked: 1 },
  ThemeIcon: class { constructor(id) { this.id = id; } },
  MarkdownString: class { constructor(v) { this.value = v; } },
  Uri: { file: (p) => ({ fsPath: p }), from: (o) => o }
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') { return vscodeMock; }
  return origLoad.apply(this, arguments);
};

const { parseDiff } = require('../src/diffParser');
const { buildHtml } = require('../src/reviewPanel');

const SAMPLE_DIFF = `diff --git a/src/auth/token.ts b/src/auth/token.ts
index 8f3a1c2..b91d4e7 100644
--- a/src/auth/token.ts
+++ b/src/auth/token.ts
@@ -12,7 +12,8 @@ const CACHE_TTL = 60_000;
 export class TokenCache {
   private cache = new Map<string, Token>();
 
-  get(key: string): Token | undefined {
-    return this.cache.get(key);
+  get(key: string): Token | undefined {
+    const hit = this.cache.get(key);
+    return hit && !isExpired(hit) ? hit : undefined;
   }
 
   set(key: string, token: Token) {
@@ -40,6 +41,10 @@ export class TokenCache {
     this.cache.set(key, token);
   }
 
+  clearExpired(now = Date.now()) {
+    for (const [k, v] of this.cache) {
+      if (now > v.expiresAt) this.cache.delete(k);
+    }
+  }
+
   private sweep() {
     for (const key of this.cache.keys()) {
`;

const parsed = parseDiff(SAMPLE_DIFF)[0];
const html = buildHtml({
  file: {
    relPath: 'src/auth/token.ts',
    absPath: 'src/auth/token.ts',
    kind: 'modified',
    added: 8,
    removed: 2,
    staged: false,
    reviewed: false
  },
  parsed,
  repoName: 'review',
  cspSource: '*'
});

// 脱离 VSCode 时补上主题变量 + 去掉 CSP 限制，便于本地预览
const themed = html
  .replace(
    '<style>',
    `<style>
  :root {
    --vscode-font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    --vscode-editor-font-family: "Cascadia Code", Consolas, monospace;
    --vscode-font-size: 13px;
    --vscode-editor-font-size: 12.5px;
    --vscode-editor-background: #1e1e1e;
    --vscode-editor-foreground: #d4d4d4;
    --vscode-foreground: #cccccc;
    --vscode-badge-background: #3a3d41;
    --vscode-badge-foreground: #cccccc;
    --vscode-button-background: #0e639c;
    --vscode-button-foreground: #ffffff;
    --vscode-button-hoverBackground: #1177bb;
    --vscode-button-secondaryBackground: #3a3d41;
    --vscode-button-secondaryForeground: #cccccc;
    --vscode-panel-border: #2b2b2b;
    --vscode-editorGroupHeader-tabsBackground: #252526;
    --vscode-diffEditor-insertedLineBackground: rgba(90, 200, 90, .16);
    --vscode-diffEditor-removedLineBackground: rgba(220, 90, 90, .16);
    --vscode-charts-green: #89d185;
    --vscode-charts-red: #f14c4c;
    --vscode-errorForeground: #f14c4c;
    --vscode-list-hoverBackground: #2a2d2e;
  }
  body { max-width: 900px; margin: 0 auto; }`
  )
  .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')
  .replace(/<script[\s\S]*?<\/script>/, '<script>document.addEventListener("click",e=>{const b=e.target.closest("button");if(b)alert("预览模式：按钮仅在 VSCode 内生效 → "+b.dataset.cmd);});</script>');

const outDir = path.join(__dirname, '..', 'preview');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'review-panel.html');
fs.writeFileSync(outFile, themed, 'utf8');
console.log(`已生成预览：${outFile}`);
