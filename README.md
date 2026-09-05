# dsh-session-graph

Git-graph 风格的项目对话分叉追踪插件（DSH web profile bundle）。

同一项目（workspace）下：

- **branch = 会话**：每个分叉出的子会话是一条分支，分支名 = 会话标题；
- **commit = 一轮「用户请求 + 完成」**：由 DeepSeek 自动总结要点（也可手动「AI 摘要」，结果持久化到 `~/.dsh/storages/session_graph.json`）；
- **命名 / 内容 / 操作保持同步对应**：分支与提交都有名称、摘要内容与「checkout / 分叉 / 合入」操作。
- **merge = $B \otimes A$**：把供体分支 A 相对最近公共祖先（LCA）的增量，经 **information-object 萃取**
  （命题 + 依据分类 + 负命题边界 + 开放问题）合流进受体分支 B；不改写 B 日志、不改 B 身份，可回滚、可注入。

## 功能（v0.3）

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

## 分支合入（merge，v0.4）

- **发起**：选中某分支（提交 / 空分支 tip），详情面板出现「合并此分支到当前分支」
  （A=所选分支，B=当前会话所在分支）。
- **语义**：非对称 $B \otimes A$；仅当 A、B 同树且 A 非 B 的祖先时可合并
  （否则返回 `already-contained` / `unrelated` / `self`）；$A_{\text{diff}}$ = A 链上
  LCA 之后的提交。
- **萃取**：LLM 按 information-object 规范把 $A_{\text{diff}}$ 投影为
  `{ purpose, propositions[{claim, ground:{kind, evidence}}], negativeConstraints[], openQuestions[], deliberateExclusions[] }`
  —— `ground.kind ∈ observed|inferred|assumed|produced`，去除元叙事/重复，保留负命题与开放边界；
  主干优先（B 状态不被篡改，冲突标为 `negativeConstraints`）。
- **图表示**：合入 = B 链头之上的**方形节点**（双亲：B 上一链头 + A 链头 S 曲线接入）；
  可点击查看 IO 详情。
- **注入 / 回滚**：merge 节点详情可「注入到受体上下文」（把 IO 以 `user/message`
  context 事件写入 live 的 B，供 B 的 agent 读取）与「撤销合入」（置 `reverted`，图谱回到原链头，
  保留审计）。无有效增量（$\Delta I \le 0$）时拒绝合并。

### v0.3 修复

- **checkout 可靠性**：`jump` 目标改为响应式 store（版本订阅），同分支 checkout 不再出现
  「随机没反应」——每次点击都会触发滚动 watcher 重评估；
- **侧边栏常驻**：跨会话跳转/分叉改用 content-seed `openTab`（面板自动展开）+ 目标状态
  `panelOpen` 预置，连续切换分支不会收起侧边栏；
- **格子化行序**：每行 = 一个元素；子分支自己的提交严格置于其分叉点之上（时间异常也不
  会落到分叉点之下），空分支 tip 独占一格——文字标识不再重叠、不再有孤立圆点；
- **顶部留白**：最上方 tip 不再被卡片上缘裁剪。

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

- `GET /sgx/graph?session=<id>` → `{ workspace, branches[], commits[], merges[], current }`
  - branch：`{ id, title, parentId, createdAt, updatedAt, commitCount, chain[], headKey }`
  - commit：`{ key: "<owner>:<turn>", sessionId(owner), turn, userSeq, endSeq, time, userText, human, title, summary, status: 'ai'|'fallback'|'pending' }`
  - merge：`{ id, key:"mg:<id>", sourceA, targetB, lcaKey, sourceHeadKey, headBeforeB, time, status, injected, title, summary, io }`
- `POST /sgx/summarize { sessionId, turn }` → `{ ok, summary, fallback }`
- `POST /sgx/merge { sourceA, targetB }` → `{ ok, merge } | { ok:false, code: 'self'|'already-contained'|'unrelated'|'no-effective-increment'|'llm-failed'|'not-found' }`
- `POST /sgx/merge/revert { mergeId }` → `{ ok } | { ok:false, code }`
- `POST /sgx/merge/inject { mergeId }` → `{ ok } | { ok:false, code:'reverted'|'target-not-live'|'append-failed' }`

## 已知边界

- 会话窗口只加载尾部消息时，旧提交的「checkout 滚动定位」会静默跳过（会话已正确打开）；
- 摘要/萃取调用使用当前默认模型（`agentDefaultModel`），失败回退（摘要→首行；萃取→逐提交要点，ground=inferred）；
- `/sgx/*` 仅允许 loopback 客户端访问（与 dsh-git-graph 同款围栏）；
- **注入仅对 live 的受体会话生效**（`target-not-live` 时提示先打开该分支）；merge 本身在图层已落库，注入是可选动作；
- 冲突自动消解对 B 全量命题、离线 B 注入、真实信息熵 $\Delta I$ 度量 为 v2 项。
