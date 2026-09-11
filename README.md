# Change Review

一个轻量的 VSCode 插件：把本地改动（相对基准）列成清单，逐文件打钩标记 review 进度，点文件名进入 diff 审查面板，可按块接受 / 拒绝，标记已审查时统一执行文件与 git 操作。

**三种来源，自动探测**（顺序 git → svn → 快照基准，可用 `changeReview.forceVcs` 强制）：

| 来源 | 对比基准 | 说明 |
| --- | --- | --- |
| **Git** | `HEAD` | 支持多仓库工作区（打开目录不是仓库时自动扫一层子目录） |
| **SVN** | `BASE` | `.svn` 在上级目录时自动逐级向上探测 |
| **快照基准** | 手动建立 | 无 git/svn 的项目：执行一次「初始化对比基准」，之后以它为基准 |

## 核心规则

- **接受 / 拒绝（文件级或块级）只是记录决定**，不改文件、不进暂存区。
- **一个文件的所有改动块都有决定后，自动标记为已审查**；真正的执行发生在标记那一刻：
  - 接受的部分 → git 工程执行 `git add`（进暂存区）；
  - 拒绝的部分 → 还原到基准（git restore / svn revert / 快照写回），未跟踪文件删除，「拒绝全部」为整文件还原。
- **手动「标记已审查」**：git 下勾选 = `git add`，取消勾选 = `git reset`（工作区内容不动）。
- **手动「取消审查」优先**：取消后只要文件没再改，就不会被自动标记打回；文件改动后恢复自动标记。
- 文件被再次修改 → 原打钩自动失效，需要重新审。

## 功能

- **改动清单**：状态（修改 / 新增 / 删除 / 重命名 / 未跟踪 / 冲突）、增删行数、来源类型；已审查排最后（可配）。
- **审查面板**：独立 diff 视图（跟随主题配色）。每个块悬停出现「接受此块 / 拒绝此块 / 跳转」；已接受的块可「取消接受」，已拒绝的可「撤销拒绝」（对称）。
- **块内编辑**：跳转到真实文件直接改；行内可编辑（Tab / 回车拆合行 / Ctrl+S / Ctrl+Z / Ctrl+Y）；行号点击选行、多选、段级「复制 / 删除选中 / 还原此段」；删除行的「复制」复制被删原文用于手动恢复。
- **面板右键菜单**：打开新旧对比 / 接受全部 / 拒绝全部 / 标记(取消)已审查 / 忽略该文件 / 复制文件路径 / 刷新。选中文本时放行系统复制菜单。
- **树视图**：右键文件节点 →「忽略该文件」（写入所在目录 `.crignore`）；仓库节点 →「配置排除规则…」。
- **排除规则**：优先 `.crignore`，没有则默认采用 `.gitignore`；规则语义与 `.gitignore` 一致（相对规则文件所在目录）。另可用 `changeReview.exclude`（glob）手动追加。
- **范围限制**：仓库根在打开目录之外时，只显示打开目录内的改动。
- **多来源分组**：多个 git / svn 仓库按来源分组展示。
- **多语言**：中英双语（i18n + 双语 README / CHANGELOG）。

## 安装 / 运行

零依赖、无编译步骤（纯 JavaScript）。

```bash
npm run release         # 打包，产物在 dist/（vsix + 源码 zip）
npm run install-local   # 打包并装进本机 VSCode
```

或在 VSCode 扩展面板 `...` →「从 VSIX 安装…」选 `dist/` 下的 `.vsix`。开发调试：本目录按 `F5`。

## 发版

版本号以 `package.json` 的 `version` 为准，**tag 必须和它一致**，CI 才会发版：

```bash
git tag v0.5.0-pre1 && git push origin v0.5.0-pre1
```

CI（GitHub `.github/workflows/release.yml` / Gitea `.gitea/workflows/release.yml`）自动跑测试 → 打包 → 上传 `.vsix` 与源码 zip。带 `-` 的版本号标记为 prerelease。

## 命令

| 命令 | 说明 |
| --- | --- |
| `刷新改动列表` / `聚焦改动列表` | 刷新 / 跳转视图 |
| `进入审查模式` | 打开该文件的审查面板 |
| `在编辑器中打开差异` | 原生 diff 编辑器（基准 ↔ 工作区） |
| `接受改动` | 记录全部块为已接受并自动标记（git 下随标记 `git add`） |
| `拒绝改动` | 记录全部块为已拒绝并自动标记（随标记还原 / 删除文件） |
| `标记已审查` / `取消已审查标记` | 手动打钩；git 下勾选 = `git add`、取消 = `git reset` |
| `全部标记已审查` / `全部清除已审查` | 批量 |
| `下一个待审查` | 跳到下一个未审查文件 |
| `初始化对比基准` / `更新对比基准` | 快照基准项目的基准管理（基准存扩展存储，不写项目目录） |
| `配置排除规则…` | 打开设置并定位 `changeReview.exclude` |
| `忽略该文件` | 写入 `.crignore`，之后不再出现在改动列表 |
| `诊断环境（Git / SVN / 平台 / 仓库）` | 环境信息打到 Output 面板，排障先跑这个 |

## 快捷键（视图聚焦时）

| 键位 | 说明 |
| --- | --- |
| `Ctrl+Enter` | 进入审查面板 |
| `Ctrl+Shift+A` / `Ctrl+Shift+R` | 接受 / 拒绝 |
| `Ctrl+Shift+M` | 标记 / 取消已审查 |
| `Alt+N` | 下一个待审查 |

> macOS 上 `Ctrl` 对应 `Cmd`。

## 设置

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| `changeReview.includeUntracked` | `true` | 是否列出未跟踪的新文件 |
| `changeReview.sortReviewedLast` | `true` | 已审查文件排到最后 |
| `changeReview.autoRefreshInterval` | `5` | 自动刷新间隔（秒），`0` 关闭 |
| `changeReview.contextLines` | `3` | diff 上下文行数 |
| `changeReview.showStatusBar` | `true` | 显示状态栏徽章 |
| `changeReview.gitPath` / `svnPath` | 空 | 可执行文件完整路径，留空自动探测 |
| `changeReview.uiLanguage` | `auto` | 面板语言：`auto` / `zh` / `en` |
| `changeReview.forceVcs` | `auto` | 强制来源：`auto` / `git` / `svn` / `snapshot` |
| `changeReview.vcsSearchDepth` | `5` | 向上查找 `.git` / `.svn` 的层数（上限 5） |
| `changeReview.exclude` | `[]` | 手动排除（glob，相对项目根），对所有来源生效 |
| `changeReview.snapshotExclude` | `[node_modules, ...]` | 快照基准模式排除的文件 |
| `changeReview.snapshotMaxFileSize` | `1024` | 超过该大小（KB）的文件不保存内容做逐行 diff |
| `changeReview.snapshotMaxFiles` | `10000` | 快照基准最多纳入的文件数 |

## 自测

```bash
npm run selfcheck   # 临时 git 仓库：改动统计 / diff 解析 / 块级还原 / 接受 / 拒绝
npm run vcscheck    # 临时 svn 仓库 + 快照目录：多来源
npm run mockcheck   # mock vscode API：树视图 / 徽章 / 面板主流程（支持 --only 场景名）
```

## 已知限制

- 文件被改过导致块位置对不上时，块操作会明确报错提示刷新，不乱改。
- 删除状态的文件不支持按块操作；二进制文件只显示行数。
- SVN 只处理文本改动；属性改动只影响状态列。
- 依赖系统 `git` / `svn` 可执行文件；快照基准内容存于扩展 globalStorage（大项目配合 `snapshotExclude` 等设置使用）。
- WSL / 远程开发：插件为 workspace 类型，需装进 WSL；`/mnt/c` 下 git 报 `dubious ownership` 时点「信任该仓库」。
