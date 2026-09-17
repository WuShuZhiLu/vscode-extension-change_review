## 0.5.1
- Fixed mixed Chinese/English: native messages stayed English even when Chinese was forced
- Runtime messages, panel, and provider labels all follow `changeReview.uiLanguage` (zh / en / auto)
- Added language-mode tests: messages and panel UI stay consistent in both zh and en

## 0.5.0
- Fixed `extension.js` not supporting multiple languages
- Polished the README, de-duplicated changelog entries, and synced the Chinese and English docs
- Redrew the extension icon
- Removed the unused generated preview page

## 0.5.0-pre1
- Accept / reject (file-level and hunk-level) only records the decision and never touches files; git add / revert / delete are executed in one batch at "Mark as Reviewed"
- Auto-mark a file as reviewed once every hunk has a decision, then jump to the next unreviewed file
- Added "Unaccept", symmetric with "Undo Reject"
- After a manual "Unmark Reviewed", the file is not auto re-marked unless it changes again
- Multi-repo workspaces: when the opened folder is not a repo, one level of subdirectories is scanned automatically
- "Reject All" no longer shows a confirmation dialog
- Split tree context menus: file nodes get "Ignore This File" (writes `.crignore`), repo nodes get "Configure Exclude Rules…"; "Clear All Reviewed Marks" renamed to "Clear All Reviewed"
- Fixed the diff body's right-click menu not opening, and review marks lost across refreshes
- Panel button: shows "Unmark Reviewed" once reviewed, "Mark as Reviewed" before that
- Exclude rules fall back to `.gitignore` when there is no `.crignore`; "Ignore This File" stays only in the panel's right-click menu
- Tooling: `mockcheck --only <scene>` runs scenes selectively; releases use the pre-installed vsce; added CI/CD — pushing a tag publishes automatically

## 0.4.20
- Fixed all hunks ticked but the file not marked as reviewed

## 0.4.19
- Fixed "Ignore This File" not taking effect after writing to `.crignore`; exclude matching aligned with `.gitignore` semantics

## 0.4.17
- Added "Ignore This File": one click writes the current file into the directory's `.crignore`, takes effect immediately and the file disappears from the list

## 0.4.15
- Backspace / Delete on a fully selected line no longer merges lines by mistake
- Undo / redo now covers cross-line operations; the snapshot stack moved to the extension side and survives panel re-renders

## 0.4.14
- Ctrl+C / V / X handled by the panel via the clipboard API, no longer relying on `execCommand`
- Line-level editing only re-checks the current file, no longer refreshing the whole repo
- Merge lines and delete lines: Backspace at line start joins the previous line, Delete at line end joins the next line, Ctrl+Shift+K deletes the whole line

## 0.4.13
- Tab indentation follows `editor.insertSpaces` / `editor.tabSize`
- Enter inserts a line based on cursor position: above when at line start, below at line end, splits the line in the middle
- Ctrl+S saves the current line; Ctrl+Z / Ctrl+Shift+Z for undo / redo

## 0.4.12
- Removed the "Next Unreviewed" icon button from the tree view title bar (the text button inside the panel remains)

## 0.4.11
- Removed the "Next Unreviewed" button from the panel; tree commands and the auto-jump after finishing a review remain
- Fixed the Linux "0 changes" illusion: the folder and repo root paths mismatched so the pathspec matched nothing
- Extension icon: white background changed to real transparency
- `changeReview.uiLanguage` set to `zh` forces Chinese (auto follows the VSCode display language)

## 0.4.10
- Fixed reviewed marks lost after "part reject, part accept" (content fingerprint mismatch)
- Logs written to `globalStorage/change-review.log`; view via "Open Log" in the command palette

## 0.4.9
- Fixed rejected hunks showing no visual change: reject state was never rendered

## 0.4.8
- Same content as 0.4.7; version bumped independently to distinguish install packages

## 0.4.7
- Rejecting a hunk is now deferred, symmetric with accepting: only records the decision, shows a red "Rejected · pending" badge
- Fixed rejected hunks still reverting immediately (auto-mark counted rejections as done)
- Added setting `changeReview.uiLanguage` (auto / zh / en)
- Added the "Open Log" command; error dialogs open the Output panel automatically
- Removed the re-entry lock from "Next Unreviewed" (it could get stuck on error paths)
- Hunk-level accept / reject buttons hidden once a file is marked as reviewed

## 0.4.6 (local packaging test only · not published to the marketplace; version frozen, no more bumps until the user agrees)
- Panel text bilingual (English / Simplified Chinese), following the VSCode display language
- Switched to the official extension icon (dark background, white file + green check), added marketplace icon `resources/icon.png`
- Fixed all panel buttons and keybindings being dead
- Copying now goes through the extension host to the system clipboard
- Fixed "Reject All" not deleting new files (files staged once report kind=added)
- Fixed SVN leaving an empty file after rejecting a new file
- "Jump" now opens VSCode's native side-by-side diff and goes to the changed line
- Multi-line selection: click line numbers, Ctrl/Cmd and Shift multi-select, double-click selects a whole hunk, Ctrl+A selects all; the floating toolbar supports copy / delete / restore for the selection
- Hunks support hunk-level restore
- The tree highlights `◀ reviewing` and follows switches
- Linux git diagnostics: raw output dumped when 0 changes are parsed; quoted paths supported

## 0.4.5
- Accept / reject no longer touch the git staging area; only decisions are recorded and files get a checkmark
- Removed line-level "+ line / delete line" buttons; adding / deleting lines is keyboard-only
- While editing, ↑/↓ moves between editable lines and writes back on blur

## 0.4.4
- Fixed focus jumping to the wrong line after deleting a line

## 0.4.3
- Fixed the change list highlight not following "Next Unreviewed" (`treeView.reveal` scrolls and selects)
- Fixed "Update Baseline" on unmanaged projects only updating the currently selected file
- Nearby changed lines are merged back into one hunk (reverting the per-cluster split of 0.4.2), consistent with `git -U3`
- Diff hunks support keyboard line deletion: Backspace / Delete on empty lines, Ctrl/Cmd+Delete on any line

## 0.4.2
- Fixed `.crignore` directory excludes not working (patterns like `build/`)
- Unified diff add/remove line colors with the buttons
- Diff hunks support adding / deleting lines: Enter inserts below and focuses, Esc discards
- Fixed changes still showing after "Update Baseline" on unmanaged projects (untracked files never entered the baseline)

## 0.4.1
- Fixed hunks growing and shrinking while moving between them (buttons now hide via visibility)
- Unified button styling: shared outline base, color conveys meaning
- Removed the leftover "Show Editor" button

## 0.4.0
- "Edit" = edit in place inside the diff hunk; the standalone "Edit" button is gone, each hunk keeps only "Jump"
- Fixed "Jump" being slow and pausing at the first line before jumping
- Exclude file renamed `.changereviewignore` → `.crignore`
- No `.crignore` file icon: VSCode has no single-file icon API and a full icon theme would cost more than it is worth

## 0.3.9
- Removed the embedded editor (the hidden textarea "free edit")

## 0.3.8
- Removed the "Diagnose Environment" command; diagnostics are written to the Output panel anyway
- "Configure Exclude Rules" now edits the project's exclude file directly instead of jumping to settings
- Accept / reject semantics moved into tooltips
- Diff hunks redesigned as cards (rounded border + themed add/remove backgrounds + left color bar)

## 0.3.7
- Fixed the title bar icon still being text (`view/title` needs an explicit icon)
- Added the embedded editor "free edit"
- Hunk-level "Jump" now jumps inside the panel

## 0.3.6
- Accept / reject parenthetical semantics moved into tooltips
- Removed the "Open in editor and modify" button
- The git / svn / snapshot detection result is now visible
- Localization: `package.nls.json` + English / Simplified Chinese
- New Activity Bar / title bar icons
- Brighter add-line colors

## 0.3.5
- Title bar trimmed to two icon buttons: "Refresh" and "Next Unreviewed"
- Removed the "Change Review: " prefix from command titles
- Jump / Edit now open the real file
- Added the "Configure Exclude Rules…" command, available from the title bar "…", context menus and the welcome page
- Performance improvements

## 0.3.4
- Title bar icon buttons added: Initialize Baseline, Update Baseline, Mark All as Reviewed, Clear All
- Keyboard shortcuts added, active only while the view is focused

## 0.3.3
- Exclude rules renamed to the generic `changeReview.exclude` (replacing `svnIgnore`)
- Title bar "Refresh" / "Next Unreviewed" switched to icon buttons

## 0.3.2
- SVN unversioned items respect ignore rules
- Upward probing capped at 5 levels
- Built-in snapshot excludes and SVN ignores unified into one set

## 0.3.1
- Fixed the whole repo's changes being listed when opening a subdirectory of a repo
- Diagnostics now include the opened-folder scope

## 0.3.0
- SVN and unmanaged project support (snapshot baseline); sources auto-detected git → svn → snapshot, overridable via `forceVcs`
- SVN: `.svn` probed upward per `vcsSearchDepth` (default 5 levels)
- Snapshot baselines stored in globalStorage, never polluting the project; can be initialized / updated (including the selected file only)
- New commands: "Initialize Baseline", "Update Baseline"
- New settings: `svnPath`, `forceVcs`, `vcsSearchDepth`, `snapshotExclude`, `snapshotMaxFileSize`, `snapshotMaxFiles`
- Hunk rejection rewritten as pure JS reverse replacement, consistent across all three sources
- Built-in pure JS line-level diff engine (prefix/suffix trim + Myers + common anchors); oversized diffs degrade to whole-block replacement
- Expanded diagnostics: source type / baseline / file count / snapshot location

## 0.2.0
- Fixed all review panel buttons being dead
- Added per-hunk accept / reject
- Panel messages and git actions logged to the Output panel
- A refresh prompt appears when hunks no longer match the diff, preventing accidental edits to the wrong hunk

## 0.1.1
- Platform adaptation: git candidate paths per platform (Windows / Linux(WSL) / macOS), auto-detected and cached; mismatched path systems recognized and candidates switched
- `extensionKind: workspace` ensures WSL / remote runs in the workspace; a warning appears when the remote workspace runs in the local host
- git `dubious ownership` prompt with one-click `safe.directory`
- Command target file fallback: tree selection → current editor file → panel's current file
- All commands wrapped in try/catch; failures notify and log to Output
- Reviewed files also show review commands in their context menu
- Added the "Diagnose Environment" command and setting `changeReview.gitPath`
- Fixed the command wrapper swallowing return values, and "Mark All as Reviewed" not syncing in-memory state so badges did not update

## 0.1.0
- List local files differing from the last commit with `+added / −deleted` line counts
- Tick files as reviewed; state persists and is cleared automatically when a file changes again
- Activity Bar badge + status bar progress
- Click a file name to enter review mode: unified diff view, per-hunk restore, accept / reject
- Open in the native diff editor, right side directly editable
- "Next Unreviewed" cycles through files; multi-repo workspaces are grouped
