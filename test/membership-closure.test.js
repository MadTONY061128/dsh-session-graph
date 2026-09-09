import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { apply } from '../host/index.js'

function turn(turnId, seq, time, request, reply) {
  return [
    { type: 'turn/start', seq, time, data: { turn: turnId } },
    { type: 'user/message', seq: seq + 1, time: time + 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: request }] } },
    { type: 'assistant/message', seq: seq + 2, time: time + 2, data: { message: { content: [{ type: 'text', text: reply }] } } },
    { type: 'turn/end', seq: seq + 3, time: time + 3, data: { turn: turnId } },
  ]
}

function createHarness() {
  const sessionEvents = new Map([
    ['R', turn(0, 0, 100, 'root', 'root done')],
    ['A', turn(1, 10, 200, 'A one', 'A one done')],
    ['B', turn(1, 10, 210, 'B one', 'B one done')],
    ['S1', turn(1, 10, 300, 'subagent one', 'subagent one done')],
    ['S2', turn(1, 10, 310, 'subagent two', 'subagent two done')],
    ['SX', turn(1, 10, 320, 'cross-workspace subagent', 'done')],
    ['SO', turn(1, 10, 330, 'orphan subagent', 'done')],
  ])
  const headers = [
    { id: 'R', cwd: '/w/one', parentSession: null, seedLength: 0, createdAt: 1 },
    { id: 'A', cwd: '/w/one', parentSession: 'R', seedLength: 4, createdAt: 2 },
    { id: 'B', cwd: '/w/one', parentSession: 'R', seedLength: 4, createdAt: 3 },
    { id: 'S1', cwd: '/w/one', parentSession: 'A', seedLength: 0, origin: 'subagent', delegationDepth: 1, createdAt: 4 },
    { id: 'S2', cwd: '/w/one', parentSession: 'S1', seedLength: 0, origin: 'subagent', delegationDepth: 2, createdAt: 5 },
    { id: 'SX', cwd: '/w/two', parentSession: 'A', seedLength: 0, origin: 'subagent', delegationDepth: 1, createdAt: 6 },
    { id: 'SO', cwd: '/w/one', parentSession: 'GHOST', seedLength: 0, origin: 'subagent', delegationDepth: 1, createdAt: 7 },
  ]
  const workspaces = [
    { id: 'w1', path: '/w/one', title: 'one', sessionIds: ['R', 'A', 'B'] },
    { id: 'w2', path: '/w/two', title: 'two', sessionIds: [] },
  ]
  const stores = new Map()
  const tableFor = (name) => {
    if (!stores.has(name)) stores.set(name, new Map())
    const data = stores.get(name)
    return { entries: () => data.entries(), put: async (key, value) => data.set(key, structuredClone(value)), delete: async (key) => data.delete(key) }
  }
  const handlers = new Map()
  const services = new Map()
  let routeHandler = null
  const ctx = {
    sessionQuery: {
      listSessions: async () => headers.map((header) => ({ header })),
      readSession: async (id) => ({ events: sessionEvents.get(id) || [] }),
      readTitleSnapshots: async (ids) => ids.map((id) => ({ status: 'fulfilled', sessionId: id, value: { title: { title: id } } })),
    },
    workspaceRegistry: {
      list: () => workspaces,
      resolveByPath: async (path) => workspaces.find((w) => w.path === path) || null,
    },
    storageDomain: {
      open: async () => ({ table: tableFor, close: async () => {} }),
    },
    llm: {
      async *stream() {
        yield { type: 'text-delta', text: '- summary' }
        yield { type: 'finish' }
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'mock-1' }) },
    webServer: { register: (spec) => { routeHandler = spec.handler; return () => {} } },
    effect: (factory) => factory(),
    provide: (name, value) => { services.set(name, value); return () => services.delete(name) },
    on: (name, fn) => { handlers.set(name, fn); return () => {} },
  }
  apply(ctx)

  async function request(method, url, body) {
    const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)])
    req.method = method
    req.url = url
    req.socket = { remoteAddress: '127.0.0.1' }
    return await new Promise((resolve) => {
      const res = {
        status: 0,
        writeHead(status) { this.status = status },
        end(text) { resolve({ status: this.status, body: JSON.parse(text) }) },
      }
      routeHandler(req, res)
    })
  }
  return { request, services, stores }
}

test('same-workspace subagent descendants join the project, cross-workspace and orphans do not', async () => {
  const h = createHarness()
  const graph = (await h.request('GET', '/sgx/graph?session=B')).body
  const ids = graph.branches.map((b) => b.id).sort()
  assert.deepEqual(ids, ['A', 'B', 'R', 'S1', 'S2'])
  const s1 = graph.branches.find((b) => b.id === 'S1')
  const s2 = graph.branches.find((b) => b.id === 'S2')
  assert.equal(s1.parentId, 'A')
  assert.equal(s2.parentId, 'S1')
  assert.equal(graph.workspace.key, 'ws:w1')
})

test('subagent branch merges into the manager branch through the shared root', async () => {
  const h = createHarness()
  const first = (await h.request('POST', '/sgx/merge', { sessionId: 'B', sourceA: 'S1', targetB: 'B' })).body
  assert.equal(first.ok, true)
  assert.ok(first.merge.deltaKeys.includes('S1:1'))
  const repeated = (await h.request('POST', '/sgx/merge', { sessionId: 'B', sourceA: 'S1', targetB: 'B' })).body
  assert.equal(repeated.ok, true)
  assert.equal(repeated.dedup, true)
})

test('cross-workspace subagent stays invisible and unmergeable', async () => {
  const h = createHarness()
  const graph = (await h.request('GET', '/sgx/graph?session=B')).body
  assert.ok(!graph.branches.some((b) => b.id === 'SX'))
  const denied = (await h.request('POST', '/sgx/merge', { sessionId: 'B', sourceA: 'SX', targetB: 'B' })).body
  assert.equal(denied.code, 'workspace-mismatch')
})

test('orphan subagent (dead parent chain) stays excluded', async () => {
  const h = createHarness()
  const graph = (await h.request('GET', '/sgx/graph?session=B')).body
  assert.ok(!graph.branches.some((b) => b.id === 'SO'))
  const denied = (await h.request('POST', '/sgx/merge', { sessionId: 'B', sourceA: 'SO', targetB: 'B' })).body
  assert.equal(denied.code, 'workspace-mismatch')
})

test('coordinator membership still replaces the closure', async () => {
  const h = createHarness()
  const service = h.services.get('sessionGraph')
  const coordinator = service.registerCoordinator({
    resolveMembership: ({ sessionId }) => ['R', 'A', 'B', 'S1', 'S2', 'SX'].includes(sessionId)
      ? { graphId: 'wf-1', label: 'workflow one', sessionIds: ['R', 'A', 'B'] }
      : null,
    guardMutation: () => ({ allow: true }),
  })
  const graph = await coordinator.graph('B')
  assert.deepEqual(graph.branches.map((b) => b.id).sort(), ['A', 'B', 'R'])
  coordinator.release()
})
