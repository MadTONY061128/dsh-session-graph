import { activeInjectedMergeIds, assertDagInvariants, buildInformationDag } from './dag-core.js'

/**
 * dsh-session-graph — Host half (pure ESM, zero runtime imports).
 *
 * 以 Git 图谱风格展示同一项目（workspace）下的会话分叉记录与进展：
 *   - branch = 会话（fork 关系由 SessionHeader.parentSession / seedLength 决定）
 *   - commit = 一轮「用户请求 + 完成」（turn），要点摘要由 LLM 生成并持久化
 *   - merge  = B ⊗ A：把供体分支 A 相对最近公共祖先的增量，经 information-object
 *     萃取后合流进受体分支 B（图拓扑 + 可选注入 B 上下文），可回滚，不改写日志
 *
 * 数据服务路径（本插件自行注册，供浏览器半区 fetch）：
 *   GET  /sgx/graph?session=<id>     -> 项目图谱 JSON
 *   POST /sgx/summarize              -> { sessionId, turn } -> 生成/重试 AI 要点
 *   POST /sgx/merge                  -> { sessionId, sourceA, targetB } -> 合入
 *   POST /sgx/merge/revert           -> { sessionId, mergeId } -> Git revert
 *   POST /sgx/merge/inject           -> { sessionId, mergeId } -> 动态注入
 *   POST /sgx/merge/uninject         -> { sessionId, mergeId } -> 停止动态注入
 *   GET  /sgx/settings?session=<id>  -> workspace 隐私设置
 *   POST /sgx/settings               -> { sessionId, autoSummary }
 *   POST /sgx/purge                  -> 清理 workspace 插件元数据
 *
 * 持久化：storage-domain "session_graph"（~/.dsh/storages/session_graph.json），
 * 三张表：commits（要点摘要）、merges（DAG 操作）、settings（workspace 设置）。
 * 只允许 loopback 客户端访问，且所有记录访问再次按 workspace 围栏校验。
 */

export const inject = [
  'sessionQuery',
  'workspaceRegistry',
  'storageDomain',
  'llm',
  'agentDefaultModel',
  'webServer',
]

export function apply(ctx) {
  const Q = ctx.sessionQuery
  const W = ctx.workspaceRegistry
  const D = ctx.storageDomain
  const LLM = ctx.llm
  const AM = ctx.agentDefaultModel
  const DUCK = Object.freeze({ safeParse: () => ({ success: true }), parse: (v) => v })
  let domain = null
  let table = null
  let mergeTable = null
  let settingsTable = null
  const summaries = new Map()
  const merges = new Map()
  const settings = new Map()
  const projectCache = new Map()
  const domainReady = (async () => {
    domain = await D.open({ name: 'session_graph', version: 0, tables: { commits: { valueSchema: DUCK }, merges: { valueSchema: DUCK }, settings: { valueSchema: DUCK } } })
    table = domain.table('commits')
    mergeTable = domain.table('merges')
    settingsTable = domain.table('settings')
    for (const [k, v] of table.entries()) summaries.set(k, v)
    for (const [k, v] of mergeTable.entries()) merges.set(k, v)
    for (const [k, v] of settingsTable.entries()) settings.set(k, v)
  })().catch((e) => { console.error('[git-graph] storage unavailable', e) })
  ctx.effect(() => {
    return () => {
      const d = domain
      domain = null
      table = null
      mergeTable = null
      settingsTable = null
      if (d) d.close().catch(() => {})
    }
  })

  // ---------- helpers ----------
  function textOf(blocks, max) {
    let out = ''
    const list = Array.isArray(blocks) ? blocks : []
    for (const b of list) {
      if (b && b.type === 'text' && typeof b.text === 'string' && b.text.length > 0) {
        out = out ? out + '\n' + b.text : b.text
        if (out.length >= max) break
      }
    }
    return out.length > max ? out.slice(0, max) : out
  }
  function firstLine(s, n) {
    const line = String(s || '').split('\n')[0].trim()
    return line.length > n ? line.slice(0, n) + '…' : line
  }
  function fallbackSummary(c) {
    const done = firstLine(c.ass, 60)
    return done ? ('完成：' + done) : '已完成本轮（无文本回复）'
  }
  function rid() {
    return 'sg-' + Math.random().toString(36).slice(2, 12)
  }
  function normalizePath(value) {
    return String(value || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()
  }
  function workspaceKeyOf(p) {
    if (p && p.ws && p.ws.id) return 'ws:' + p.ws.id
    return 'cwd:' + normalizePath(p && p.cwd)
  }
  function currentModel() {
    const sel = AM.currentSelection()
    return sel && sel.provider && sel.model ? { provider: sel.provider, model: sel.model } : { provider: '', model: '' }
  }
  async function deleteStored(t, key) {
    if (!t) return
    if (typeof t.delete === 'function') return await t.delete(key)
    if (typeof t.remove === 'function') return await t.remove(key)
    throw new Error('storage-delete-unsupported')
  }

  function extractCommits(events) {
    const commits = []
    let cur = null
    for (const ev of events) {
      if (ev.type === 'turn/start') { cur = { turn: ev.data.turn, userSeq: 0, userTime: 0, firstUser: '', human: false, ass: '' }; continue }
      if (!cur) continue
      if (ev.type === 'user/message') {
        const src = (ev.data && ev.data.source) || {}
        const human = src.kind === 'user'
        if (human && !cur.human) {
          cur.human = true
          cur.userSeq = ev.seq
          cur.userTime = ev.time
          cur.firstUser = textOf(ev.data.content, 300)
        } else if (!cur.userSeq) {
          cur.userSeq = ev.seq
          cur.userTime = ev.time
          cur.firstUser = textOf(ev.data.content, 300)
        }
      } else if (ev.type === 'assistant/message') {
        const t = textOf(ev.data.message && ev.data.message.content, 1400)
        if (t) cur.ass = cur.ass ? cur.ass + '\n' + t.slice(0, 900) : t.slice(0, 900)
      } else if (ev.type === 'turn/end') {
        if (cur.userSeq) {
          commits.push({
            turn: cur.turn,
            userSeq: cur.userSeq,
            userTime: cur.userTime,
            endSeq: ev.seq,
            time: ev.time,
            firstUser: cur.firstUser.slice(0, 300),
            ass: cur.ass.slice(0, 4000),
            human: cur.human,
          })
        }
        cur = null
      }
    }
    return commits
  }

  // ---------- commit summaries (existing) ----------
  const queue = []
  let pumping = false
  function enqueueSummary(sessionId, turn) {
    queue.push({ sessionId, turn })
    pump()
  }
  function pump() {
    if (pumping) return
    const job = queue.shift()
    if (!job) return
    pumping = true
    generateSummary(job).catch(() => {}).finally(() => { pumping = false; pump() })
  }
  async function generateSummary(job) {
    const key = job.sessionId + ':' + job.turn
    if (summaries.has(key)) return
    try {
      const snap = await Q.readSession(job.sessionId)
      const c = extractCommits(snap.events).find((x) => x.turn === job.turn)
      if (!c) return
      const p = await loadProject(job.sessionId)
      if (p.error) return
      const st = await callLlm(c)
      const value = st
        ? { schemaVersion: 2, workspaceKey: workspaceKeyOf(p), sessionId: job.sessionId, turn: job.turn, summary: st.text, provider: st.provider, model: st.model, generatedAt: Date.now() }
        : { schemaVersion: 2, workspaceKey: workspaceKeyOf(p), sessionId: job.sessionId, turn: job.turn, summary: fallbackSummary(c), provider: '', model: '', generatedAt: Date.now(), fallback: true }
      summaries.set(key, value)
      if (table) { try { await table.put(key, value) } catch (e) { console.error('[git-graph] persist summary failed', e) } }
    } catch (e) { console.error('[git-graph] summary job failed', e) }
  }
  async function callLlm(c) {
    try {
      const sel = currentModel()
      if (!sel.provider || !sel.model) return null
      const prompt = c.firstUser.slice(0, 1200) || '（无用户文本）'
      const reply = c.ass.slice(0, 2000) || '（无回复文本）'
      const messages = [
        { id: rid(), role: 'user', content: [{ type: 'text', text: prompt }], source: { kind: 'user' } },
        { id: rid(), role: 'assistant', content: [{ type: 'text', text: reply }], source: { kind: 'model', provider: sel.provider, model: sel.model } },
        { id: rid(), role: 'user', content: [{ type: 'text', text: '请用3-5条要点总结上面这轮对话（用户请求 + 你的完成）。每条以"- "开头，总共不超过120字，直接输出要点列表，不要其他内容。' }], source: { kind: 'user' } },
      ]
      let out = ''
      for await (const chunk of LLM.stream({ provider: sel.provider, model: sel.model, messages, maxTokens: 260 })) {
        if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
        if (chunk && chunk.type === 'finish') break
      }
      const trimmed = out.trim()
      return trimmed.length > 0 ? { text: trimmed.slice(0, 600), provider: sel.provider, model: sel.model } : null
    } catch (e) { console.error('[git-graph] llm summary failed', e); return null }
  }

  // live tracking: auto-summary as turns complete
  const live = new Map()
  ctx.on('session/event', (session, event) => {
    const id = session && session.id
    if (!id) return
    invalidateProject(id)
    if (event.type === 'turn/start') { live.set(id, { turn: event.data.turn, userSeq: 0, firstUser: '', human: false, ass: '' }); return }
    const cur = live.get(id)
    if (!cur) return
    if (event.type === 'user/message') {
      const src = (event.data && event.data.source) || {}
      const human = src.kind === 'user'
      if (human && !cur.human) { cur.human = true; cur.userSeq = event.seq; cur.firstUser = textOf(event.data.content, 300) }
      else if (!cur.userSeq) { cur.userSeq = event.seq; cur.firstUser = textOf(event.data.content, 300) }
    } else if (event.type === 'assistant/message') {
      const t = textOf(event.data.message && event.data.message.content, 1400)
      if (t) cur.ass = cur.ass ? cur.ass + '\n' + t.slice(0, 900) : t.slice(0, 900)
    } else if (event.type === 'turn/end') {
      if (cur.userSeq) {
        shouldAutoSummary(id).then((enabled) => { if (enabled) enqueueSummary(id, cur.turn) }).catch(() => {})
      }
      live.delete(id)
    }
  })

  async function shouldAutoSummary(sessionId) {
    const p = await loadProject(sessionId)
    if (p.error) return false
    const cfg = settings.get(workspaceKeyOf(p))
    return !!(cfg && cfg.autoSummary)
  }

  // ---------- information-object extraction (merge) ----------
  const IO_SYSTEM = '你是一个信息对象萃取器（information-object）。把下面的会话提交（每条 = 用户请求 + 完成要点）相对合并目标 B 萃取为一个严格 JSON 对象。规则：' +
    '1) purpose：用一句中文说明这些增量对 B 的作用；' +
    '2) propositions：只保留有独立作用、与 B 目标相关的结论命题，去除元叙事/过渡句/重复内容，每条形如 {claim, ground:{kind, evidence}}，evidence 必须引用输入中的提交编号（如"【2】"）；' +
    '3) negativeConstraints：A 踩坑确立的负命题（某方案不可行/黑名单试错），每条带 ground；' +
    '4) openQuestions：未验证但对 B 重要、需保持开放边界的假设（字符串数组）；' +
    '5) deliberateExclusions：明确剔除的跑偏/无关内容（字符串数组）。' +
    'ground.kind 取值：observed=工具实测数据、inferred=模型推理、assumed=假设、produced=生成的产物/代码。只输出 JSON 对象，不要任何解释文字。'

  async function llmText(messages, maxTokens, system) {
    try {
      const sel = currentModel()
      if (!sel.provider || !sel.model) return null
      const opts = { provider: sel.provider, model: sel.model, messages, maxTokens }
      if (system) opts.system = system
      let out = ''
      for await (const chunk of LLM.stream(opts)) {
        if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
        if (chunk && chunk.type === 'finish') break
      }
      const text = out.trim()
      return text ? { text, provider: sel.provider, model: sel.model } : null
    } catch (e) { console.error('[git-graph] llm call failed', e); return null }
  }

  function parseJsonLenient(text) {
    const t = String(text || '').trim()
    const strip = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    try { return JSON.parse(strip) } catch (e) {
      const start = strip.indexOf('{')
      const end = strip.lastIndexOf('}')
      if (start >= 0 && end > start) { try { return JSON.parse(strip.slice(start, end + 1)) } catch (e2) { /* ignore */ } }
      return null
    }
  }

  function normProp(p) {
    if (typeof p === 'string') return { claim: String(p).slice(0, 300), ground: { kind: 'inferred', evidence: '' } }
    const claim = String((p && p.claim) || '').slice(0, 300)
    const g = (p && p.ground) || {}
    const kind = ['observed', 'inferred', 'assumed', 'produced'].includes(g.kind) ? g.kind : 'inferred'
    return { claim, ground: { kind, evidence: String(g.evidence || '').slice(0, 200) } }
  }

  async function extractIo(diffCommits, bTitle) {
    const lines = diffCommits.map((c, i) => ('【' + (i + 1) + '】请求：' + (c.userText || '') + '\n要点：' + (c.summary || '（无）'))).join('\n\n')
    const user = '合并目标 B：' + (bTitle || '') + '\n\n' + lines
    const messages = [{ id: rid(), role: 'user', content: [{ type: 'text', text: user }], source: { kind: 'user' } }]
    const generated = await llmText(messages, 900, IO_SYSTEM)
    if (generated) {
      const json = parseJsonLenient(generated.text)
      if (json && typeof json === 'object') {
        return {
          purpose: String(json.purpose || '').slice(0, 200),
          propositions: (Array.isArray(json.propositions) ? json.propositions : []).slice(0, 30).map(normProp),
          negativeConstraints: (Array.isArray(json.negativeConstraints) ? json.negativeConstraints : []).slice(0, 30).map(normProp),
          openQuestions: (Array.isArray(json.openQuestions) ? json.openQuestions : []).map(String).slice(0, 20),
          deliberateExclusions: (Array.isArray(json.deliberateExclusions) ? json.deliberateExclusions : []).map(String).slice(0, 20),
          generatedBy: { provider: generated.provider, model: generated.model, at: Date.now() },
        }
      }
    }
    // safe fallback: list each commit summary as an inferred proposition
    return {
      purpose: '将「' + diffCommits.length + ' 个提交」的增量并入',
      propositions: diffCommits.map((c) => ({ claim: c.summary || c.userText || ('#' + c.turn), ground: { kind: 'inferred', evidence: c.key } })),
      negativeConstraints: [],
      openQuestions: [],
      deliberateExclusions: [],
      fallback: true,
    }
  }

  function renderIoText(m) {
    const io = m.io || {}
    const parts = []
    if (io.purpose) parts.push('目的：' + io.purpose)
    for (const p of (io.propositions || [])) parts.push('- [' + ((p.ground && p.ground.kind) || 'inferred') + '] ' + p.claim)
    for (const n of (io.negativeConstraints || [])) parts.push('- 不可行：' + n.claim)
    for (const q of (io.openQuestions || [])) parts.push('- 待验证：' + q)
    for (const d of (io.deliberateExclusions || [])) parts.push('- 剔除：' + d)
    return parts.join('\n')
  }

  function serializeMerge(m, branchById) {
    const A = branchById.get(m.sourceA)
    const B = branchById.get(m.targetB)
    return {
      id: m.id,
      key: m.key || ('mg:' + m.id),
      schemaVersion: 2,
      workspaceKey: m.workspaceKey,
      sourceA: m.sourceA,
      targetB: m.targetB,
      lcaKey: m.lcaKey,
      mergeBaseKeys: m.mergeBaseKeys || (m.lcaKey ? [m.lcaKey] : []),
      sourceHeadKey: m.sourceHeadKey,
      targetParentKey: m.targetParentKey || m.headBeforeB,
      parentKeys: m.parentKeys || [m.targetParentKey || m.headBeforeB, m.sourceHeadKey].filter(Boolean),
      headBeforeB: m.targetParentKey || m.headBeforeB,
      time: m.createdAt,
      status: m.status,
      injected: m.injectionState === 'active',
      injectionState: m.injectionState || (m.injected ? 'active' : 'inactive'),
      legacyInjectedMessage: !!m.legacyInjectedMessage,
      revertedBy: m.revert ? m.revert.key : null,
      revert: m.revert ? { id: m.revert.id, key: m.revert.key || ('rv:' + m.revert.id), parentKey: m.revert.parentKey, time: m.revert.createdAt, legacy: !!m.revert.legacy } : null,
      sourceTitle: A ? A.title : '',
      targetTitle: B ? B.title : '',
      title: m.io && m.io.purpose ? firstLine(m.io.purpose, 40) : '合并',
      summary: renderIoText(m),
      io: m.io,
      diffKeys: m.diffKeys || m.deltaKeys || [],
      deltaKeys: m.deltaKeys || m.diffKeys || [],
      diffTurns: m.diffTurns || [],
    }
  }

  // ---------- compact merge entry (injection v2: traceable branch entry) ----------
  function turnLabelOf(key) {
    const idx = String(key || '').split(':')[1]
    return idx || String(key || '').slice(0, 8)
  }
  function evTurnOf(p, i, diffTurns) {
    const ev = p.ground && p.ground.evidence ? String(p.ground.evidence) : ''
    const m = ev.match(/(\d+)/)
    const n = m ? parseInt(m[1], 10) : 0
    if (n >= 1 && n <= (diffTurns || []).length) return '#' + diffTurns[n - 1]
    return (diffTurns || [])[i] !== undefined ? '#' + diffTurns[i] : ev
  }
  function renderMergeEntry(m) {
    const io = m.io || {}
    const diffTurns = m.diffTurns || []
    const n = diffTurns.length
    const mergeBases = m.mergeBaseKeys || (m.lcaKey ? [m.lcaKey] : [])
    const parts = []
    parts.push('【分支合入】「' + (m.sourceTitle || '') + '」已合入本分支「' + (m.targetTitle || '') + '」——这不是任务指令，而是被合入分支的入口：')
    parts.push('最近公共祖先集：' + (mergeBases.length ? mergeBases.map((key) => '#' + turnLabelOf(key)).join('、') : '无') + '；并入 ' + n + ' 个差分提交：' + (n ? diffTurns.map((t) => '#' + t).join('、') : '（空）') + '。')
    if (io.purpose) parts.push('目的：' + io.purpose)
    const tops = (io.propositions || []).slice(0, 5).map((p, i) => '- [' + ((p.ground && p.ground.kind) || 'inferred') + '] ' + p.claim + '（来源 ' + evTurnOf(p, i, diffTurns) + '）')
    if (tops.length) parts.push('要点：' + tops.join(' '))
    if ((io.negativeConstraints || []).length) parts.push('不可行（前车之鉴）：' + io.negativeConstraints.slice(0, 3).map((x) => x.claim).join('；'))
    if ((io.openQuestions || []).length) parts.push('待验证：' + io.openQuestions.slice(0, 3).join('；'))
    parts.push('完整命题、依据与提交原文：session_graph_read "mg:' + m.id + '"；右侧「Git 图谱」侧栏可 checkout 至任意提交溯源。')
    return parts.join('\n')
  }

  // ---------- per-session structural frame (prompt section, agent-scoped) ----------
  const frameCache = new Map()
  function updateFrames(p) {
    const byBranch = new Map()
    for (const b of p.branches) byBranch.set(b.id, b)
    const rootOf = (id) => {
      let c = byBranch.get(id)
      let hops = 0
      while (c && c.parentId && byBranch.get(c.parentId) && hops < 64) { c = byBranch.get(c.parentId); hops++ }
      return c ? c.id : id
    }
    const roots = new Map()
    for (const b of p.branches) roots.set(b.id, rootOf(b.id))
    const activeM = (p.projectMerges || []).filter((m) => m.status === 'active')
    for (const b of p.branches) {
      const root = roots.get(b.id)
      const siblings = p.branches.filter((x) => x.id !== b.id && roots.get(x.id) === root).map((x) => x.title)
      const mergesIn = activeM.filter((m) => m.targetB === b.id && byBranch.has(m.sourceA)).map((m) => byBranch.get(m.sourceA).title)
      const mergesOut = activeM.filter((m) => m.sourceA === b.id && byBranch.has(m.targetB)).map((m) => byBranch.get(m.targetB).title)
      const injectedIds = new Set(activeInjectedMergeIds(p.dag, b.effectiveHeadKey))
      const injectedEntries = (p.projectMerges || [])
        .filter((m) => injectedIds.has(m.id))
        .map((m) => renderMergeEntry(serializeMerge(m, p.branchById)))
      const legacyRevoked = (p.projectMerges || [])
        .filter((m) => m.targetB === b.id && m.status === 'reverted' && m.legacyInjectedMessage)
        .map((m) => m.id)
      const parent = b.parentId && byBranch.has(b.parentId) ? byBranch.get(b.parentId) : null
      let forkTitle = null
      if (b.commitCount > 0 && b.chain.length > b.commitCount) {
        const fc = p.commitByKey.get(b.chain[b.chain.length - b.commitCount - 1])
        if (fc) forkTitle = firstLine(fc.firstUser, 24) || ('#' + fc.turn)
      } else if (b.chain.length > 0 && parent) {
        const fc = p.commitByKey.get(b.chain[b.chain.length - 1])
        if (fc) forkTitle = firstLine(fc.firstUser, 24) || ('#' + fc.turn)
      }
      frameCache.set(b.id, {
        title: b.title,
        parentTitle: parent ? parent.title : null,
        forkTitle,
        siblingTitles: siblings,
        mergesIn,
        mergesOut,
        injectedEntries,
        legacyRevoked,
      })
    }
  }
  function frameFor(sessionId) {
    const f = frameCache.get(sessionId)
    if (!f) return ''
    const parts = []
    parts.push('【会话树】你处于「Git 图谱」会话树的分支『' + f.title + '』' + (f.parentTitle ? '（父分支『' + f.parentTitle + '』' + (f.forkTitle ? '，分叉于『' + f.forkTitle + '』' : '') + '）' : '（根分支）') + '。')
    if (f.siblingTitles.length) parts.push('同树其他分支：' + f.siblingTitles.join('、') + '。')
    if (f.mergesIn.length) parts.push('已合入本分支：' + f.mergesIn.join('、') + '。')
    if (f.mergesOut.length) parts.push('本分支已合入：' + f.mergesOut.join('、') + '。')
    parts.push('合入采用会话信息 DAG；可用 session_graph_view/read 溯源，右侧「Git 图谱」侧栏可视化同一结构。')
    if (f.legacyRevoked.length) parts.push('旧版聊天记录中 merge ' + f.legacyRevoked.join('、') + ' 已被 Git revert；其历史入口不得视为当前有效信息。')
    if (f.injectedEntries.length) {
      const cap = 4000
      let used = 0
      let omitted = 0
      for (const entry of f.injectedEntries) {
        if (used + entry.length > cap) { omitted++; continue }
        parts.push(entry)
        used += entry.length
      }
      if (omitted) parts.push('另有 ' + omitted + ' 个有效合入入口未常驻展开；用 session_graph_view/read 按需读取。')
    }
    return parts.join('\n')
  }

  // ---------- project corpus (shared by graph & merge) ----------
  function invalidateProject(sessionId) {
    const cached = projectCache.get(sessionId)
    if (!cached) return
    for (const id of cached.members || []) projectCache.delete(id)
  }

  async function loadProject(targetId) {
    const cached = projectCache.get(targetId)
    if (cached && cached.expiresAt > Date.now()) return cached.value
    const records = await Q.listSessions()
    const byId = new Map()
    for (const r of records) byId.set(r.header.id, r)
    const main = byId.get(targetId)
    if (!main) return { error: 'session-not-found' }
    const cwd = main.header.cwd
    let ws = null
    if (cwd) {
      ws = W.list().find((w) => w.path === cwd) || null
      if (!ws) ws = await W.resolveByPath(cwd).catch(() => null)
    }
    const members = []
    const memberSet = new Set()
    if (ws && Array.isArray(ws.sessionIds)) {
      for (const id of ws.sessionIds) {
        if (byId.has(id) && !memberSet.has(id)) { memberSet.add(id); members.push(id) }
      }
    }
    if (!memberSet.has(targetId)) { memberSet.add(targetId); members.push(targetId) }
    const safeMembers = members.filter((id) => byId.has(id))

    const titleResults = await Q.readTitleSnapshots(safeMembers)
    const titles = new Map()
    for (const r of titleResults) {
      if (r.status === 'fulfilled' && r.value && r.value.title && typeof r.value.title.title === 'string') titles.set(r.sessionId, r.value.title.title)
    }

    const seedLengths = new Map()
    for (const id of safeMembers) seedLengths.set(id, byId.get(id).header.seedLength ?? 0)

    const depthOf = (id) => {
      let d = 0
      let cur = byId.get(id).header.parentSession
      let hops = 0
      while (cur && memberSet.has(cur) && byId.has(cur) && hops < 64) { d++; cur = byId.get(cur).header.parentSession; hops++ }
      return d
    }
    const processOrder = safeMembers.slice().sort((a, b) => depthOf(a) - depthOf(b) || (byId.get(a).header.createdAt ?? 0) - (byId.get(b).header.createdAt ?? 0))

    const native = new Map()
    for (const id of processOrder) {
      if (!native.has(id)) native.set(id, [])
      const sl = seedLengths.get(id) ?? 0
      let events = []
      try { events = (await Q.readSession(id)).events } catch (e) { console.error('[git-graph] readSession failed', id, e) }
      const raw = extractCommits(events)
      for (const c of raw) {
        let owner = id
        let hops = 0
        while (c.endSeq < (seedLengths.get(owner) ?? 0) && hops < 64) {
          const oHeader = byId.has(owner) ? byId.get(owner).header : null
          if (!oHeader || !oHeader.parentSession) break
          if (!byId.has(oHeader.parentSession)) break
          owner = oHeader.parentSession
          hops++
        }
        const key = owner + ':' + c.turn
        if (!native.has(owner)) native.set(owner, [])
        const arr = native.get(owner)
        const exist = arr.find((x) => x.key === key)
        if (exist) continue
        c.key = key
        c.owner = owner
        arr.push(c)
      }
    }

    const commitByKey = new Map()
    for (const list of native.values()) for (const c of list) commitByKey.set(c.key, c)

    const branches = []
    const branchById = new Map()
    for (const id of safeMembers) {
      const header = byId.get(id).header
      const ancestors = []
      let cur = header.parentSession
      let hops = 0
      while (cur && memberSet.has(cur) && byId.has(cur) && hops < 64) {
        ancestors.unshift(cur)
        cur = byId.get(cur).header.parentSession
        hops++
      }
      const ownCommits = native.get(id) || []
      // A child's chain keeps ONLY the ancestor commits its seed actually
      // reaches (endSeq < seedLength) — the fork point is the last inherited
      // commit, not the parent's newest.
      const sl = seedLengths.get(id) ?? 0
      const chain = []
      for (const aid of ancestors) for (const c of (native.get(aid) || [])) {
        if (c.endSeq < sl) chain.push(c.key)
      }
      for (const c of ownCommits) chain.push(c.key)
      const branch = {
        id,
        title: titles.get(id) || ('会话 ' + id.replace(/^session-/, '').slice(0, 8)),
        parentId: header.parentSession && memberSet.has(header.parentSession) ? header.parentSession : null,
        createdAt: header.createdAt ?? 0,
        updatedAt: ownCommits.length ? ownCommits[ownCommits.length - 1].time : (header.createdAt ?? 0),
        commitCount: ownCommits.length,
        chain,
        headKey: chain.length ? chain[chain.length - 1] : null,
      }
      branches.push(branch)
      branchById.set(id, branch)
    }

    const p = { byId, ws, cwd, safeMembers, memberSet, titles, seedLengths, native, commitByKey, branches, branchById }
    p.workspaceKey = workspaceKeyOf(p)
    p.projectMerges = []
    for (const m of merges.values()) {
      if (!m || !branchById.has(m.sourceA) || !branchById.has(m.targetB)) continue
      if (m.workspaceKey && m.workspaceKey !== p.workspaceKey) continue
      let changed = false
      if (!m.workspaceKey) { m.workspaceKey = p.workspaceKey; changed = true }
      if (m.schemaVersion !== 2) { m.schemaVersion = 2; changed = true }
      if (!m.key) { m.key = 'mg:' + m.id; changed = true }
      if (!m.targetParentKey) { m.targetParentKey = m.headBeforeB || null; changed = true }
      if (!Array.isArray(m.parentKeys)) { m.parentKeys = [m.targetParentKey, m.sourceHeadKey].filter(Boolean); changed = true }
      if (!Array.isArray(m.mergeBaseKeys)) { m.mergeBaseKeys = m.lcaKey ? [m.lcaKey] : []; changed = true }
      if (!Array.isArray(m.deltaKeys)) { m.deltaKeys = Array.isArray(m.diffKeys) ? m.diffKeys.slice() : []; changed = true }
      if (!m.injectionState) {
        if (m.injected && !m.dynamicInjection) {
          m.legacyInjectedMessage = true
          m.injected = false
          m.injectionState = 'inactive'
        } else {
          m.injectionState = m.injected ? 'active' : 'inactive'
        }
        changed = true
      }
      if (m.status === 'reverted' && !(m.revert && m.revert.id)) {
        const revertId = 'legacy-' + m.id
        m.revert = { id: revertId, key: 'rv:' + revertId, parentKey: m.key, createdAt: (Number(m.createdAt) || 0) + 1, legacy: true }
        m.injectionState = 'inactive'
        changed = true
      }
      if (changed && mergeTable) mergeTable.put(m.id, m).catch((e) => console.error('[git-graph] merge migration persist failed', e))
      p.projectMerges.push(m)
    }
    p.dag = buildInformationDag({ branches, commitByKey, merges: p.projectMerges })
    assertDagInvariants(p.dag)
    for (const b of branches) {
      b.nativeHeadKey = p.dag.nativeHeads.get(b.id) || null
      b.effectiveHeadKey = p.dag.branchHeads.get(b.id) || b.nativeHeadKey
      b.headKey = b.effectiveHeadKey
    }
    updateFrames(p)
    const cacheEntry = { value: p, members: safeMembers.slice(), expiresAt: Date.now() + 120000 }
    for (const id of safeMembers) projectCache.set(id, cacheEntry)
    return p
  }

  function serializeCommits(p) {
    const commits = []
    const seenCommit = new Set()
    for (const b of p.branches) {
      for (const key of b.chain) {
        if (seenCommit.has(key)) continue
        seenCommit.add(key)
        const c = p.commitByKey.get(key)
        if (!c) continue
        const stub = summaries.get(key)
        commits.push({
          key,
          sessionId: c.owner,
          turn: c.turn,
          userSeq: c.userSeq,
          endSeq: c.endSeq,
          time: c.time,
          userText: c.firstUser.slice(0, 140),
          human: !!c.human,
          title: stub && stub.summary ? firstLine(stub.summary, 44) : (firstLine(c.firstUser, 44) || ('#' + c.turn)),
          summary: stub ? stub.summary : '',
          status: stub ? (stub.fallback ? 'fallback' : 'ai') : 'pending',
        })
      }
    }
    return commits
  }
  function serializeMerges(p) {
    const projectMerges = []
    for (const m of p.projectMerges || []) {
      projectMerges.push(serializeMerge(m, p.branchById))
    }
    projectMerges.sort((a, b) => (a.time || 0) - (b.time || 0))
    return projectMerges
  }
  function projectLabel(p) {
    return {
      id: p.ws ? p.ws.id : '',
      key: p.workspaceKey || workspaceKeyOf(p),
      path: p.ws ? p.ws.path : (p.cwd || ''),
      title: p.ws ? p.ws.title : (p.cwd ? (p.cwd.split('/').filter(Boolean).pop() || p.cwd) : '未命名项目'),
    }
  }

  async function buildGraph(targetId) {
    const p = await loadProject(targetId)
    if (p.error) return { error: p.error }
    const cfg = settings.get(p.workspaceKey) || { autoSummary: false }
    const model = currentModel()
    return {
      workspace: projectLabel(p),
      branches: p.branches,
      commits: serializeCommits(p),
      merges: serializeMerges(p),
      reverts: serializeMerges(p).filter((m) => m.revert).map((m) => ({ ...m.revert, mergeId: m.id, targetB: m.targetB, title: 'Revert ' + m.title })),
      privacy: { autoSummary: !!cfg.autoSummary, provider: model.provider, model: model.model },
      current: targetId,
      generatedAt: Date.now(),
    }
  }

  // ---------- merge pipeline ----------
  const mergeLocks = new Map()
  async function withMergeLock(key, work) {
    const previous = mergeLocks.get(key) || Promise.resolve()
    let release
    const marker = new Promise((resolve) => { release = resolve })
    const queued = previous.catch(() => {}).then(() => marker)
    mergeLocks.set(key, queued)
    await previous.catch(() => {})
    try { return await work() }
    finally {
      release()
      if (mergeLocks.get(key) === queued) mergeLocks.delete(key)
    }
  }

  function rootBranchId(branch, branchById) {
    let cur = branch
    let hops = 0
    while (cur && cur.parentId && branchById.get(cur.parentId) && hops < 64) { cur = branchById.get(cur.parentId); hops++ }
    return cur ? cur.id : null
  }

  function diffEntries(p, keys) {
    const out = []
    for (const key of keys) {
      const node = p.dag.nodes.get(key)
      if (!node) continue
      if (node.kind === 'commit') {
        const c = p.commitByKey.get(key)
        if (!c) continue
        out.push({ key, turn: c.turn, userText: c.firstUser, summary: (summaries.get(key) || {}).summary || '' })
      } else if (node.kind === 'merge') {
        const m = node.record || {}
        out.push({ key, turn: null, userText: '传递合入 ' + key, summary: renderIoText(m) })
      } else if (node.kind === 'revert') {
        out.push({ key, turn: null, userText: 'Git revert ' + node.mergeId, summary: '撤销对应合入对当前上下文的作用，保留其祖先关系。' })
      }
    }
    return out
  }

  async function mergeFor(callerSessionId, source, target) {
    if (typeof callerSessionId !== 'string' || typeof source !== 'string' || typeof target !== 'string' || !source || !target) return { ok: false, code: 'bad-args' }
    const initial = await loadProject(callerSessionId)
    if (initial.error) return { ok: false, code: initial.error }
    if (!initial.branchById.has(source) || !initial.branchById.has(target)) return { ok: false, code: 'workspace-mismatch' }
    const lockKey = initial.workspaceKey + '|' + source + '|' + target
    return await withMergeLock(lockKey, async () => {
      const p = await loadProject(callerSessionId)
      if (p.error) return { ok: false, code: p.error }
      if (source === target) return { ok: false, code: 'self' }
      const A = p.branchById.get(source)
      const B = p.branchById.get(target)
      if (!A || !B) return { ok: false, code: 'workspace-mismatch' }
      if (rootBranchId(A, p.branchById) !== rootBranchId(B, p.branchById)) return { ok: false, code: 'unrelated' }
      const sourceHead = p.dag.branchHeads.get(source)
      const targetHead = p.dag.branchHeads.get(target)
      if (!sourceHead) return { ok: false, code: 'no-effective-increment' }
      const deltaKeys = p.dag.delta(sourceHead, targetHead)
      if (deltaKeys.length === 0) {
        // A concurrent or repeated request may observe the merge node produced
        // by the first request as its new target head. Reuse that result rather
        // than creating an empty merge or reporting a misleading failure.
        const absorbed = [...(p.projectMerges || [])].reverse().find((m) =>
          m.sourceA === source && m.targetB === target && m.sourceHeadKey === sourceHead)
        if (absorbed) return { ok: true, merge: serializeMerge(absorbed, p.branchById), dedup: true }
        return { ok: false, code: 'already-contained' }
      }
      const existing = (p.projectMerges || []).find((m) => m.sourceA === source && m.targetB === target && m.sourceHeadKey === sourceHead && (m.targetParentKey || m.headBeforeB) === targetHead)
      if (existing) return { ok: true, merge: serializeMerge(existing, p.branchById), dedup: true }
      const entries = diffEntries(p, deltaKeys)
      if (entries.length === 0) return { ok: false, code: 'no-effective-increment' }
      const io = await extractIo(entries, B.title)
      if (!io || (!io.propositions.length && !io.negativeConstraints.length && !io.openQuestions.length)) return { ok: false, code: 'no-effective-increment' }
      const mergeBaseKeys = p.dag.mergeBases(sourceHead, targetHead)
      const createdAt = Date.now()
      const rec = {
        schemaVersion: 2,
        id: 'mg-' + Math.random().toString(36).slice(2, 12),
        workspaceKey: p.workspaceKey,
        sourceA: source,
        targetB: target,
        sourceHeadKey: sourceHead,
        targetParentKey: targetHead || null,
        headBeforeB: targetHead || null,
        parentKeys: [targetHead, sourceHead].filter(Boolean),
        mergeBaseKeys,
        lcaKey: mergeBaseKeys.length === 1 ? mergeBaseKeys[0] : null,
        createdAt,
        causalOrder: createdAt,
        status: 'active',
        injected: false,
        injectionState: 'inactive',
        dynamicInjection: true,
        io,
        deltaKeys,
        diffKeys: deltaKeys,
        diffTurns: entries.filter((entry) => entry.turn !== null).map((entry) => entry.turn),
      }
      rec.key = 'mg:' + rec.id
      merges.set(rec.id, rec)
      if (mergeTable) { try { await mergeTable.put(rec.id, rec) } catch (e) { console.error('[git-graph] merge persist failed', e) } }
      invalidateProject(callerSessionId)
      const updated = await loadProject(callerSessionId)
      return { ok: true, merge: serializeMerge(rec, updated.error ? p.branchById : updated.branchById) }
    })
  }

  async function scopedMerge(callerSessionId, mergeId) {
    if (typeof callerSessionId !== 'string' || typeof mergeId !== 'string') return { error: 'bad-args' }
    const p = await loadProject(callerSessionId)
    if (p.error) return { error: p.error }
    const m = (p.projectMerges || []).find((item) => item.id === mergeId)
    if (!m || m.workspaceKey !== p.workspaceKey) return { error: 'workspace-mismatch' }
    return { p, m }
  }

  async function persistMergeAndRefresh(callerSessionId, m) {
    if (mergeTable) await mergeTable.put(m.id, m)
    invalidateProject(callerSessionId)
    await loadProject(callerSessionId)
  }

  async function revertFor(callerSessionId, mergeId) {
    const scoped = await scopedMerge(callerSessionId, mergeId)
    if (scoped.error) return { ok: false, code: scoped.error }
    const { p, m } = scoped
    if (m.revert && m.revert.id) return { ok: true, revert: m.revert, dedup: true }
    const parentKey = p.dag.branchHeads.get(m.targetB)
    const createdAt = Date.now()
    const revertId = 'rv-' + Math.random().toString(36).slice(2, 12)
    m.revert = { id: revertId, key: 'rv:' + revertId, parentKey, createdAt, causalOrder: createdAt, revertsMergeId: m.id }
    m.status = 'reverted'
    m.injected = false
    m.injectionState = 'inactive'
    try { await persistMergeAndRefresh(callerSessionId, m) }
    catch (e) { console.error('[git-graph] merge revert persist failed', e); return { ok: false, code: 'persist-failed' } }
    return { ok: true, revert: m.revert }
  }

  async function injectFor(callerSessionId, mergeId) {
    const scoped = await scopedMerge(callerSessionId, mergeId)
    if (scoped.error) return { ok: false, code: scoped.error }
    const { m } = scoped
    if (m.status !== 'active' || m.revert) return { ok: false, code: 'reverted' }
    if (m.injectionState === 'active' && m.dynamicInjection) return { ok: true, dedup: true }
    m.injected = true
    m.injectionState = 'active'
    m.dynamicInjection = true
    try { await persistMergeAndRefresh(callerSessionId, m) }
    catch (e) { console.error('[git-graph] merge inject persist failed', e); return { ok: false, code: 'persist-failed' } }
    return { ok: true }
  }

  async function uninjectFor(callerSessionId, mergeId) {
    const scoped = await scopedMerge(callerSessionId, mergeId)
    if (scoped.error) return { ok: false, code: scoped.error }
    const { m } = scoped
    if (m.injectionState !== 'active') return { ok: true, dedup: true }
    m.injected = false
    m.injectionState = 'inactive'
    try { await persistMergeAndRefresh(callerSessionId, m) }
    catch (e) { console.error('[git-graph] merge uninject persist failed', e); return { ok: false, code: 'persist-failed' } }
    return { ok: true }
  }

  async function summarizeFor(sessionId, turn) {
    await domainReady
    if (typeof sessionId !== 'string' || typeof turn !== 'number') return { ok: false, error: 'bad-args' }
    try {
      const snap = await Q.readSession(sessionId)
      const c = extractCommits(snap.events).find((x) => x.turn === turn)
      if (!c) return { ok: false, error: 'commit-not-found' }
      const p = await loadProject(sessionId)
      if (p.error) return { ok: false, error: p.error }
      const st = await callLlm(c)
      const value = st
        ? { schemaVersion: 2, workspaceKey: p.workspaceKey, sessionId, turn, summary: st.text, provider: st.provider, model: st.model, generatedAt: Date.now() }
        : { schemaVersion: 2, workspaceKey: p.workspaceKey, sessionId, turn, summary: fallbackSummary(c), provider: '', model: '', generatedAt: Date.now(), fallback: true }
      summaries.set(sessionId + ':' + turn, value)
      if (table) { try { await table.put(sessionId + ':' + turn, value) } catch (e) { console.error('[git-graph] persist summary failed', e) } }
      return { ok: true, summary: value.summary, fallback: !!value.fallback }
    } catch (e) {
      console.error('[git-graph] summarize failed', e)
      return { ok: false, error: String((e && e.message) || e) }
    }
  }

  async function settingsFor(sessionId) {
    const p = await loadProject(sessionId)
    if (p.error) return { ok: false, code: p.error }
    const cfg = settings.get(p.workspaceKey) || { autoSummary: false }
    return { ok: true, workspaceKey: p.workspaceKey, autoSummary: !!cfg.autoSummary, ...currentModel() }
  }

  async function updateSettingsFor(sessionId, autoSummary) {
    if (typeof autoSummary !== 'boolean') return { ok: false, code: 'bad-args' }
    const p = await loadProject(sessionId)
    if (p.error) return { ok: false, code: p.error }
    const value = { schemaVersion: 2, workspaceKey: p.workspaceKey, autoSummary, updatedAt: Date.now() }
    settings.set(p.workspaceKey, value)
    if (settingsTable) {
      try { await settingsTable.put(p.workspaceKey, value) }
      catch (e) { console.error('[git-graph] settings persist failed', e); return { ok: false, code: 'persist-failed' } }
    }
    return { ok: true, ...value, ...currentModel() }
  }

  async function purgeFor(sessionId, args) {
    const p = await loadProject(sessionId)
    if (p.error) return { ok: false, code: p.error }
    const purgeSummaries = !args || args.summaries !== false
    const purgeMerges = !args || args.merges !== false
    const purgeSettings = !!(args && args.settings)
    const removed = { summaries: 0, merges: 0, settings: 0 }
    try {
      if (purgeSummaries) {
        for (const [key, value] of [...summaries.entries()]) {
          const belongs = value && value.workspaceKey ? value.workspaceKey === p.workspaceKey : p.memberSet.has(value && value.sessionId)
          if (!belongs) continue
          summaries.delete(key)
          await deleteStored(table, key)
          removed.summaries++
        }
      }
      if (purgeMerges) {
        for (const m of [...(p.projectMerges || [])]) {
          merges.delete(m.id)
          await deleteStored(mergeTable, m.id)
          removed.merges++
        }
      }
      if (purgeSettings && settings.has(p.workspaceKey)) {
        settings.delete(p.workspaceKey)
        await deleteStored(settingsTable, p.workspaceKey)
        removed.settings++
      }
    } catch (e) {
      console.error('[git-graph] purge failed', e)
      return { ok: false, code: 'purge-failed', detail: String((e && e.message) || e), removed }
    }
    invalidateProject(sessionId)
    await loadProject(sessionId)
    return { ok: true, removed }
  }

  // ---------- HTTP routes (loopback fenced, same-origin JSON) ----------
  function isLoopback(req) {
    const a = req.socket && req.socket.remoteAddress
    return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'
  }
  function json(res, status, payload) {
    try {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(payload))
    } catch { /* client gone */ }
  }
  async function readJsonBody(req) {
    let body = ''
    try {
      for await (const chunk of req) {
        body += chunk
        if (body.length > 65536) return null
      }
    } catch { return null }
    try { return JSON.parse(body) } catch { return null }
  }
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/sgx',
    handler: async (req, res) => {
      if (!isLoopback(req)) return json(res, 403, { error: 'forbidden' })
      let url
      try { url = new URL(req.url, 'http://localhost') } catch { return json(res, 400, { error: 'bad-url' }) }
      if (req.method === 'GET' && url.pathname === '/sgx/graph') {
        await domainReady
        const sid = url.searchParams.get('session')
        if (!sid) return json(res, 400, { error: 'bad-args' })
        try { return json(res, 200, await buildGraph(sid)) }
        catch (e) { console.error('[git-graph] graph failed', e); return json(res, 500, { error: 'graph-failed', detail: String((e && e.message) || e) }) }
      }
      if (req.method === 'POST' && url.pathname === '/sgx/summarize') {
        const args = await readJsonBody(req)
        return json(res, 200, await summarizeFor(args && args.sessionId, args && args.turn))
      }
      if (req.method === 'POST' && url.pathname === '/sgx/merge') {
        await domainReady
        const args = await readJsonBody(req)
        return json(res, 200, await mergeFor(args && args.sessionId, args && args.sourceA, args && args.targetB))
      }
      if (req.method === 'POST' && url.pathname === '/sgx/merge/revert') {
        await domainReady
        const args = await readJsonBody(req)
        return json(res, 200, await revertFor(args && args.sessionId, args && args.mergeId))
      }
      if (req.method === 'POST' && url.pathname === '/sgx/merge/inject') {
        await domainReady
        const args = await readJsonBody(req)
        return json(res, 200, await injectFor(args && args.sessionId, args && args.mergeId))
      }
      if (req.method === 'POST' && url.pathname === '/sgx/merge/uninject') {
        await domainReady
        const args = await readJsonBody(req)
        return json(res, 200, await uninjectFor(args && args.sessionId, args && args.mergeId))
      }
      if (req.method === 'GET' && url.pathname === '/sgx/settings') {
        await domainReady
        const sid = url.searchParams.get('session')
        return json(res, 200, await settingsFor(sid))
      }
      if (req.method === 'POST' && url.pathname === '/sgx/settings') {
        await domainReady
        const args = await readJsonBody(req)
        return json(res, 200, await updateSettingsFor(args && args.sessionId, args && args.autoSummary))
      }
      if (req.method === 'POST' && url.pathname === '/sgx/purge') {
        await domainReady
        const args = await readJsonBody(req)
        return json(res, 200, await purgeFor(args && args.sessionId, args))
      }
      return json(res, 404, { error: 'not-found' })
    },
  }), 'dsh-session-graph: /sgx routes')

  // ---------- model-visible tools (registered per project-session agent) ----------
  function toolOutput() {
    return { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] }
  }
  function callingSession(exec) {
    const s = exec && exec.agent && exec.agent.session
    return s && typeof s.id === 'string' ? { id: s.id, cwd: s.header && s.header.cwd } : null
  }
  const viewTool = {
    name: 'session_graph_view',
    description: '查看当前会话所在项目的 Git 图谱摘要（branch=会话，commit=一轮请求+完成，merge=分支合入），含分支树与合入记录。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: toolOutput(),
    timeoutMs: 60000,
    async execute(_args, exec) {
      const s = callingSession(exec)
      if (!s) return { ok: false, code: 'no-project' }
      const p = await loadProject(s.id)
      if (p.error) return { ok: false, code: p.error }
      return {
        ok: true,
        workspace: projectLabel(p),
        branches: p.branches.map((b) => ({ id: b.id, title: b.title, parentId: b.parentId, commitCount: b.commitCount, nativeHeadKey: b.nativeHeadKey, effectiveHeadKey: b.effectiveHeadKey, headKey: b.headKey })),
        commits: serializeCommits(p).map((c) => ({ key: c.key, sessionId: c.sessionId, turn: c.turn, title: c.title, time: c.time })),
        merges: serializeMerges(p).map((m) => ({ id: m.id, key: m.key, sourceTitle: m.sourceTitle, targetTitle: m.targetTitle, title: m.title, status: m.status, injected: m.injected, parentKeys: m.parentKeys, mergeBaseKeys: m.mergeBaseKeys, deltaKeys: m.deltaKeys, revertedBy: m.revertedBy, diffTurns: m.diffTurns })),
        current: s.id,
      }
    },
  }
  const readTool = {
    name: 'session_graph_read',
    description: '读取图谱中一个分支、提交或合入节点的完整内容。target 可为分支 id/标题、提交 key（"session-…:turn"）、合入 key（"mg:…"）。用于追溯被合入结论的来源与原文。',
    parameters: { type: 'object', additionalProperties: false, required: ['target'], properties: { target: { type: 'string', description: '分支 id/标题、提交 key 或合入 key' } } },
    output: toolOutput(),
    timeoutMs: 60000,
    async execute(args, exec) {
      const s = callingSession(exec)
      if (!s) return { ok: false, code: 'no-project' }
      const p = await loadProject(s.id)
      if (p.error) return { ok: false, code: p.error }
      const target = typeof (args && args.target) === 'string' ? args.target : ''
      if (!target) return { ok: false, code: 'bad-args' }
      if (target.startsWith('mg:')) {
        const m = (p.projectMerges || []).find((item) => item.id === target.slice(3))
        if (!m) return { ok: false, code: 'not-found' }
        return { ok: true, kind: 'merge', merge: serializeMerge(m, p.branchById) }
      }
      if (target.startsWith('rv:')) {
        const m = (p.projectMerges || []).find((item) => item.revert && (item.revert.key === target || item.revert.id === target.slice(3)))
        if (!m) return { ok: false, code: 'not-found' }
        return { ok: true, kind: 'revert', revert: { ...m.revert, mergeId: m.id, targetB: m.targetB } }
      }
      const c = p.commitByKey.get(target)
      if (c) {
        const stub = summaries.get(target)
        return {
          ok: true,
          kind: 'commit',
          commit: {
            key: target,
            sessionId: c.owner,
            turn: c.turn,
            time: c.time,
            branch: p.branchById.has(c.owner) ? p.branchById.get(c.owner).title : '',
            userRequest: c.firstUser.slice(0, 300),
            assistantReply: c.ass.slice(0, 4000),
            summary: stub ? stub.summary : '',
          },
        }
      }
      let b = p.branchById.get(target)
      if (!b) { for (const x of p.branches) if (x.title === target) { b = x; break } }
      if (!b) return { ok: false, code: 'not-found' }
      const own = b.commitCount || 0
      const forkKey = own > 0 && b.chain.length > own ? b.chain[b.chain.length - own - 1] : (b.chain.length > 0 ? b.chain[b.chain.length - 1] : null)
      return {
        ok: true,
        kind: 'branch',
        branch: {
          id: b.id,
          title: b.title,
          parentId: b.parentId,
          createdAt: b.createdAt,
          updatedAt: b.updatedAt,
          forkKey,
          headKey: b.headKey,
          commitCount: own,
          commits: b.chain.map((k) => {
            const cc = p.commitByKey.get(k)
            return { key: k, turn: cc ? cc.turn : null, title: cc ? (firstLine(cc.firstUser, 40) || ('#' + cc.turn)) : k, ownedBy: cc ? cc.owner : null }
          }),
          merges: serializeMerges(p).filter((m) => m.sourceA === b.id || m.targetB === b.id),
        },
      }
    },
  }
  const mergeTool = {
    name: 'session_graph_merge',
    description: '把供体分支 source（分支 id 或标题）合入受体分支 target（默认当前会话所在分支）。合入会萃取 source 相对共同祖先的增量信息对象，不改动受体日志，可撤销。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['source'],
      properties: {
        source: { type: 'string', description: '供体分支 id 或标题' },
        target: { type: 'string', description: '受体分支 id 或标题；缺省为当前会话所在分支' },
      },
    },
    output: toolOutput(),
    timeoutMs: 120000,
    async execute(args, exec) {
      const s = callingSession(exec)
      if (!s) return { ok: false, code: 'no-project' }
      const p = await loadProject(s.id)
      if (p.error) return { ok: false, code: p.error }
      const resolveBranch = (t) => {
        let b = p.branchById.get(t)
        if (!b) { for (const x of p.branches) if (x.title === t) { b = x; break } }
        return b
      }
      const A = resolveBranch(args && args.source)
      if (!A) return { ok: false, code: 'not-found' }
      let targetId
      if (typeof (args && args.target) === 'string' && args.target) {
        const B = resolveBranch(args.target)
        if (!B) return { ok: false, code: 'not-found' }
        targetId = B.id
      } else {
        targetId = s.id
      }
      if (!p.branchById.has(targetId)) return { ok: false, code: 'no-project' }
      return await mergeFor(s.id, A.id, targetId)
    },
  }
  function registerAgentSurface(agent) {
    if (!agent || !agent.ctx) return
    const sid = agent.session && typeof agent.session.id === 'string' ? agent.session.id : null
    const cwd = agent.session && agent.session.header && agent.session.header.cwd
    if (!sid) return
    const actx = agent.ctx
    try {
      actx.systemPrompt.section({ name: 'plugin:session-graph', order: 95, text: () => frameFor(sid) })
    } catch (e) { console.error('[git-graph] agent section failed', e) }
    if (typeof cwd === 'string' && cwd) {
      ;(async () => {
        try {
          let ws = W.list().find((w) => w.path === cwd) || null
          if (!ws) ws = await W.resolveByPath(cwd).catch(() => null)
          if (!ws) return
          actx.tools.register(viewTool)
          actx.tools.register(readTool)
          actx.tools.register(mergeTool)
        } catch (e) { console.error('[git-graph] agent tools failed', e) }
      })()
    }
  }
  ctx.on('agent/created', (payload) => {
    registerAgentSurface(payload && payload.agent)
  })

  // boot warm: frames for every workspace (best effort)
  async function warmFrames() {
    try {
      const records = await Q.listSessions()
      const byId = new Map()
      for (const r of records) byId.set(r.header.id, r)
      for (const ws of W.list()) {
        const ids = (ws.sessionIds || []).filter((id) => byId.has(id))
        if (ids.length === 0) continue
        try { await loadProject(ids[0]) } catch (e) { /* skip */ }
      }
    } catch (e) { /* best effort */ }
  }
  domainReady.then(warmFrames).catch(() => {})
}
