# Change Review

A lightweight VSCode extension: list your **local changes against a baseline**, tick files off one by one, and click a file name to open a diff review panel where you can accept, reject, work per hunk, or jump into the real file and edit it directly.

**Three sources, auto-detected:**

| Source | Baseline | Notes |
| --- | --- | --- |
| **Git** | `HEAD` (last commit) | Detects git repositories in the workspace (multi-root supported) |
| **SVN** | `BASE` | `.svn` may live several levels above the opened folder; it is searched upwards automatically |
| **Snapshot** | Manually captured baseline | Projects with neither git nor svn: run "Initialize Baseline" once and diff against it; "Update Baseline" any time |

> Auto order: git → svn → snapshot. Force a source with `changeReview.forceVcs`.

## Features

- **Badges**: Activity Bar icon + view badge (unreviewed count) + status bar `x/y reviewed`.
- **Change list**: status (`Modified / Added / Deleted / Renamed / Untracked / Conflict`), `+added −removed` line counts, and source type per file.
- **Tick boxes**: one per file; state is stored per workspace (`workspaceState`). Editing a file again invalidates its tick.
- **Review panel**: click a file name to open a standalone panel with a unified diff (theme-aware colors).
  - File level: Accept / Reject / Mark as reviewed / Next unreviewed / Ignore this file / Refresh — the verb stays on the button; the exact semantics (git staging, revert to HEAD, SVN BASE, …) are in the tooltips.
  - **Hunk level**: hover a hunk for **Accept block / Reject block / Go to line**.
  - **Panel right-click menu**: right-click anywhere in the panel for Open diff / Accept all / Reject all / Mark (Unmark) reviewed / Ignore this file / Copy file path / Refresh. Right-clicking inside an inline editing row keeps the native copy/paste menu.
- **Accept / Reject (content-level only, never touches the git index)**:
  - **Accept** (all / block) = mark the change accepted and tick the file: file content is untouched and nothing is `git add`ed. Same behaviour for git, svn and snapshot.
  - **Reject** (all) = restore the file to the baseline: git `restore` to HEAD, svn `revert` to BASE, snapshot writes the baseline content back; untracked files are deleted. **Reject block** is a line-level reverse replacement — only that hunk changes.
  - **Reject block is deferred**: clicking it only records the decision; the revert is applied when you mark the file as reviewed, so you can undo the decision (`Undo reject`) until then.
  - **git staging only happens on "Mark as reviewed"**: ticking = `git add`; unticking = `git reset` (working tree untouched). svn/snapshot have no index, so the tick only records state.
  - When every block of a file has a decision (accepted or rejected) the file is ticked automatically (marking only, never `git add`). If that block-level check is skipped for any reason (auto-refresh, a stale panel entry, concurrent clicks), a reconciliation pass at the end of every refresh catches up, so "all blocks decided" ⇒ reviewed; when it does not apply, the reason is logged (`Change Review: Open Log`).
- **Free editing**: "Go to line" opens the **real workspace file** at that line, ready to edit and save; the list and the panel refresh automatically.
- **Multi-row selection / cluster actions**: click a line number to select, Ctrl/Cmd+click to multi-select, Shift for ranges, double-click for a cluster, Ctrl+A for all; a floating bar offers **Copy / Delete selected / Restore cluster**.
- **Inline line editing**: Tab inserts one indent (follows `editor.insertSpaces` / `editor.tabSize`); Enter at line start inserts above, at line end inserts below, in the middle splits the line; Backspace/Delete at the edges merge lines; Ctrl+S saves the current line, Ctrl+Z / Ctrl+Y undo/redo (also for inserted/deleted/merged lines), Ctrl+C / Ctrl+X / Ctrl+V use the system clipboard.
- **Exclude rules**: the project's `.crignore` wins; if there is none, that folder's `.gitignore` rules are used (git projects need no extra config). Rule semantics are **identical to `.gitignore`**: a rule matches the path **relative to the directory containing that ignore file** (not the repo root), so rules written while a repo subdirectory is open still work; a leading `/` anchors to that directory. **Quick ignore**: right-click in the review panel → "Ignore this file" (also a toolbar button, the tree item context menu, and the command palette) adds the current file as a path relative to its folder's `.crignore`, and it disappears from the list right away; a path already in `.crignore` is not appended twice. You can also add `changeReview.exclude` (glob list, empty by default, matched relative to the repo/project root) manually.
- **Scoped to the opened folder**: when the repository root is above the opened folder, only files inside the opened folder are listed.
- **No VCS project**: the view offers "Initialize Baseline"; baseline snapshots live in the extension's `globalStorage`, never in your project. `node_modules`, `dist`, `build`, `.git`, `.svn` are excluded by default.
- **WSL / remote**: declared `"extensionKind": ["workspace"]` — install it inside WSL for WSL windows.
- **i18n**: follows the VSCode display language. Command palette, setting descriptions, view names and the review panel are localized (`package.nls.json` English / `package.nls.zh-cn.json` Simplified Chinese; `README.en.md` / `README.md`).

## Install / Run

Zero dependencies, no build step (plain JavaScript).

- **Package & install (recommended)**:
  ```bash
  npm run package        # produces change-review-<version>.vsix
  npm run install-local  # installs into local VSCode via the code CLI
  ```
  Or in VSCode: Extensions → `...` → **Install from VSIX…**.
  To overwrite the same version: `code --install-extension ./change-review-<version>.vsix --force`.
- **Development**: open this folder in VSCode and press `F5`.
- **Manual**: copy the folder to `~/.vscode/extensions/change-review/` and restart VSCode.

## Troubleshooting

Run **"Diagnose Environment (Git / SVN / Platform / Repos)"** from the command palette; it prints platform, extension host, git/svn binaries and every detected source into the Output panel (`Change Review` channel). Also available: **"Change Review: Open Log"** (logs are written to `globalStorage/change-review.log` as well).

| Symptom | Cause | Fix |
| --- | --- | --- |
| Panel buttons do nothing, no logs | webview scripts disabled (pre-0.2.0) | Upgrade to 0.2.0+; the Output channel should show `收到消息 type=ready` after opening the panel |
| Repo exists but list is empty (Linux) | opened folder path and repo root resolve differently (symlink/mount) | Check the log line `git status 空结果 root=… pathspec=…`; 0.4.11+ falls back to a whole-repo scan |
| `detected dubious ownership` | directory owned by a different user (common under `/mnt/c`) | Click "Trust this repository" in the prompt |
| WSL shows `C:/...` paths | Windows git is being used | Set `changeReview.gitPath` to `/usr/bin/git` |
| Sub-folder lists other projects' changes | pre-0.3.1 had no scope limit | Upgrade to 0.3.1+ |

## Commands

| Command | Description |
| --- | --- |
| `Refresh Changes` | Refresh now (title bar icon / command palette) |
| `Focus Changes View` | Jump to the Change Review view |
| `Open Review` | Open the diff review panel for a file |
| `Open Diff in Editor` | Native diff editor (baseline ↔ working tree) |
| `Accept Changes` | Mark as reviewed only (no content change, no `git add`) |
| `Reject Changes (Revert)` | git: revert to last commit; svn: to BASE; snapshot: to baseline |
| `Mark as Reviewed` / `Unmark Reviewed` | Manual tick; with git, tick = `git add`, untick = `git reset` |
| `Mark All Reviewed` / `Clear All Marks` | Bulk operations |
| `Next Unreviewed` | Jump to the next unreviewed file |
| `Initialize Baseline` | Record current state as baseline (no git/svn) |
| `Update Baseline` | Snapshot projects: set a new baseline |
| `Configure Exclude Rules…` | Open `.crignore` (creating it if needed) for direct editing |
| `Ignore File (Add to .crignore)` | Add the current file as a path relative to its folder's `.crignore` so it stops showing up (panel right-click / toolbar / tree context menu / command palette) |
| `Reveal in Explorer` | Locate the file in the Explorer |
| `Diagnose Environment (Git / SVN / Platform / Repos)` | Print environment info to Output |

## Keybindings (when the Change Review view has focus)

| Key | Action |
| --- | --- |
| `Ctrl+Enter` | Open review panel |
| `Ctrl+Shift+A` | Accept |
| `Ctrl+Shift+R` | Reject |
| `Ctrl+Shift+M` | Toggle reviewed |
| `Alt+N` | Next unreviewed |

> On macOS use `Cmd` instead of `Ctrl`. All bindings are scoped to the Change Review view.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `changeReview.includeUntracked` | `true` | List untracked new files |
| `changeReview.sortReviewedLast` | `true` | Move reviewed files to the end |
| `changeReview.autoRefreshInterval` | `5` | Auto refresh interval (seconds), `0` = off |
| `changeReview.contextLines` | `3` | Diff context lines |
| `changeReview.showStatusBar` | `true` | Show the status bar badge |
| `changeReview.gitPath` | empty | Full path to git; auto-detect when empty |
| `changeReview.svnPath` | empty | Full path to svn; auto-detect when empty |
| `changeReview.forceVcs` | `auto` | Force source: `auto` / `git` / `svn` / `snapshot` |
| `changeReview.vcsSearchDepth` | `5` | Levels to search upwards for `.git` / `.svn` |
| `changeReview.exclude` | `[]` | Global manual excludes (glob, relative to repo/project root) |
| `changeReview.uiLanguage` | `auto` | Panel language: `auto` (follow VSCode display language) / `zh` / `en` |
| `changeReview.snapshotExclude` | `[node_modules, dist, build, …]` | Files excluded from snapshot baselines |
| `changeReview.snapshotMaxFileSize` | `1024` | KB; larger files are detected but not diffed line by line |
| `changeReview.snapshotMaxFiles` | `10000` | Max files in a snapshot baseline |

## Self-checks

```bash
npm run selfcheck   # real temp git repo: change stats, diff parsing, hunk revert, accept, reject
npm run vcscheck    # real temp svn repo (svnadmin+file://) + snapshot directory
npm run mockcheck   # mocked vscode API: tree view, badges, checkboxes, panel flows
npm run preview     # generate preview/review-panel.html
```

## Known limitations

- If a file was edited elsewhere and hunk positions no longer match, "Reject block" reports an error instead of guessing.
- Deleted files do not support hunk operations (the file no longer exists).
- SVN compares text against BASE only; property changes (e.g. `svn:ignore`) affect the status column, not the text diff.
- Binary files show line counts only, no text diff.
- Requires system `git` / `svn` binaries (the built-in SCM extension API is not used).
- Snapshot baselines store file copies under VSCode `globalStorage`; use `snapshotExclude` / `snapshotMaxFileSize` / `snapshotMaxFiles` for large projects.
