# dsh-session-graph

Git-graph 风格的项目对话分叉追踪插件（DSH web profile bundle）。

同一项目（workspace）下：

- **branch = 会话**：每个分叉出的子会话是一条分支，分支名 = 会话标题；
- **commit = 一轮「用户请求 + 完成」**：由 DeepSeek 自动总结要点（也可手动「AI 摘要」，结果持久化到 `~/.dsh/storages/session_graph.json`）；
- **命名 / 内容 / 操作保持同步对应**：分支与提交都有名称、摘要内容与「跳转 / 分叉」操作。

## 功能

1. 选中任意会话后，在会话头部点击 **「Git 图谱」** 打开本项目图谱面板；
2. 图谱以 lane + 圆点 + 分叉虚线渲染：每列一条分支，圆点=提交，悬停圆点显示操作条；
3. 点击**分支节点**（顶部筹码）→ 打开该会话（与侧栏选择一致）；点击**提交圆点** → 跳转到所属会话并滚动定位到该轮（与在会话内滚动一致，基于官方 `data-chat-anchor-key` 锚点契约，失败时静默降级）；
4. 在任意提交上可 **「在此分叉」**（原生 `sessions.fork(atSeq)` 语义：边界为该轮 turn/end，child 包含该提交），成功即创建并打开新分支；
5. 新完成的轮次自动生成 AI 要点；历史提交可逐条「AI 摘要」；
6. 提交归属规则：子会话 `seedLength` 之前的提交归属父分支（共享提交在图谱中只出现一次），多级分叉正确折叠。

## 安装

```sh
dsh plugin --profile web add link:/absolute/path/to/dsh-session-graph
```

改动后重新打包：`node build.mjs`（生成 `dist/client.js`），刷新页面即可。

重启 `dsh web` 后生效（该插件是 profile bundle，随启动加载；动态版本仅存在于会话进程内）。

## 卸载

```sh
dsh plugin --profile web remove dsh-session-graph
```

## 结构

| 文件 | 说明 |
| --- | --- |
| `host/index.js` | Host 半区（纯 ESM）：图谱组装、AI 摘要、存储域持久化、`/sgx/*` 同源路由（loopback 围栏） |
| `client-src.js` | 浏览器半区源码（React，仅依赖 `react`） |
| `build.mjs` | 打包脚本 → `dist/client.js`（`window.__ModuleLoader__.load` 工厂） |
| `cordis.patch.yml` | profile bundle patch（`id: ui-session-graph`） |

## 数据契约

- `GET /sgx/graph?session=<id>` → `{ workspace, branches[], commits[], current }`
  - branch：`{ id, title, parentId, createdAt, updatedAt, commitCount, chain[], headKey }`
  - commit：`{ key: "<owner>:<turn>", sessionId(owner), turn, userSeq, endSeq, time, userText, human, title, summary, status: 'ai'|'fallback'|'pending' }`
- `POST /sgx/summarize { sessionId, turn }` → `{ ok, summary, fallback }`

## 已知边界

- 会话窗口只加载尾部消息时，旧提交的「滚动定位」会静默跳过（会话已正确打开）；
- 摘要调用使用当前默认模型（`agentDefaultModel`），失败自动回退为「完成：<回复首行>」；
- `/sgx/*` 仅允许 loopback 客户端访问（与 dsh-git-graph 同款围栏）。
