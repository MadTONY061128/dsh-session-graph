# dsh-session-graph

Git-graph 风格的项目对话分叉追踪插件（DSH web profile bundle）。

同一项目（workspace）下：

- **branch = 会话**：每个分叉出的子会话是一条分支，分支名 = 会话标题；
- **commit = 一轮「用户请求 + 完成」**：由 DeepSeek 自动总结要点（也可手动「AI 摘要」，结果持久化到 `~/.dsh/storages/session_graph.json`）；
- **命名 / 内容 / 操作保持同步对应**：分支与提交都有名称、摘要内容与「checkout / 分叉」操作。

## 功能（v0.2）

1. **常驻右侧边栏 Tab**：经 `ctx.betterSidebar.registerTab` 注册「Git 图谱」页面，与现有
   dsh-better-sidebar 侧边栏**同一个面板**（天然兼容，不会出现两个右侧栏把对话区推两次）。
   卡片开启后常驻：切换节点不会重载界面；跨会话 checkout / 分叉时自动在目标会话预展开该 Tab；
   只有关闭侧边栏卡片或切换其它 Tab 才离开图谱界面。
2. **会话头部「Git 图谱」按钮** → 在右侧边栏打开该 Tab（`betterSidebar.openTab`）。
3. **树形图**：同一工作区一次只显示**一棵树**（顶部为树切换选项，不再罗列全部会话）；
   最新提交在顶部（各会话均向竖直向上更新）；**分叉与原分支共享分叉前最后一个提交点位**
   （肘形连接，无虚线、无 merge，参考 VSCode Git Branch）；空分支 = 可点击的空心 tip 环。
4. **交互**：**点击**节点才显示详情与 **checkout**（进入该节点对应的会话位置并滚动定位到该轮，
   基于官方 `data-chat-anchor-key` 锚点契约）；悬停无副作用；**仅滚轮**控制图谱上下滚动
   （`overflow:auto` + `overscroll-behavior:contain` + `touch-action:pan-y`）。
5. 在任意提交上可 **「在此分叉」**（原生 `sessions.fork(atSeq)` 语义：边界为该轮 turn/end，
   child 包含该提交），成功即创建并打开新分支；
6. 新完成的轮次自动生成 AI 要点；历史提交可逐条「AI 摘要」；
7. 提交归属规则：子会话 `seedLength` 之前的提交归属父分支（共享提交在图谱中只出现一次），
   多级分叉正确折叠。

## 安装

```sh
dsh plugin --profile web add link:/absolute/path/to/dsh-session-graph
```

改动后重新打包：

```sh
node build.mjs
```

> bundle 客户端每次页面刷新都会从磁盘重新读取（`no-cache`），改完 `build.mjs` 之后
> 刷新页面即可生效；Host 半区无改动时不需要重启 `dsh web`。

重启 `dsh web` 后生效（profile bundle 随启动加载）。

## 卸载

```sh
dsh plugin --profile web remove dsh-session-graph
```

## 结构

| 文件 | 说明 |
| --- | --- |
| `host/index.js` | Host 半区（纯 ESM）：图谱组装、AI 摘要、存储域持久化、`/sgx/*` 同源路由（loopback 围栏） |
| `client-src.js` | 浏览器半区源码（React，仅依赖 `react`）：betterSidebar Tab + 树形图谱 + checkout |
| `build.mjs` | 打包脚本 → `dist/client.js`（`window.__ModuleLoader__.load` 工厂） |
| `cordis.patch.yml` | profile bundle patch（`id: ui-session-graph`） |

## 数据契约

- `GET /sgx/graph?session=<id>` → `{ workspace, branches[], commits[], current }`
  - branch：`{ id, title, parentId, createdAt, updatedAt, commitCount, chain[], headKey }`
  - commit：`{ key: "<owner>:<turn>", sessionId(owner), turn, userSeq, endSeq, time, userText, human, title, summary, status: 'ai'|'fallback'|'pending' }`
- `POST /sgx/summarize { sessionId, turn }` → `{ ok, summary, fallback }`

## 已知边界

- 会话窗口只加载尾部消息时，旧提交的「checkout 滚动定位」会静默跳过（会话已正确打开）；
- 摘要调用使用当前默认模型（`agentDefaultModel`），失败自动回退为「完成：<回复首行>」；
- `/sgx/*` 仅允许 loopback 客户端访问（与 dsh-git-graph 同款围栏）；
- 侧边栏卡片的开合状态按会话持久化（better-sidebar 原生行为）；目标会话卡片被手动关闭时，
  跨会话 checkout 会预展开（`SidebarState.panelOpen` + `openTab(scope)`），此后随用户开关。
