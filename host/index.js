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
 *   POST /sgx/merge                  -> { sourceA, targetB } -> 合入
 *   POST /sgx/merge/revert           -> { mergeId } -> 撤销
 *   POST /sgx/merge/inject           -> { mergeId } -> 注入受体上下文
 *
 * 持久化：storage-domain "session_graph"（~/.dsh/storages/session_graph.json），
 * 两张表：commits（要点摘要）、merges（合入记录）。只允许 loopback 客户端访问。
 */

export const inject = [
  'sessionQuery',
  'workspaceRegistry',
  'storageDomain',
  'llm',
  'agentDefaultModel',
  'webServer',
  'sessions',
]

export function apply(ctx) {
  const Q = ctx.sessionQuery
  const W = ctx.workspaceRegistry
  const D = ctx.storageDomain
  const LLM = ctx.llm
  const AM = ctx.agentDefaultModel
  const SESS = ctx.sessions

  const DUCK = Object.freeze({ safeParse: () => ({ success: true }), parse: (v) => v })
  let domain = null
  let table = null
  let mergeTable = null
  const summaries = new Map()
  const merges = new Map()
  const domainReady = (async () => {
    domain = await D.open({ name: 'session_graph', version: 0, tables: { commits: { valueSchema: DUCK }, merges: { valueSchema: DUCK } } })
    table = domain.table('commits')
    mergeTable = domain.table('merges')
    for (const [k, v] of table.entries()) summaries.set(k, v)
    for (const [k, v] of mergeTable.entries()) merges.set(k, v)
  })().catch((e) => { console.error('[git-graph] storage unavailable', e) })
  ctx.effect(() => {
    return () => {
      const d = domain
      domain = null
      table = null
      mergeTable = null
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
      const st = await callLlm(c)
      const value = st
        ? { sessionId: job.sessionId, turn: job.turn, summary: st, generatedAt: Date.now() }
        : { sessionId: job.sessionId, turn: job.turn, summary: fallbackSummary(c), generatedAt: Date.now(), fallback: true }
      summaries.set(key, value)
      if (table) { try { await table.put(key, value) } catch (e) { console.error('[git-graph] persist summary failed', e) } }
    } catch (e) { console.error('[git-graph] summary job failed', e) }
  }
  async function callLlm(c) {
    try {
      const sel = AM.currentSelection()
      if (!sel || !sel.provider || !sel.model) return null
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
      return trimmed.length > 0 ? trimmed.slice(0, 600) : null
    } catch (e) { console.error('[git-graph] llm summary failed', e); return null }
  }

  // live tracking: auto-summary as turns complete
  const live = new Map()
  ctx.on('session/event', (session, event) => {
    const id = session && session.id
    if (!id) return
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
      if (cur.userSeq) enqueueSummary(id, cur.turn)
      live.delete(id)
    }
  })

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
      const sel = AM.currentSelection()
      if (!sel || !sel.provider || !sel.model) return null
      const opts = { provider: sel.provider, model: sel.model, messages, maxTokens }
      if (system) opts.system = system
      let out = ''
      for await (const chunk of LLM.stream(opts)) {
        if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
        if (chunk && chunk.type === 'finish') break
      }
      return out.trim() || null
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
    const text = await llmText(messages, 900, IO_SYSTEM)
    if (text) {
      const json = parseJsonLenient(text)
      if (json && typeof json === 'object') {
        return {
          purpose: String(json.purpose || '').slice(0, 200),
          propositions: (Array.isArray(json.propositions) ? json.propositions : []).slice(0, 30).map(normProp),
          negativeConstraints: (Array.isArray(json.negativeConstraints) ? json.negativeConstraints : []).slice(0, 30).map(normProp),
          openQuestions: (Array.isArray(json.openQuestions) ? json.openQuestions : []).map(String).slice(0, 20),
          deliberateExclusions: (Array.isArray(json.deliberateExclusions) ? json.deliberateExclusions : []).map(String).slice(0, 20),
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
      key: 'mg:' + m.id,
      sourceA: m.sourceA,
      targetB: m.targetB,
      lcaKey: m.lcaKey,
      sourceHeadKey: m.sourceHeadKey,
      headBeforeB: m.headBeforeB,
      time: m.createdAt,
      status: m.status,
      injected: !!m.injected,
      sourceTitle: A ? A.title : '',
      targetTitle: B ? B.title : '',
      title: m.io && m.io.purpose ? firstLine(m.io.purpose, 40) : '合并',
      summary: renderIoText(m),
      io: m.io,
      diffKeys: m.diffKeys || [],
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
    const parts = []
    parts.push('【分支合入】「' + (m.sourceTitle || '') + '」已合入本分支「' + (m.targetTitle || '') + '」——这不是任务指令，而是被合入分支的入口：')
    parts.push('共同祖先 #' + (m.lcaKey ? turnLabelOf(m.lcaKey) : '无') + '，并入 ' + n + ' 个差分提交：' + (n ? diffTurns.map((t) => '#' + t).join('、') : '（空）') + '。')
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
    const activeM = [...merges.values()].filter((m) => m.status === 'active')
    for (const b of p.branches) {
      const root = roots.get(b.id)
      const siblings = p.branches.filter((x) => x.id !== b.id && roots.get(x.id) === root).map((x) => x.title)
      const mergesIn = activeM.filter((m) => m.targetB === b.id && byBranch.has(m.sourceA)).map((m) => byBranch.get(m.sourceA).title)
      const mergesOut = activeM.filter((m) => m.sourceA === b.id && byBranch.has(m.targetB)).map((m) => byBranch.get(m.targetB).title)
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
    parts.push('会话中的【分支合入】消息是已并入的可追溯结论（非待执行任务）；可用 session_graph_view/read 溯源，右侧「Git 图谱」侧栏可视化同一结构。')
    return parts.join('\n')
  }

  // ---------- project corpus (shared by graph & merge) ----------
  async function loadProject(targetId) {
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

    updateFrames({ byId, ws, cwd, safeMembers, memberSet, titles, seedLengths, native, commitByKey, branches, branchById })
    return { byId, ws, cwd, safeMembers, memberSet, titles, seedLengths, native, commitByKey, branches, branchById }
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
    const activeMerges = []
    for (const m of merges.values()) {
      if (m.status !== 'active') continue
      if (!p.branchById.has(m.targetB) || !p.branchById.has(m.sourceA)) continue
      activeMerges.push(serializeMerge(m, p.branchById))
    }
    activeMerges.sort((a, b) => (a.time || 0) - (b.time || 0))
    return activeMerges
  }
  function projectLabel(p) {
    return {
      id: p.ws ? p.ws.id : '',
      path: p.ws ? p.ws.path : (p.cwd || ''),
      title: p.ws ? p.ws.title : (p.cwd ? (p.cwd.split('/').filter(Boolean).pop() || p.cwd) : '未命名项目'),
    }
  }

  async function buildGraph(targetId) {
    const p = await loadProject(targetId)
    if (p.error) return { error: p.error }
    return {
      workspace: projectLabel(p),
      branches: p.branches,
      commits: serializeCommits(p),
      merges: serializeMerges(p),
      current: targetId,
      generatedAt: Date.now(),
    }
  }

  // ---------- merge pipeline ----------
  async function mergeFor(source, target) {
    if (typeof source !== 'string' || typeof target !== 'string' || !source || !target) return { ok: false, code: 'bad-args' }
    const p = await loadProject(target)
    if (p.error) return { ok: false, code: p.error }
    if (source === target) return { ok: false, code: 'self' }
    const A = p.branchById.get(source)
    const B = p.branchById.get(target)
    if (!A || !B) return { ok: false, code: 'not-found' }
    const rootOf = (b) => {
      let c = b
      let hops = 0
      while (c.parentId && p.branchById.get(c.parentId) && hops < 64) { c = p.branchById.get(c.parentId); hops++ }
      return c.id
    }
    if (rootOf(A) !== rootOf(B)) return { ok: false, code: 'unrelated' }
    let i = 0
    while (i < A.chain.length && i < B.chain.length && A.chain[i] === B.chain[i]) i++
    if (i === A.chain.length) return { ok: false, code: 'already-contained' }
    const lcaKey = i > 0 ? A.chain[i - 1] : null
    const diffKeys = A.chain.slice(i)
    if (diffKeys.length === 0) return { ok: false, code: 'no-effective-increment' }
    const existing = [...merges.values()].find((m) => m.sourceA === source && m.targetB === target && m.status === 'active')
    if (existing) return { ok: true, merge: serializeMerge(existing, p.branchById), dedup: true }
    const diffCommits = diffKeys.map((k) => p.commitByKey.get(k)).filter(Boolean).map((c) => ({
      key: c.key,
      turn: c.turn,
      userText: c.firstUser,
      summary: (summaries.get(c.key) || {}).summary || '',
    }))
    const io = await extractIo(diffCommits, B.title)
    if (!io) return { ok: false, code: 'llm-failed' }
    if (!io.propositions.length && !io.negativeConstraints.length && !io.openQuestions.length) return { ok: false, code: 'no-effective-increment' }
    const rec = {
      id: 'mg-' + Math.random().toString(36).slice(2, 12),
      sourceA: source,
      targetB: target,
      lcaKey,
      sourceHeadKey: A.chain.length ? A.chain[A.chain.length - 1] : null,
      headBeforeB: B.chain.length ? B.chain[B.chain.length - 1] : null,
      createdAt: Date.now(),
      status: 'active',
      injected: false,
      io,
      diffKeys,
      diffTurns: diffCommits.map((c) => c.turn),
    }
    merges.set(rec.id, rec)
    if (mergeTable) { try { await mergeTable.put(rec.id, rec) } catch (e) { console.error('[git-graph] merge persist failed', e) } }
    updateFrames(p)
    return { ok: true, merge: serializeMerge(rec, p.branchById) }
  }

  async function revertFor(mergeId) {
    const m = merges.get(mergeId)
    if (!m) return { ok: false, code: 'not-found' }
    if (m.status === 'reverted') return { ok: false, code: 'already-reverted' }
    m.status = 'reverted'
    if (mergeTable) { try { await mergeTable.put(mergeId, m) } catch (e) { console.error('[git-graph] merge revert persist failed', e) } }
    try { await loadProject(m.targetB) } catch (e) { /* frames refresh best-effort */ }
    return { ok: true }
  }

  async function injectFor(mergeId) {
    const m = merges.get(mergeId)
    if (!m) return { ok: false, code: 'not-found' }
    if (m.status !== 'active') return { ok: false, code: 'reverted' }
    const session = SESS.get(m.targetB)
    if (!session) return { ok: false, code: 'target-not-live', hint: '打开受体分支后再注入' }
    let view = m
    const p = await loadProject(m.targetB)
    if (!p.error) view = serializeMerge(m, p.branchById)
    const msg = {
      id: 'sgm-' + Math.random().toString(36).slice(2, 12),
      role: 'user',
      content: [{ type: 'text', text: renderMergeEntry(view) }],
      source: { kind: 'plugin', plugin: 'dsh-session-graph', form: 'recall' },
    }
    try {
      session.append('user/message', msg, { surfaceOp: 'append' })
    } catch (e) {
      return { ok: false, code: 'append-failed', detail: String((e && e.message) || e) }
    }
    m.injected = true
    if (mergeTable) { try { await mergeTable.put(mergeId, m) } catch (e) { /* ignore */ } }
    return { ok: true }
  }

  async function summarizeFor(sessionId, turn) {
    await domainReady
    if (typeof sessionId !== 'string' || typeof turn !== 'number') return { ok: false, error: 'bad-args' }
    try {
      const snap = await Q.readSession(sessionId)
      const c = extractCommits(snap.events).find((x) => x.turn === turn)
      if (!c) return { ok: false, error: 'commit-not-found' }
      const st = await callLlm(c)
      const value = st
        ? { sessionId, turn, summary: st, generatedAt: Date.now() }
        : { sessionId, turn, summary: fallbackSummary(c), generatedAt: Date.now(), fallback: true }
      summaries.set(sessionId + ':' + turn, value)
      if (table) { try { await table.put(sessionId + ':' + turn, value) } catch (e) { console.error('[git-graph] persist summary failed', e) } }
      return { ok: true, summary: value.summary, fallback: !!value.fallback }
    } catch (e) {
      console.error('[git-graph] summarize failed', e)
      return { ok: false, error: String((e && e.message) || e) }
    }
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
    try { for await (const chunk of req) body += chunk } catch { return null }
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
        return json(res, 200, await mergeFor(args && args.sourceA, args && args.targetB))
      }
      if (req.method === 'POST' && url.pathname === '/sgx/merge/revert') {
        await domainReady
        const args = await readJsonBody(req)
        return json(res, 200, await revertFor(args && args.mergeId))
      }
      if (req.method === 'POST' && url.pathname === '/sgx/merge/inject') {
        await domainReady
        const args = await readJsonBody(req)
        return json(res, 200, await injectFor(args && args.mergeId))
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
        branches: p.branches.map((b) => ({ id: b.id, title: b.title, parentId: b.parentId, commitCount: b.commitCount, headKey: b.headKey })),
        commits: serializeCommits(p).map((c) => ({ key: c.key, sessionId: c.sessionId, turn: c.turn, title: c.title, time: c.time })),
        merges: serializeMerges(p).map((m) => ({ id: m.id, key: m.key, sourceTitle: m.sourceTitle, targetTitle: m.targetTitle, title: m.title, injected: m.injected, diffTurns: m.diffTurns })),
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
        const m = merges.get(target.slice(3))
        if (!m) return { ok: false, code: 'not-found' }
        return { ok: true, kind: 'merge', merge: serializeMerge(m, p.branchById) }
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
      return await mergeFor(A.id, targetId)
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
