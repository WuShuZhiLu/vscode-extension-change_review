# Change Review

English | [简体中文](./README.md)

A lightweight VSCode review extension: works with git, svn, and unmanaged projects. List local changes as a checklist, tick files off as you review them, and click a file name to open a diff review panel where you can accept / reject per hunk.

Built for AI Coding. The built-in review capabilities of AI tools such as Codex, DeepSeek, WorkBuddy and ZCode are inconsistent — mixing them is painful. Change Review gives you one unified review flow for code generated or modified by one or more AI tools.

## Features

- **Change list**: status (modified / added / deleted / renamed / untracked / conflict), +/- line counts, source type; reviewed files sort last (configurable).
- **Review panel**: standalone themed diff view. Each hunk offers "Accept block / Reject block / Goto"; accepts and rejects can be undone symmetrically.
- **In-hunk editing**: edit lines in place (Tab / Enter to split / Ctrl+S / Ctrl+Z / Ctrl+Y), or jump to the real file editor.
- **Exclude rules**: `.crignore` semantics identical to `.gitignore`; git projects can skip `.crignore` and reuse `.gitignore` (`.crignore` wins when both exist).
- **Grouped sources**: multiple git / svn repos are grouped; when the repo root is outside the opened folder, only changes inside it are listed.
- **i18n**: English and Simplified Chinese following the VSCode display language (`changeReview.uiLanguage`).

Three sources, auto-detected (git → svn → snapshot; override with `forceVcs`):

| Source | Baseline | Notes |
| --- | --- | --- |
| **Git** | `HEAD` | Multi-repo workspaces supported |
| **SVN** | `BASE` | Subdirectory projects supported |
| **Snapshot** | Manual | Run "Initialize Baseline" once for projects without git/svn; updatable later |

## Review Model

- **Accept / reject (file-level or hunk-level) only records the decision** — no file changes, no staging.
- **When every hunk of a file has a decision, the file is auto-marked as reviewed**, and execution happens at that moment:
  - Accepted parts → `git add` on git projects; no-op elsewhere;
  - Rejected parts → revert to baseline (git restore / svn revert / snapshot write-back); untracked files are deleted;
  - "Reject All" reverts the whole file.
- **Manual "mark as reviewed"**: on git, ticking = `git add`, unticking = `git reset` (working tree untouched).
- **Manual "unmark" wins**: after unmarking, the file will not be auto-marked again unless it changes.
- A file modified again → its tick is invalidated and it needs re-review.

## Install

Zero dependencies, no build step (plain JavaScript).

```bash
npm run release         # package into dist/ (vsix + source zip)
npm run install-local   # package and install into local VSCode
```

Or: Extensions view `...` → "Install from VSIX…" and pick the `.vsix` in `dist/`. For development, open this folder and press `F5`.

## Usage

### Commands

| Command | Description |
| --- | --- |
| `Refresh Changes` / `Focus Changes` | Refresh / focus the view |
| `Enter Review Mode` | Open the review panel for a file |
| `Open Diff in Editor` | Native diff editor (baseline ↔ working tree) |
| `Accept Changes` | Record all hunks as accepted and auto-mark (`git add` on git projects) |
| `Reject Changes` | Record all hunks as rejected and auto-mark (revert / delete on mark) |
| `Mark Reviewed` / `Unmark Reviewed` | Manual tick; git: tick = `git add`, untick = `git reset` |
| `Mark All Reviewed` / `Clear All Reviewed` | Bulk operations |
| `Next Unreviewed` | Jump to the next unreviewed file |
| `Initialize Baseline` / `Update Baseline` | Snapshot baseline management (stored in extension storage, not in the project) |
| `Configure Exclude Rules…` | Open settings at `changeReview.exclude` |
| `Ignore This File` | Write into `.crignore`; the file disappears from the list |

### Keybindings (view focused)

| Key | Action |
| --- | --- |
| `Ctrl+Enter` | Enter review panel |
| `Ctrl+Shift+A` / `Ctrl+Shift+R` | Accept / reject |
| `Ctrl+Shift+M` | (Un)mark reviewed |
| `Alt+N` | Next unreviewed |

> On macOS `Ctrl` means `Cmd`.

### Settings

| Setting | Default | Description |
| --- | --- | --- |
| `changeReview.includeUntracked` | `true` | List untracked files |
| `changeReview.sortReviewedLast` | `true` | Reviewed files sort last |
| `changeReview.autoRefreshInterval` | `5` | Auto refresh interval (seconds), `0` disables |
| `changeReview.contextLines` | `3` | Diff context lines |
| `changeReview.showStatusBar` | `true` | Status bar badge |
| `changeReview.gitPath` / `svnPath` | empty | Full path to the executable; auto-detected when empty |
| `changeReview.uiLanguage` | `auto` | Panel language: `auto` / `zh` / `en` |
| `changeReview.forceVcs` | `auto` | Force source: `auto` / `git` / `svn` / `snapshot` |
| `changeReview.vcsSearchDepth` | `5` | Levels to search up for `.git` / `.svn` (max 5) |
| `changeReview.exclude` | `[]` | Manual excludes (glob, relative to project root), all sources |
| `changeReview.snapshotExclude` | `[node_modules, ...]` | Snapshot mode excludes |
| `changeReview.snapshotMaxFileSize` | `1024` | Files above this size (KB) are not stored for line diffs |
| `changeReview.snapshotMaxFiles` | `10000` | Max files in a snapshot baseline |

## Development

### Tests

```bash
npm run selfcheck   # real temp git repo: stats / diff parsing / hunk revert / accept / reject
npm run vcscheck    # real temp svn repo + snapshot dir: multi-source
npm run mockcheck   # mocked vscode API: tree / badges / panel flows (supports --only <scenes>)
```

### Release

The version comes from `package.json`. Pushing a tag triggers CI to publish; **the tag must match the version**:

```bash
git tag v<version> && git push origin v<version>
```

## Known Limitations

- If a file changed and hunk positions no longer match, block operations report an error instead of guessing.
- Deleted files do not support per-hunk operations; binary files show line counts only.
- SVN handles text changes only; property changes affect the status column only.
- Requires system `git` / `svn` executables; snapshot baselines live in extension globalStorage (use `snapshotExclude` and related settings for large projects).
