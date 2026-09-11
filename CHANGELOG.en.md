# Change Log (English)

> The Chinese `CHANGELOG.md` is the authoritative history; this file mirrors it.

## 0.5.0-pre1
- Core rule: accept / reject (file-level and hunk-level) only records the decision - no file changes, no staging.
- When every hunk of a file has a decision, the file is auto-marked reviewed; git add / revert / delete run at that moment.
- git: any "mark as reviewed" stages the file (git add); unticking = git reset.
- Added "Un-accept" for accepted blocks, symmetric with "Un-reject".
- Marking reviewed now jumps to the next unreviewed file.
- Manual unmark is respected: no auto re-mark while the file is unchanged.
- Multi-repo workspaces: when the opened folder is not a repo, one level of subdirectories is scanned for git/svn repos.
- "Reject all" no longer shows a confirmation dialog.
- Tree context menu: file nodes get "Ignore This File" (.crignore), repo nodes keep "Configure Exclude Rules..."; renamed "Clear All Reviewed Marks" to "Clear All Reviewed".
- Fixed panel context menu not opening over the diff body; fixed the in-review marker disappearing across refreshes.
- Exclude rules fall back to .gitignore.
- Faster iteration: mockcheck --only <scenes>; release uses a pre-installed vsce.
- Added CI/CD (GitHub + Gitea): tag to release.
- Docs trimmed (README / CHANGELOG kept to intro, features, changes).

## 0.4.20

## 0.4.20
- Panel button label: once a file is reviewed the button now reads "Unmark reviewed" (no more "Reviewed ✓ (click to unmark)" parenthetical…
- Fixed "all blocks ticked but the file was not marked as reviewed":
- Tests: mockcheck [23] covers four real orders — accept all; reject one + accept the rest (including "mark survives a full refresh after …

## 0.4.19
- Fixed "Ignore this file" not taking effect, and aligned exclude matching with `.gitignore` semantics.
- Tests: selfcheck [8.1] (`matchExcludeSets` / `relFromBase` anchoring, including "does not catch same-named paths outside the rule file's…

## 0.4.17
- New "Ignore this file": from the review panel you can add the current file to the workspace folder's `.crignore` (gitignore-style relati…

## 0.4.15
- Exclude rules fall back to `.gitignore`: when a folder has no `.crignore`, its `.gitignore` rules are used (git projects need no extra c…
- Select-all + Backspace no longer merges wrongly: line merging only triggers without a selection; with a selection, Backspace/Delete just…
- Undo/redo covers line operations: a file-level snapshot stack lives in the extension host (survives panel re-renders).
- Fixed "undo → redo → undo again does nothing": the webview undo stack was wiped on every re-render; the stack now lives host-side.
- Tests: `.gitignore` fallback, merge-requires-no-selection, insert-line undo/redo/re-undo.

## 0.4.14
- Ctrl+V / Ctrl+C / Ctrl+X actually work: the panel now drives the clipboard itself (`navigator.clipboard.readText/writeText`) instead of …
- Enter in the middle of a line is fast again: line operations now re-check a single file (`refreshSingleEntry`) instead of rescanning the…
- Merge & delete lines: Backspace at line start merges into the previous line; Delete at line end pulls the next line up; Ctrl+Shift+K del…

## 0.4.13
- Tab follows your editor settings: inline Tab inserts spaces or a tab according to `editor.insertSpaces` / `editor.tabSize`.
- Enter direction depends on the caret: start of line → insert above; end of line → insert below; middle → split the line.
- Ctrl combos work while editing lines: Ctrl+S saves the current line (with feedback when nothing changed), Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y…

## 0.4.12
- Corrected the removal: the title-bar icon button "Next Unreviewed" is gone; the text button inside the panel stays.

## 0.4.11
- Linux "0 changes" fix: when the opened folder and the repository root resolve differently (symlink/mount), `../..` was passed to git as …
- Icon background is truly transparent (the white corners are alpha-zero now).
- Note on panel language: set `changeReview.uiLanguage` to `zh` to force Chinese (`auto` follows the VSCode display language; an English V…

## 0.4.10
- Fixed the lost "reviewed" mark after partial reject + partial accept: the mark is keyed by a content fingerprint, and reverting hunks ch…
- Linux diagnostics: logs are also written to `globalStorage/change-review.log`; every git failure and anomalous empty `git status` is log…

## 0.4.9
- All hunks decided (accepted or rejected) → auto mark as reviewed; rejected hunks are reverted at that moment.
- After a file is fully reviewed and has no diff left, it is removed from the list and the panel jumps to the next unreviewed file; when e…
- Fixed: rejecting a block showed no visual change — `rejectedSigs` was never passed into the hunk renderer.

## 0.4.7 – 0.4.8
- Reject block became deferred (record now, revert when marked as reviewed), reject-all auto-marks as reviewed, panel i18n (zh/en), AI-gen…

## Earlier
