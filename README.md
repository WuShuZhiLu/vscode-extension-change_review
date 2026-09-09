# Change Review

一个轻量的 VSCode 插件：把「本地相对基准的改动」列成清单，逐文件打钩标记 review 进度，点文件名进入 diff 审查模式，可以接受、拒绝、按块操作，也可以随时跳到真实文件里直接改。

**支持三种项目来源，自动探测：**

| 来源 | 对比基准 | 说明 |
| --- | --- | --- |
| **Git** | `HEAD`（上次提交） | 检出工作区里的 git 仓库（含多仓库工作区） |
| **SVN** | `BASE`（SVN 基础版本） | `.svn` 可能在打开的文件夹的上级、甚至上上级，会自动逐级向上探测 |
| **快照基准** | 手动建立的基准 | 既没有 git 也没有 svn 的项目：执行一次「初始化对比基准」，之后以它为基准显示改动；可随时「更新对比基准」 |

> 自动顺序：git → svn → 快照基准。可用 `changeReview.forceVcs` 强制指定。

## 功能

- **徽章**：Activity Bar 图标 + 视图角标（未审查文件数）+ 状态栏 `x/y 已审查`。
- **改动清单**：状态（`修改 / 新增 / 删除 / 重命名 / 未跟踪 / 冲突`）、每个文件的 `+新增行数 −删除行数`、所属来源类型。
- **打钩**：每个文件一个复选框，状态存到工作区（`workspaceState`）。文件被再次修改 → 打钩自动失效，需要重新审。
- **审查模式**：点文件名打开独立面板，统一视图 diff（跟随主题配色）。
  - 文件级：接受 / 拒绝 / 标记已审查 / 下一个待审查 / 刷新——主动词留按钮文字，具体语义（git 暂存 / 还原到 HEAD、SVN BASE 等）鼠标放上去即可看到。
  - **块级**：每个改动块悬停出现「接受此块 / 拒绝此块 / 跳转」。
- **接受 / 拒绝（只作用于文件内容层面，不碰 git 暂存区）**：
  - **接受**（全部 / 此块）= 仅把改动标记为已接受并给文件打钩：不改文件内容、也不 `git add`。git / svn / 快照基准行为一致。
  - **拒绝**（全部）= 把文件还原到对比基准：git `restore` 到 HEAD、svn `revert` 到 BASE、快照写回基准内容；未跟踪文件删除。「拒绝此块」用行级反向替换实现，只动这一块，其余内容与换行风格不受影响。
  - **git 暂存只在「标记为已审查」时发生**：勾选已审查 = `git add`（加入暂存区）；取消勾选 = `git reset`（撤出暂存区，工作区内容不动）。svn / 快照基准没有暂存区，勾选仅记录状态。
  - 一个文件的所有块都接受后自动给文件打钩（仅标记，不会自动 git add）。
- **自由编辑**：每个改动块悬停出的「跳转」打开的是**真实的工作区文件**并定位到改动行，可直接编辑保存；改动列表与审查面板会自动跟着刷新（右键菜单的「在编辑器中打开差异」则保留原生 diff 视图用于对照基准）。
- **多行选择 / 段级操作**：点行号选中单行，Ctrl/Cmd+点选多选、Shift 连选、双击行号选中整段（一块内的连续改动段）、Ctrl+A 全选；顶部浮出「复制 / 删除选中 / 还原此段」。「删除选中」批量删除当前文件里存在的行；「还原此段」把某一段改动单独还原到对比基准（例如上面一处修改没问题、两行后一处纯删除要单独拒绝——只还原删除段）；删除行的「复制」复制的是被删掉的原文，粘贴（含换行）会把多行插到当前行下方，用于手动恢复。Tab / Shift+Tab 缩进 / 反缩进（跟随 VSCode 的 `editor.tabSize` 与 `editor.insertSpaces`：设成 4 空格就插 4 个空格，不是制表符），Ctrl+S 立即保存当前行并刷新 diff。
- **标题栏**：改动列表标题栏只放两个图标按钮——「刷新」（`$(refresh)`）与「下一个待审查」（`$(arrow-down)`）；「全部标记为已审查 / 清除所有 / 配置排除规则… / 诊断」收在标题栏右侧「…」菜单里（带图标，不会把按钮挤成文字）。「初始化对比基准 / 更新对比基准」只在快照基准项目里出现（无基准显示初始化、有基准显示更新），git / svn 项目不会看到这两个按钮。
- **探测结果直接可见**：未识别到任何来源、或 git/svn 不可用时，改动列表顶部会出现 `⚠` 提示与解决建议，状态栏切到 `$(warning)`；真正失败只在面板顶部提示一次，不会反复弹窗。识别成功后状态栏 tooltip 会显示具体来源（Git / SVN / 快照基准）。
- **多来源工作区**：识别到多个 git 仓库 / svn 工作副本时按来源分组展示。
- **手动排除规则（`changeReview.exclude`）**：类似 vscode 的 `search.exclude`，glob 模式列表，**默认空**。对 git/svn/快照所有来源的所有改动都生效（覆盖 M/A/D/?），需要过滤什么就在这里自己加。**找不到在哪填？** 改动列表标题栏「…」菜单 →「配置排除规则…」、或右键文件/仓库 →「配置排除规则…」，会直接打开设置并定位到 `changeReview.exclude`；也可以手动打开设置搜 `changeReview.exclude`。
- **只看打开目录的改动**：仓库（或 `.svn`）根在打开的文件夹**之外**（例如 svn 工作副本根 `A/` 下并行着 `prj1`、`prj2`，VSCode 只打开 `A/prj1`）时，改动列表**只显示打开目录内的文件**，不会把同仓库的其它子项目、未版本化备份目录一起列出来。直接打开整个根目录则照常显示全部。
- **无版本控制项目**：打开后视图会提示「初始化对比基准」；基准内容存放在 VSCode 扩展存储目录（`globalStorage`），**不会写进项目目录**。`node_modules`、`dist`、`build`、`.git`、`.svn` 等默认排除（可配置）。
- **多语言（i18n）**：随 VSCode 显示语言自动切换，命令面板、设置描述、欢迎页、视图名称等所有可见文字都已本地化（`package.nls.json` 英文 / `package.nls.zh-cn.json` 简体中文）。

## 安装 / 运行

零依赖、无编译步骤（纯 JavaScript）。

- **打包安装（推荐）**：
  ```bash
  npm run package        # 生成 change-review-0.3.6.vsix
  npm run install-local  # 用 code CLI 装进本机 VSCode
  ```
  或者在 VSCode 里 `扩展` → 右上角 `...` → `从 VSIX 安装…`，选中 `change-review-0.3.6.vsix`。
  版本没变又想覆盖安装时用 `code --install-extension ./change-review-0.3.6.vsix --force`。
- **开发调试**：用 VSCode 打开本目录，按 `F5`（已配好 `.vscode/launch.json`）。
- **手动安装**：把整个目录复制到 `~/.vscode/extensions/change-review/` 后重启 VSCode。

## WSL / 远程开发（重要）

插件声明了 `"extensionKind": ["workspace"]`，**必须装进 WSL 里**才能在 WSL 窗口工作：

1. 打开 WSL 窗口 → 扩展面板 → 找到 `Change Review` → 点 **「在 WSL 中安装」**；
   或者 扩展面板右上角 `...` → **「从 VSIX 安装…」** → 选 `change-review-0.3.6.vsix`（务必在 WSL 窗口里操作）。
2. 完成后重载窗口。插件会自动识别自己是跑在 Linux/WSL 还是 Windows 上，并使用对应的 git / svn 候选路径。

如果仓库在 `/mnt/c/...`（Windows 目录挂进 WSL），git 常会报 `detected dubious ownership` 并拒绝一切操作 —— 插件会弹提示，点 **「信任该仓库」** 即可（等价于 `git config --global --add safe.directory <路径>`）。

如果 WSL 里的 `git` 实际是 Windows 版（返回 `C:/...` 这种路径），插件会自动换候选；换不掉就在设置里把 `changeReview.gitPath` 显式填 `/usr/bin/git`。SVN 同理用 `changeReview.svnPath`。

## 故障排查

先跑 **「诊断环境（Git / SVN / 平台 / 仓库）」**（命令面板），它会把平台、扩展宿主位置（本地/WSL）、git/svn 可执行文件与版本、识别到的每个来源（类型 / 基准 / 文件数 / 基准快照是否已建立）打到 Output 面板（`Change Review` 通道），把这段贴出来基本就能定位。

常见情况：

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 面板按钮点了没反应、Output 也没日志 | 0.2.0 之前 `enableScripts` 未开启，webview 脚本被禁 | 升级到 0.2.0+；打开面板后 Output 的 `Change Review` 通道应出现 `收到消息 type=ready` |
| 项目明明有 git / svn，却走了“快照基准”或列表为空 | 探测没找到仓库 / 工具不可用 | 跑诊断，看「识别到的来源」与可执行文件两节；必要时用 `changeReview.forceVcs` 指定 |
| 打开子目录却列出了同仓库其它目录的改动 | 0.3.0 及以前没有“范围限制”，svn 会从工作副本根全量列 | 升级到 0.3.1+；改动列表只包含打开的目录内 |
| 打开的子目录其实在 svn 工作副本里，但没识别出来 | `.svn` 在上级目录，且超过 5 层探测上限 | `.svn` 超过 5 层是刻意不认的（避免误认无关的上级仓库）；直接打开离 `.svn` 更近的目录，或用 `changeReview.forceVcs: svn` + 打开仓库根 |
| 报 `dubious ownership` | 目录所有者与当前用户不一致（`/mnt/c` 常见） | 点提示里的「信任该仓库」 |
| 点了命令没反应 | 取不到目标文件 | 0.1.1 起会优先用当前打开的文件，并给出提示 |
| WSL 里路径是 `C:/...` | 用成了 Windows 版 git | 设置 `changeReview.gitPath` 为 `/usr/bin/git` |

## 命令

| 命令 | 说明 |
| --- | --- |
| `刷新改动列表` | 立即刷新（标题栏图标、命令面板都有） |
| `聚焦改动列表` | 跳到 Change Review 视图 |
| `进入审查模式` | 打开该文件的 diff 审查面板 |
| `在编辑器中打开差异` | 原生 diff 编辑器（基准 ↔ 工作区），用于对照 |
| `在编辑器中打开并修改` | 面板里的按钮：直接打开真实文件、可编辑，保存后自动刷新 |
| `接受改动` | 仅标记为已审查（不改内容、不 git add）；git 暂存见「标记为已审查」 |
| `拒绝改动（还原）` | git：还原到上次提交；svn：还原到 BASE；快照基准：还原到基准快照 |
| `标记为已审查` / `取消已审查标记` | 手动打钩；git 下勾选 = `git add`、取消 = `git reset` |
| `全部标记为已审查` / `清除所有审查标记` | 批量 |
| `下一个待审查` | 跳到下一个未审查文件（标题栏图标） |
| `初始化对比基准` | 无 git / svn 的项目：把当前文件状态记录为基准 |
| `更新对比基准` | 快照基准项目：把当前（或所选文件）状态设为新基准 |
| `配置排除规则…` | 打开设置并定位到 `changeReview.exclude` |
| `在资源管理器中显示` | 在资源管理器里定位该文件 |
| `诊断环境（Git / SVN / 平台 / 仓库）` | 环境信息打到 Output 面板 |

## 快捷键（Change Review 视图聚焦时）

| 键位 | 说明 |
| --- | --- |
| `Ctrl+Enter` | 进入审查面板（打开选中文件） |
| `Ctrl+Shift+A` | 接受改动 |
| `Ctrl+Shift+R` | 拒绝改动 |
| `Ctrl+Shift+M` | 标记 / 取消已审查（同一键位，按状态切换） |
| `Alt+N` | 下一个待审查文件 |

> macOS 上 `Ctrl` 对应 `Cmd`。键位都限定在 Change Review 视图聚焦时生效，不会和 VSCode 内置快捷键冲突，也不会被其他扩展抢占。

## 设置

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| `changeReview.includeUntracked` | `true` | 是否列出未跟踪的新文件 |
| `changeReview.sortReviewedLast` | `true` | 已审查文件排到最后 |
| `changeReview.autoRefreshInterval` | `5` | 自动刷新间隔（秒），`0` 关闭 |
| `changeReview.contextLines` | `3` | diff 上下文行数 |
| `changeReview.showStatusBar` | `true` | 显示状态栏徽章 |
| `changeReview.gitPath` | 空 | git 完整路径；留空自动探测 |
| `changeReview.svnPath` | 空 | svn 完整路径；留空自动探测（Windows：PATH → TortoiseSVN → SlikSvn → VisualSVN；Linux/macOS：PATH → `/usr/bin/svn` 等） |
| `changeReview.forceVcs` | `auto` | 强制来源：`auto` / `git` / `svn` / `snapshot` |
| `changeReview.vcsSearchDepth` | `5` | 向上查找 `.git` / `.svn` 的目录层数（上限 5，再高不认） |
| `changeReview.exclude` | `[]` | 全局手动排除（glob，相对仓库/项目根），对 git/svn/快照所有改动生效；类似 vscode 的 `search.exclude`，由你按需添加（默认空）。点「配置排除规则…」命令直达该设置 |
| `changeReview.snapshotExclude` | `[node_modules, dist, build, ...]` | 快照基准模式排除的文件（glob） |
| `changeReview.snapshotMaxFileSize` | `1024` | 超过该大小（KB）的文件只检测变化、不保存内容做逐行 diff |
| `changeReview.snapshotMaxFiles` | `10000` | 快照基准最多纳入的文件数 |

## 自测

```bash
npm run selfcheck   # 在真实临时 git 仓库里验证改动统计/diff解析/块级还原/接受/拒绝
npm run vcscheck    # 在真实临时 svn 仓库（svnadmin+file://）+ 快照目录里验证多来源
npm run mockcheck   # 用 mock 的 vscode API 跑一遍树视图/徽章/复选框/面板主流程
npm run preview     # 生成 preview/review-panel.html 静态预览
```

## 已知限制

- 文件在编辑器里被改过、导致块位置对不上时，「拒绝此块」会明确报错而不是乱改。
- 删除状态的文件不支持按块操作（工作区里文件已不存在）。
- SVN 下只处理工作副本相对 BASE 的文本改动；属性（svn:ignore 等）改动只影响状态列，不参与文本 diff。
- 二进制文件只显示行数，不显示文本差异。
- 依赖系统 `git` / `svn` 可执行文件（未使用 VSCode 内置 SCM 扩展的 API）。
- 快照基准保存的是文件内容副本，存在 VSCode 的 globalStorage 目录（不在项目内）；项目很大时请配合 `snapshotExclude` / `snapshotMaxFileSize` / `snapshotMaxFiles` 使用。
