import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

function loadClientTestSurface() {
  const source = readFileSync(new URL('../client-src.js', import.meta.url), 'utf8')
  const exports = {}
  vm.runInNewContext(source, { require: () => ({}), exports, Set, Map, console })
  return exports.__test
}

test('client layout orders repeated merge and revert nodes on the target lane', () => {
  const { layoutTree, visualLanesFor } = loadClientTestSurface()
  const data = {
    branches: [
      { id: 'root', title: 'root', parentId: null, chain: ['root:0'], commitCount: 1, createdAt: 1 },
      { id: 'A', title: 'A', parentId: 'root', chain: ['root:0', 'A:1', 'A:2'], commitCount: 2, createdAt: 2 },
      { id: 'B', title: 'B', parentId: 'root', chain: ['root:0', 'B:1'], commitCount: 1, createdAt: 3 },
    ],
    commits: [
      { key: 'root:0', sessionId: 'root', time: 1, endSeq: 1, title: 'root' },
      { key: 'A:1', sessionId: 'A', time: 2, endSeq: 2, title: 'a1' },
      { key: 'B:1', sessionId: 'B', time: 3, endSeq: 3, title: 'b1' },
      { key: 'A:2', sessionId: 'A', time: 5, endSeq: 5, title: 'a2' },
    ],
    merges: [
      { id: 'm1', key: 'mg:m1', targetB: 'B', sourceA: 'A', targetParentKey: 'B:1', sourceHeadKey: 'A:1', time: 4, title: 'm1', status: 'reverted', revert: { id: 'r1', key: 'rv:r1', parentKey: 'mg:m1', time: 6 } },
      { id: 'm2', key: 'mg:m2', targetB: 'B', sourceA: 'A', targetParentKey: 'rv:r1', sourceHeadKey: 'A:2', time: 7, title: 'm2', status: 'active' },
    ],
  }
  const layout = layoutTree(data, 'root')
  assert.ok(layout.rowOf['mg:m2'] < layout.rowOf['rv:r1'])
  assert.ok(layout.rowOf['rv:r1'] < layout.rowOf['mg:m1'])
  assert.ok(layout.rowOf['mg:m1'] < layout.rowOf['B:1'])
  assert.equal(layout.mergeRows.length, 2)
  assert.equal(layout.revertRows.length, 1)
  for (const merge of layout.mergeRows) {
    assert.ok(merge.row < merge.sourceRow, `${merge.key} must render above its source head`)
    assert.ok(merge.row < merge.headBeforeRow, `${merge.key} must render above its target parent`)
  }
  const visual = visualLanesFor(layout)
  for (const merge of layout.mergeRows) {
    assert.ok(visual.nodeLane[merge.merge.sourceHeadKey] > visual.nodeLane[merge.key], `${merge.key} must flow left from its source head`)
  }
})

test('client moves only a conflicting source commit when permanent branch lanes cannot express a left merge', () => {
  const { visualLanesFor } = loadClientTestSurface()
  const layout = {
    lanes: 2,
    laneOf: { source: 0, target: 1 },
    commitMap: { 'source:1': { key: 'source:1', sessionId: 'source' } },
    rows: [
      { kind: 'merge', key: 'mg:1', targetB: 'target' },
      { kind: 'commit', key: 'source:1' },
    ],
    mergeRows: [{ key: 'mg:1', targetLane: 1, merge: { sourceHeadKey: 'source:1' } }],
  }
  const visual = visualLanesFor(layout)
  assert.equal(visual.nodeLane['mg:1'], 1)
  assert.equal(visual.nodeLane['source:1'], 2)
  assert.equal(visual.lanes, 3)
})

test('graph labels use viewport ellipsis and merge edges have no dash or arrow marker', () => {
  const source = readFileSync(new URL('../client-src.js', import.meta.url), 'utf8')
  assert.match(source, /\.sgx-label\{[^}]*text-overflow:ellipsis/)
  assert.match(source, /className: 'sgx-labels'/)
  assert.doesNotMatch(source, /strokeDasharray/)
  assert.doesNotMatch(source, /kind: 'arrow'/)
  assert.doesNotMatch(source, /truncate\(c\.title/)
  assert.doesNotMatch(source, /CONTENT_W/)
})

test('horizontal lane changes finish within one vertical grid cell', () => {
  const { compactUpwardSegment, compactForkSegment } = loadClientTestSurface()
  const segment = compactUpwardSegment({ x: 83, y: 200 }, { x: 23, y: 20 })
  assert.match(segment, /^ L 83 44 C /)
  assert.match(segment, /, 23 [\d.]+, 23 20$/)
  assert.equal(compactUpwardSegment({ x: 23, y: 200 }, { x: 23, y: 20 }), ' L 23 20')

  const fork = compactForkSegment({ x: 23, y: 200 }, { x: 53, y: 20 })
  assert.match(fork, /^ C 23 [\d.]+, 53 [\d.]+, 53 176 L 53 20$/)
  assert.equal(compactForkSegment({ x: 23, y: 200 }, { x: 23, y: 20 }), ' L 23 20')
})

test('client layout forks a zero-inheritance subagent from the parent commit', () => {
  const { layoutTree } = loadClientTestSurface()
  // A native subagent whose chain carries only its own commit (seedLength 0)
  // must fork at the parent's commit, not at itself.
  const data = {
    branches: [
      { id: 'root', title: 'root', parentId: null, chain: ['root:0'], commitCount: 1, createdAt: 1 },
      { id: 'S1', title: 's1', parentId: 'root', chain: ['S1:0'], commitCount: 1, createdAt: 2 },
      { id: 'S2', title: 's2', parentId: 'root', chain: ['S2:0'], commitCount: 1, createdAt: 3 },
    ],
    commits: [
      { key: 'root:0', sessionId: 'root', time: 1, endSeq: 1, title: 'root' },
      { key: 'S1:0', sessionId: 'S1', time: 2, endSeq: 1, title: 's1' },
      { key: 'S2:0', sessionId: 'S2', time: 3, endSeq: 1, title: 's2' },
    ],
    merges: [],
  }
  const layout = layoutTree(data, 'root')
  const rootRow = layout.rowOf['root:0']
  const g = {}
  layout.geom.forEach((x) => { g[x.id] = x })
  assert.equal(g.root.headRow, rootRow)
  // both subagents fork at the parent commit, each own commit sits above it
  assert.equal(g.S1.forkRow, rootRow)
  assert.equal(g.S2.forkRow, rootRow)
  assert.ok(g.S1.headRow < rootRow)
  assert.ok(g.S2.headRow < rootRow)
})

test('root branch gets a trunk line when child commits wedge between its own', () => {
  const { layoutTree, lanePathFor } = loadClientTestSurface()
  const data = {
    branches: [
      { id: 'root', title: 'root', parentId: null, chain: ['root:0', 'root:1', 'root:2'], commitCount: 3, createdAt: 1 },
      { id: 'C', title: 'c', parentId: 'root', chain: ['C:0'], commitCount: 1, createdAt: 2 },
    ],
    commits: [
      { key: 'root:0', sessionId: 'root', time: 1, endSeq: 1, title: 'r0' },
      { key: 'root:1', sessionId: 'root', time: 3, endSeq: 3, title: 'r1' },
      { key: 'root:2', sessionId: 'root', time: 5, endSeq: 5, title: 'r2' },
      { key: 'C:0', sessionId: 'C', time: 4, endSeq: 1, title: 'c0' },
    ],
    merges: [],
  }
  const L = layoutTree(data, 'root')
  const g = {}
  L.geom.forEach((x) => { g[x.id] = x })
  // C forks at the parent commit immediately before its own commit, wedging
  // between root's commits: root rows are split, so the trunk must span them.
  assert.ok(g.C.forkRow >= 0)
  assert.ok(g.root.headRow < g.root.tailRow)
  const rootPath = lanePathFor(g.root, L)
  assert.ok(/^M [\d.]+ [\d.]+ L [\d.]+ [\d.]+$/.test(rootPath))
  assert.ok(rootPath.indexOf('M ' + String(23) + ' ') === 0)
  const cPath = lanePathFor(g.C, L)
  assert.ok(cPath.indexOf('Q') >= 0)
})

test('a single-commit root draws no degenerate line', () => {
  const { layoutTree, lanePathFor } = loadClientTestSurface()
  const data = {
    branches: [{ id: 'root', title: 'root', parentId: null, chain: ['root:0'], commitCount: 1, createdAt: 1 }],
    commits: [{ key: 'root:0', sessionId: 'root', time: 1, endSeq: 1, title: 'root' }],
    merges: [],
  }
  const L = layoutTree(data, 'root')
  assert.equal(lanePathFor(L.geom[0], L), null)
})

test('client default background refresh is 120 seconds', () => {
  const source = readFileSync(new URL('../client-src.js', import.meta.url), 'utf8')
  assert.match(source, /timerCtx\.interval\([^]*120000\)/)
  assert.doesNotMatch(source, /timerCtx\.interval\([^]*30000\)/)
})
