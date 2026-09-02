/**
 * dsh-session-graph — Host half (pure ESM, zero runtime imports).
 *
 * 以 Git 图谱风格展示同一项目（workspace）下的会话分叉记录与进展：
 *   - branch = 会话（fork 关系由 SessionHeader.parentSession / seedLength 决定）
 *   - commit = 一轮「用户请求 + 完成」（turn），要点摘要由 LLM 生成并持久化
 *
 * 数据服务路径（本插件自行注册，供浏览器半区 fetch）：
 *   GET  /sgx/graph?session=<id>   -> 项目图谱 JSON
 *   POST /sgx/summarize            -> { sessionId, turn } -> 生成/重试 AI 要点
 *
 * 持久化：storage-domain "session_graph"（~/.dsh/storages/session_graph.json）。
 * 只允许 loopback 客户端访问（与 dsh-git-graph 相同的围栏）。
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
  const summaries = new Map()
  const domainReady = (async () => {
    domain = await D.open({ name: 'session_graph', version: 0, tables: { commits: { valueSchema: DUCK } } })
    table = domain.table('commits')
    for (const [k, v] of table.entries()) summaries.set(k, v)
  })().catch((e) => { console.error('[git-graph] storage unavailable', e) })
  ctx.effect(() => {
    return () => {
      const d = domain
      domain = null
      table = null
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
      const rid = () => 'sg-' + Math.random().toString(36).slice(2, 12)
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

  async function buildGraph(targetId) {
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
      const chain = []
      for (const aid of ancestors) for (const c of (native.get(aid) || [])) chain.push(c.key)
      for (const c of ownCommits) chain.push(c.key)
      branches.push({
        id,
        title: titles.get(id) || ('会话 ' + id.replace(/^session-/, '').slice(0, 8)),
        parentId: header.parentSession && memberSet.has(header.parentSession) ? header.parentSession : null,
        createdAt: header.createdAt ?? 0,
        updatedAt: ownCommits.length ? ownCommits[ownCommits.length - 1].time : (header.createdAt ?? 0),
        commitCount: ownCommits.length,
        chain,
        headKey: chain.length ? chain[chain.length - 1] : null,
      })
    }

    const commits = []
    const seenCommit = new Set()
    for (const b of branches) {
      for (const key of b.chain) {
        if (seenCommit.has(key)) continue
        seenCommit.add(key)
        const c = commitByKey.get(key)
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

    return {
      workspace: {
        id: ws ? ws.id : '',
        path: ws ? ws.path : (cwd || ''),
        title: ws ? ws.title : (cwd ? (cwd.split('/').filter(Boolean).pop() || cwd) : '未命名项目'),
      },
      branches,
      commits,
      current: targetId,
      generatedAt: Date.now(),
    }
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
        let body = ''
        try { for await (const chunk of req) body += chunk } catch { return json(res, 400, { error: 'bad-body' }) }
        let args = null
        try { args = JSON.parse(body) } catch { return json(res, 400, { error: 'bad-json' }) }
        return json(res, 200, await summarizeFor(args && args.sessionId, args && args.turn))
      }
      return json(res, 404, { error: 'not-found' })
    },
  }), 'dsh-session-graph: /sgx routes')
}
