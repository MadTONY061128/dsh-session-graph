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
  const { layoutTree } = loadClientTestSurface()
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
})

test('client default background refresh is 120 seconds', () => {
  const source = readFileSync(new URL('../client-src.js', import.meta.url), 'utf8')
  assert.match(source, /timerCtx\.interval\([^]*120000\)/)
  assert.doesNotMatch(source, /timerCtx\.interval\([^]*30000\)/)
})
