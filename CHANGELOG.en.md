# Change Log (English)

> The Chinese `CHANGELOG.md` is the authoritative, complete history. This file mirrors the recent releases in English.

## 0.4.20

- **Panel button label**: once a file is reviewed the button now reads "Unmark reviewed" (no more "Reviewed ✓ (click to unmark)" parenthetical); otherwise "Mark as reviewed". The label is now localized too (it used to be hard-coded Chinese even in English UI).
- **Fixed "all blocks ticked but the file was not marked as reviewed"**:
  - **Crash removed**: `parseDiff(t)[0].hunks` threw a `TypeError` when the diff text was empty (typical: the file was reverted or taken over externally while you were reviewing). The outer catch swallowed it, leaving only a log line — which looked like "clicking did nothing and nothing got marked". All call sites now null-check and surface a clear "the file changed, this block no longer lines up — please refresh" message.
  - **Reconciliation pass**: the block-level check only ran at the moment you clicked accept/reject, so anything that skipped it (auto-refresh swapping the model objects, the panel holding a stale entry, concurrent clicks) could never be recovered. Every refresh now ends with a reconciliation: any file whose current blocks all have a decision but is not ticked gets marked. This makes "all ticked" ⇒ reviewed.
  - **One hash source**: the hash stored when marking is now taken from the provider's own re-check (the same source the refresh uses), so a fresh mark can no longer be judged "not reviewed" by the next refresh.
  - When auto-marking does not apply, the reason is logged (`Change Review: Open Log`).
- Tests: mockcheck [23] covers four real orders — accept all; reject one + accept the rest (including "mark survives a full refresh after the revert"); accept one, full refresh, then accept the rest; and the file being reverted externally mid-review (must warn, not fail silently). Reverting the null-check makes [23] D fail.

## 0.4.19

- **Fixed "Ignore this file" not taking effect, and aligned exclude matching with `.gitignore` semantics.**
  - **Root cause**: a `.gitignore` rule matches paths **relative to the directory containing that `.gitignore`**. We were flattening `.crignore` rules into one list and matching them against paths **relative to the source root** (git repo root / svn working-copy root / snapshot root). When the source root differs from the rule file's directory (typically: VSCode has a repo *subdirectory* open), the prefixes never line up and the rule can never match — so ignoring silently did nothing.
  - **Fix**: rules from project ignore files (`.crignore`, and the `.gitignore` fallback) are now passed to each source **together with the directory they live in**, and matched against the path relative to that directory (`util.matchExcludeSets`) — exactly like git. The `changeReview.exclude` setting still matches relative to the source root.
  - "Ignore this file" writes the rule relative to the `.crignore`'s own directory again (the natural gitignore form); **existing rules need no manual edit**.
  - Also fixed two things that made it *look* like nothing happened: the panel now waits for any in-flight refresh and then forces a rebuild, and if the file is still listed the rule/base pair is logged (`Change Review: Open Log`).
  - Note: 0.4.18 changed rules to be source-root-relative and added an "any depth" fallback; that was the wrong direction (it accommodated the old matching base) and has been reverted.
- Tests: selfcheck [8.1] (`matchExcludeSets` / `relFromBase` anchoring, including "does not catch same-named paths outside the rule file's directory"); mockcheck [22]; a real-SVN vcscheck case (svn root above the opened subdirectory). All three suites pass, and reverting the fix makes the tests fail.

## 0.4.17

- **New "Ignore this file"**: from the review panel you can add the current file to the workspace folder's `.crignore` (gitignore-style relative-path rule) in one click; the list re-detects and the file disappears immediately.
  - **Panel right-click menu** (new): right-click anywhere in the panel for Open diff / Accept all / Reject all / Mark(Unmark) reviewed / Ignore this file / Copy file path / Refresh. Right-clicking inside an inline editing row keeps the native copy/paste menu.
  - A toolbar **"Ignore this file"** button was added as well.
  - The tree item context menu and the command palette also offer "Ignore File (Add to .crignore)", localized to the VSCode display language.
  - Idempotent: a path already present in `.crignore` is not appended twice; after ignoring, if the current file left the list the panel jumps to the next unreviewed file.

## 0.4.15

- **Exclude rules fall back to `.gitignore`**: when a folder has no `.crignore`, its `.gitignore` rules are used (git projects need no extra config). `.crignore` still wins when present.
- **Select-all + Backspace no longer merges wrongly**: line merging only triggers without a selection; with a selection, Backspace/Delete just deletes the selected content.
- **Undo/redo covers line operations**: a file-level snapshot stack lives in the extension host (survives panel re-renders). Inline text still uses the fine-grained stack; when it is empty, Ctrl+Z / Ctrl+Y fall through to file-level undo/redo, so **inserted, deleted and merged lines** can be undone and redone.
- **Fixed "undo → redo → undo again does nothing"**: the webview undo stack was wiped on every re-render; the stack now lives host-side.
- Tests: `.gitignore` fallback, merge-requires-no-selection, insert-line undo/redo/re-undo.

## 0.4.14

- **Ctrl+V / Ctrl+C / Ctrl+X actually work**: the panel now drives the clipboard itself (`navigator.clipboard.readText/writeText`) instead of relying on default browser behaviour or `execCommand`, which VSCode often swallows. Ctrl+Z / Ctrl+Y also preventDefault + stopPropagation; empty stacks now report instead of silently doing nothing.
- **Enter in the middle of a line is fast again**: line operations now re-check a single file (`refreshSingleEntry`) instead of rescanning the whole repository (`doRefresh`).
- **Merge & delete lines**: Backspace at line start merges into the previous line; Delete at line end pulls the next line up; **Ctrl+Shift+K** deletes a whole line.

## 0.4.13

- **Tab follows your editor settings**: inline Tab inserts spaces or a tab according to `editor.insertSpaces` / `editor.tabSize`.
- **Enter direction depends on the caret**: start of line → insert above; end of line → insert below; middle → split the line.
- **Ctrl combos work while editing lines**: Ctrl+S saves the current line (with feedback when nothing changed), Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y undo/redo, Ctrl+C / Ctrl+X use the clipboard, Ctrl+A selects the current line only, Ctrl+V handled uniformly.

## 0.4.12

- Corrected the removal: the **title-bar icon button** "Next Unreviewed" is gone; the text button inside the panel stays.

## 0.4.11

- **Linux "0 changes" fix**: when the opened folder and the repository root resolve differently (symlink/mount), `../..` was passed to git as a pathspec and matched nothing. Now such scopes fall back to a full-repo scan, and empty `git status` results log `root` + `pathspec`.
- **Icon background is truly transparent** (the white corners are alpha-zero now).
- Note on panel language: set `changeReview.uiLanguage` to `zh` to force Chinese (`auto` follows the VSCode display language; an English VSCode yields English).

## 0.4.10

- **Fixed the lost "reviewed" mark** after partial reject + partial accept: the mark is keyed by a content fingerprint, and reverting hunks changed it. The fingerprint is now recomputed after a revert.
- **Linux diagnostics**: logs are also written to `globalStorage/change-review.log`; every git failure and anomalous empty `git status` is logged; each scan records per-source counts and errors.

## 0.4.9

- All hunks decided (accepted **or** rejected) → auto mark as reviewed; rejected hunks are reverted at that moment.
- After a file is fully reviewed and has no diff left, it is removed from the list and the panel jumps to the next unreviewed file; when everything is reviewed the panel shows "All files reviewed ✓".
- **Fixed: rejecting a block showed no visual change** — `rejectedSigs` was never passed into the hunk renderer. Rejected hunks now show a red header, dimmed rows, a red bar, a "pending" badge and an "Undo reject" button.

## 0.4.7 – 0.4.8

- Reject block became deferred (record now, revert when marked as reviewed), reject-all auto-marks as reviewed, panel i18n (zh/en), AI-generated icon, Linux git diagnostics, "Next" lock removed, logging surfaced.

## Earlier

See `CHANGELOG.md` (Chinese) for the full history.
