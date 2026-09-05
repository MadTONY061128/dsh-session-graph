# dsh-session-graph

Git-graph 风格的项目会话信息 DAG 插件（DSH web profile bundle）。

同一 workspace 下：

- **branch = 会话**：原生 fork 关系保持为树；
- **commit = 一轮「用户请求 + 完成」**；AI 摘要默认关闭，可按 workspace 启用或手动触发；
- **merge = 双亲 DAG 节点**：把来源 head 尚未到达受体 head 的完整可达集差萃取为 information-object；
- **revert = 单亲抵消节点**：保留 merge 祖先关系和审计，只停止对应信息对模型上下文生效。

## v0.6 核心语义

会话 fork 树和信息 DAG 是两个不同结构。设来源、受体有效 head 分别为 $h_A,h_B$，祖先闭包为
$Anc(h)$，则一次合入的权威增量是：

$$
\Delta_{A\to B}=Anc(h_A)\setminus Anc(h_B)
$$

新 merge 节点 $m$ 的父节点为 $\{h_B,h_A\}$，随后受体有效 head 变为 $m$。因此立即重复
merge 的增量为空；若 A 继续产生新提交，下一次只共享尚未通过任何直接或传递路径到达 B 的节点。
复杂交叉合并可能有多个 merge-base，所以单一 LCA 仅用于兼容显示，不参与权威增量判断。

Git revert 创建新节点而不删除 merge：历史可达性保持，动态注入通过 tombstone 失效。再次 merge
只包含来源分支在旧交汇点之后的新信息。

## 功能

1. 经 `dsh-better-sidebar` 注册常驻「Git 图谱」Tab；同一 workspace 可切换多棵会话树。
2. 圆点表示原生 commit，方块表示双亲 merge，菱形表示 Git revert，空心环表示空分支 tip。
3. commit 支持 checkout、原生 `sessions.fork(atSeq)` 分叉和手动 AI 摘要。
4. merge 使用 information-object 结构保存命题、依据、负约束、开放问题和明确排除项。
5. merge 成果通过 agent prompt section 动态注入；inject/uninject 幂等，不再追加不可删除的用户消息。
6. 每个分支同时暴露 `nativeHeadKey` 与 `effectiveHeadKey`；后者包含 merge/revert DAG 节点。
7. 图谱后台刷新默认 120 秒；页面隐藏时暂停，重新可见、切换会话和手动操作时立即刷新。
8. 所有持久化记录带 `workspaceKey`；读取、合入、注入、撤销和清理均执行 workspace 围栏校验。

## 隐私

- 自动摘要默认关闭，必须按 workspace 显式启用。
- 手动摘要和主动 merge 是显式模型调用；侧栏显示当前 `provider/model`。
- 插件仅持久化摘要、information-object、DAG 操作和设置，不额外复制原始对话。
- 模型不可用时使用本地确定性 fallback，不切换到其他 provider。
- 「清除数据」只清理当前 workspace 的插件元数据，不删除原始 DSH 会话。

旧版已注入聊天历史的 merge 消息无法从 append-only 日志删除。v0.6 会标记其来源；若对应 merge
被 revert，prompt section 会写入高优先级 tombstone，要求模型不得继续将其视为有效信息。

## 安装

需要 Node.js `^22.19.0 || >=24.0.0`，支持 DSH `>=0.1.1-rc.1 <0.2.0`。

```sh
dsh plugin --profile web add link:/absolute/path/to/dsh-session-graph
dsh web
```

改动客户端后重新打包：

```sh
npm run build
```

卸载：

```sh
dsh plugin --profile web remove dsh-session-graph
```

## 数据契约

- `GET /sgx/graph?session=<id>`
  - branch：`{ id, parentId, chain[], nativeHeadKey, effectiveHeadKey }`
  - merge：`{ key, workspaceKey, parentKeys[2], mergeBaseKeys[], deltaKeys[], injectionState, revertedBy, io }`
  - revert：`{ key, mergeId, targetB, parentKey, time }`
  - privacy：`{ autoSummary, provider, model }`
- `POST /sgx/summarize { sessionId, turn }`
- `POST /sgx/merge { sessionId, sourceA, targetB }`
- `POST /sgx/merge/inject { sessionId, mergeId }`
- `POST /sgx/merge/uninject { sessionId, mergeId }`
- `POST /sgx/merge/revert { sessionId, mergeId }`
- `GET /sgx/settings?session=<id>`
- `POST /sgx/settings { sessionId, autoSummary }`
- `POST /sgx/purge { sessionId, summaries, merges, settings }`

`session_graph_view`、`session_graph_read` 和 `session_graph_merge` 仅在项目会话 agent 中注册；
`session_graph_read` 支持 branch、commit、`mg:<id>` 和 `rv:<id>`，且不能跨 workspace 读取。

## 开发与验证

```sh
npm test
npm run check
git diff --exit-code -- dist/client.js
```

`host/dag-core.js` 是无副作用的离散 DAG 核心；测试覆盖重复 merge、传递 merge、Git revert、
workspace 隔离、动态注入、隐私默认值、120 秒刷新和客户端 DAG 行序。

## 文件结构

| 文件 | 作用 |
| --- | --- |
| `host/index.js` | DSH 服务接入、存储、路由、LLM 与 agent surface |
| `host/dag-core.js` | 信息 DAG、祖先闭包、可达集差、merge-base 和注入状态纯函数 |
| `client-src.js` | React 侧栏图谱与交互 |
| `build.mjs` | 生成 `dist/client.js` |
| `test/` | Node 内建测试运行器测试 |

## 已知边界

- checkout 目标不在当前会话窗口已加载的消息尾部时，只打开会话，不强制加载旧消息。
- information-object 仍是模型萃取而不是真实信息熵度量；失败时会明确标记 fallback。
- loopback 围栏防止远程请求，workspace 围栏负责同一 DSH 实例内的项目逻辑隔离。
