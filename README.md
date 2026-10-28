# dsh-workspace-session-drag

> DeepSeek Harness 插件：在侧栏把会话从一个工作区拖到另一个工作区，确认后真正移动
> （含子代理、列表边缘自动滚动、已打开的空闲会话也能即时生效）。
>
> Drag sessions between DSH workspaces from the sidebar; confirm to move the session
> log and workspace membership instantly.

把侧栏里的会话**从一个工作区拖到另一个工作区**，松开鼠标后弹出确认框：

> 是否将《会话名》从《工作区 A》移动到《工作区 B》？

确认后会话完成移动——**尽量即时生效**（刷新工作区归属，不用重启）。

## 功能

- 拖动会话到另一个工作区标题/分组上 → 分组高亮，松开弹确认框
- **未分组 ↔ 工作区 双向拖动**：
  - 把「未分组」里的会话拖进任意工作区 → 归入该工作区
  - 把工作区里的会话拖到「未分组」分组、或侧栏列表的空白处 → 移出工作区，变成未分组
    （移出只改归属，会话日志、`cwd`、内容都不动）
- **拖到侧栏列表的顶部/底部边缘时自动滚动**（越靠近边缘滚得越快）：
  列表很长时可以把会话拖到下面的工作区，拖回上方也一样；同工作区排序时也生效
- **已打开、空闲的会话也能移动**：只要它没有正在跑的任务（对话回复 / 子代理 / 后台任务 / 提醒），
  移动时会先 flush 事件、再切换写句柄目录，之后的事件继续写进新工作区，不会写到旧路径
- 确认后自动备份，然后：
  1. 改写会话日志 header 里的 `cwd`
  2. 把会话日志目录移动到目标工作区的 session-project 目录
  3. 同步标题缓存（新工作区里标题不会丢）
  4. 即时刷新工作区注册表（detach 旧 / attach 新；已打开会话走等价的记录改写）
- 子代理会话会跟着父会话一起移动
- 同一工作区里拖动会话，仍然是 DSH 自带的“排序”行为，不会弹框
- **正在跑任务的会话仍会拒绝**，并说明是哪种工作在进行

## 安装

要求：DeepSeek Harness Desktop（Windows / Web 均可）。安装时 DSH 必须**完全退出**（窗口 + 托盘图标）。

### 方式 A：一键安装（Windows，推荐）

1. 下载/克隆本仓库到任意目录（例如 `D:\dsh-plugins\<本仓库>`）
2. 完全退出 DeepSeek Harness
3. 双击本目录的 **`安装.cmd`**
4. 重新打开 DeepSeek Harness

### 方式 B：命令行 link 安装

```bat
dsh plugin --profile desktop add link:<插件目录>
```

如果 `dsh` 不在 PATH 里，可以用桌面端自带的：
`%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`

### 方式 C：手动安装

编辑 `%USERPROFILE%\.dsh\profiles\desktop\package.json`：

- `dependencies` 加：
  ```json
  "dsh-workspace-session-drag": "link:<插件目录>"
  ```
- `dsh.profile.bundles` 加 `"dsh-workspace-session-drag"`

然后建立目录联接（管理员 CMD）：

```bat
mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-workspace-session-drag" "<插件目录>"
```

## 使用

1. 在左侧侧栏，把鼠标放到某个会话上按住拖动
2. 拖到另一个工作区的标题或任意会话区域（目标分组会出现蓝色虚线框；
   拖到列表顶部/底部边缘会自动滚动）
3. 松开鼠标 → 弹确认框 → 点「移动」
4. 成功后会弹出提示；工作区列表会自动刷新（即时生效）

**未分组双向拖动：**

- 把「未分组」里的会话拖到某个工作区分组上 → 归入该工作区
- 把工作区里的会话拖到「未分组」分组、或侧栏列表的空白处 → 弹出「移出工作区」确认框，
  确认后会话回到未分组（只改归属，日志和 `cwd` 都不动）

如果宿主半侧的注册表刷新失败，文件会整体回滚并报错，不会留下半移动状态。

## 限制

- **正在跑任务的会话**不能移动（包括当前正在对话的会话）；等它空闲后再拖。
  只是打开/切换过、没有任务的会话可以正常移动。
- 空白会话在 DSH 里本来就不可拖动，插件也不会处理。
- 归档会话不可拖动。
- 拖回工作区时，如果会话 `cwd` 已经等于该工作区路径（例如之前就是从那里移出的），
  只恢复归属、不重复移动文件。
- 若 DSH 桌面端未来改成 `file://` + IPC 下发前端（没有 `webServer`），宿主路由不可用，插件会安全跳过（不报错、不影响启动）。

## 移动到底改了什么

| 位置 | 改动 |
| --- | --- |
| 会话日志 `session.vN.jsonl.zstd` | 只有第一帧 header 里的 `cwd` 改成目标工作区路径，事件数据不动 |
| `%USERPROFILE%\.dsh\sessions\--<cwd>--\<会话ID>\` | 整个目录移到目标工作区对应的目录 |
| 投影缓存 `session_projcache` | 记录里的生命周期 `identity.cwd` 同步更新（标题保留） |
| `workspace.json` | 旧工作区移除该会话，新工作区加入该会话 |

**移出工作区（拖到未分组）** 只改 `workspace.json`：会话日志、`cwd`、投影缓存都不动，
所以随时可以再拖回原工作区（`cwd` 未变，直接恢复归属）。

移动前会把会话日志、`workspace.json` 备份到
`%USERPROFILE%\.dsh\backups\session-drag-<时间>/`。

## 排错

- 打开浏览器开发者工具（桌面端：F12）Console，搜索 `dsh-workspace-session-drag` 或 `dsh-wsd`。
- 弹「无法连接宿主半侧」→ 插件宿主半侧没加载（检查 profile 的 `bundles` 是否包含本包，重启 DSH）。
- 移动失败并提示“已回滚”→ 查看 `.dsh\backups\session-drag-*`，以及 DSH 日志里的 `[dsh-workspace-session-drag]`。
- 卸载：完全退出 DSH 后双击 `卸载.cmd`。

## 结构

```
lib/
  index.js      宿主半侧：/dsh-workspace-drag/state、/dsh-workspace-drag/move 路由 + 注册表即时刷新
  move-core.js  文件级移动：备份 / zstd header 改写 / 目录移动 / 回滚
  client.js     浏览器半侧：拖拽监听、目标高亮、确认框、toast、边缘自动滚动
cordis.patch.yml  bundle patch（insert 行）
test/            冒烟测试（纯 Node，无额外依赖）
```

## 开发备注

- 宿主半侧利用 registry 的 `detachSession` / `attachSession` 做即时刷新；attach 前先更新
  registry 内部的 `headers` / `sessionPaths` 缓存，避免冷会话读到旧 header。
- 已打开（live）会话的刷新不能走 `attachSession`（它用 live session 冻结的旧 header 校验 cwd），
  改为成对改写旧/新工作区记录，并先把 jsonl 写句柄的 `header.cwd` 切到新目录。
- 客户端通过 `[data-row-key="workspace:<id>"]` / `[data-row-key="session:<id>"]` 识别拖拽源与目标分组；
  分组容器用 `[class*="groupSection"]` 匹配，兼容 CSS Module 的哈希前缀。
- 未分组组的标题行 `data-row-key` 是 `workspace:`（空 id）；把它作为“移出工作区”的目标。
  侧栏空白处（不在任何分组内）也视为移出目标。
- 未分组会话拖入工作区：直接加入目标记录；若其 `cwd` 已等于目标路径，只恢复归属、不动文件。
  移出工作区：只从旧工作区记录移除，不碰文件 / header / 写句柄。
- 同组拖拽不拦截，交给 DSH 自带的排序逻辑。

## 测试

```bat
node test/smoke-move-core.mjs
node test/smoke-auto-scroll.mjs
```

## 许可证

MIT，见 [LICENSE](./LICENSE)。
