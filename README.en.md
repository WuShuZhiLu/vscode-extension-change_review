# Change Review

A lightweight VSCode extension: list local changes against a baseline, tick files off as you review them, and click a file name to open a diff review panel where you can accept / reject per hunk. File and git operations run when a file is marked as reviewed.

**Three sources, auto-detected** (git → svn → snapshot; override with `changeReview.forceVcs`):

| Source | Baseline | Notes |
| --- | --- | --- |
| **Git** | `HEAD` | Multi-repo workspaces supported (when the opened folder is not a repo, one level of subdirectories is scanned) |
| **SVN** | `BASE` | Detects `.svn` in parent directories automatically |
| **Snapshot** | Manual | For projects without git/svn: run "Initialize Baseline" once, then diff against it |

## Core Rules

- **Accept / reject (file-level or hunk-level) only records the decision** — no file changes, no staging.
- **When every hunk of a file has a decision, the file is auto-marked as reviewed**; execution happens at that moment:
  - Accepted parts → `git add` (staged) on git projects;
  - Rejected parts → revert to baseline (git restore / svn revert / snapshot write-back); untracked files are deleted; "reject all" reverts the whole file.
- **Manual "mark as reviewed"**: on git, ticking = `git add`, unticking = `git reset` (working tree untouched).
- **Manual "unmark" wins**: after unmarking, the file will not be auto-marked again until it changes.
- A file modified again → its tick is invalidated and it needs re-review.

## Features

- **Change list**: status (modified / added / deleted / renamed / untracked / conflict), +/- line counts, source type; reviewed files sorted last (configurable).
- **Review panel**: standalone themed diff view. Each hunk offers "Accept block / Reject block / Goto"; accepted blocks can be un-accepted, rejected blocks un-rejected (symmetric).
- **In-hunk editing**: jump to the real file and edit; inline line editing (Tab / Enter to split / Ctrl+S / Ctrl+Z / Ctrl+Y); line selection, multi-select, per-segment "Copy / Delete selection / Revert segment"; "Copy" on deleted lines copies the removed text.
- **Panel context menu**: open diff / accept all / reject all / (un)mark reviewed / ignore file / copy path / refresh. System copy is allowed when text is selected.
- **Tree view**: file nodes → "Ignore This File" (writes `.crignore` next to it); repo nodes → "Configure Exclude Rules…".
- **Exclude rules**: `.crignore` first, falling back to `.gitignore`; semantics identical to `.gitignore` (relative to the rule file's directory). Additional globs via `changeReview.exclude`.
- **Scope limiting**: when the repo root is outside the opened folder, only changes inside it are listed.
- **Grouped sources**: multiple git / svn repos are grouped.
- **i18n**: English and Simplified Chinese throughout.

## Install / Run

Zero dependencies, no build step (plain JavaScript).

```bash
npm run release         # package into dist/ (vsix + source zip)
npm run install-local   # package and install into local VSCode
```

Or: Extensions view `...` → "Install from VSIX…". For development, open this folder and press `F5`.

## Release

The version comes from `package.json`; **the tag must match it** or CI refuses to publish:

```bash
git tag v0.5.0-pre1 && git push origin v0.5.0-pre1
```

CI (GitHub `.github/workflows/release.yml` / Gitea `.gitea/workflows/release.yml`) runs tests, packages, and uploads the `.vsix` plus a source zip. Versions containing `-` are published as prereleases.

## Commands

| Command | Description |
| --- | --- |
| `Refresh Changes` / `Focus Changes` | Refresh / focus the view |
| `Enter Review Mode` | Open the review panel for a file |
| `Open Diff in Editor` | Native diff editor (baseline ↔ working tree) |
| `Accept Changes` | Record all blocks as accepted and auto-mark (git add on mark) |
| `Reject Changes` | Record all blocks as rejected and auto-mark (revert / delete on mark) |
| `Mark Reviewed` / `Unmark Reviewed` | Manual tick; git: tick = `git add`, untick = `git reset` |
| `Mark All Reviewed` / `Clear All Reviewed` | Bulk |
| `Next Unreviewed` | Jump to the next unreviewed file |
| `Initialize Baseline` / `Update Baseline` | Snapshot baseline management (stored in extension storage, not in the project) |
| `Configure Exclude Rules…` | Open settings at `changeReview.exclude` |
| `Ignore This File` | Write into `.crignore`; the file disappears from the list |
| `Diagnose Environment` | Print environment info to the Output panel |

## Keybindings (view focused)

| Key | Action |
| --- | --- |
| `Ctrl+Enter` | Enter review panel |
| `Ctrl+Shift+A` / `Ctrl+Shift+R` | Accept / reject |
| `Ctrl+Shift+M` | (Un)mark reviewed |
| `Alt+N` | Next unreviewed |

> On macOS `Ctrl` means `Cmd`.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `changeReview.includeUntracked` | `true` | List untracked files |
| `changeReview.sortReviewedLast` | `true` | Reviewed files sort last |
| `changeReview.autoRefreshInterval` | `5` | Auto refresh interval (seconds), `0` disables |
| `changeReview.contextLines` | `3` | Diff context lines |
| `changeReview.showStatusBar` | `true` | Status bar badge |
| `changeReview.gitPath` / `svnPath` | empty | Full path to the executable; auto-detected when empty |
| `changeReview.uiLanguage` | `auto` | Panel language: `auto` / `en` / `zh` |
| `changeReview.forceVcs` | `auto` | Force source: `auto` / `git` / `svn` / `snapshot` |
| `changeReview.vcsSearchDepth` | `5` | Levels to search up for `.git` / `.svn` (max 5) |
| `changeReview.exclude` | `[]` | Manual excludes (glob, relative to project root), all sources |
| `changeReview.snapshotExclude` | `[node_modules, ...]` | Snapshot mode excludes |
| `changeReview.snapshotMaxFileSize` | `1024` | Files above this size (KB) are not stored for line diffs |
| `changeReview.snapshotMaxFiles` | `10000` | Max files in a snapshot baseline |

## Self-Test

```bash
npm run selfcheck   # real temp git repo: stats / diff parsing / hunk revert / accept / reject
npm run vcscheck    # real temp svn repo + snapshot dir: multi-source
npm run mockcheck   # mocked vscode API: tree / badges / panel flows (supports --only <scenes>)
```

## Known Limitations

- If a file changed and hunk positions no longer match, block operations report an error instead of guessing.
- Deleted files do not support per-hunk operations; binary files show line counts only.
- SVN handles text changes only; property changes affect the status column only.
- Requires system `git` / `svn` executables; snapshot baselines live in extension globalStorage.
- WSL / remote: the extension is workspace-typed and must be installed into WSL; for `dubious ownership` on `/mnt/c`, use "Trust Repository".
