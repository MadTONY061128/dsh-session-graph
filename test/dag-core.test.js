import test from 'node:test'
import assert from 'node:assert/strict'
import { activeInjectedMergeIds, assertDagInvariants, buildInformationDag } from '../host/dag-core.js'

function commit(key, owner, time) {
  return [key, { key, owner, time, endSeq: time, turn: time }]
}

function fixture(merges = [], extraA = []) {
  const commits = new Map([
    commit('root:0', 'root', 1),
    commit('A:1', 'A', 2),
    commit('B:1', 'B', 3),
    ...extraA,
  ])
  const branches = [
    { id: 'root', parentId: null, chain: ['root:0'], commitCount: 1 },
    { id: 'A', parentId: 'root', chain: ['root:0', 'A:1', ...extraA.map(([key]) => key)], commitCount: 1 + extraA.length },
    { id: 'B', parentId: 'root', chain: ['root:0', 'B:1'], commitCount: 1 },
  ]
  return buildInformationDag({ branches, commitByKey: commits, merges })
}

test('first merge absorbs the complete source ancestry', () => {
  const before = fixture()
  assert.deepEqual(before.delta(before.branchHeads.get('A'), before.branchHeads.get('B')), ['A:1'])
  const merge = { id: 'm1', key: 'mg:m1', sourceA: 'A', targetB: 'B', sourceHeadKey: 'A:1', targetParentKey: 'B:1', headBeforeB: 'B:1', createdAt: 4, injected: true }
  const after = fixture([merge])
  assert.equal(after.branchHeads.get('B'), 'mg:m1')
  assert.deepEqual(after.delta(after.branchHeads.get('A'), after.branchHeads.get('B')), [])
  assert.deepEqual(after.mergeBases('A:1', 'mg:m1'), ['A:1'])
  assert.deepEqual(activeInjectedMergeIds(after, 'mg:m1'), ['m1'])
  assertDagInvariants(after)
})

test('a later merge contains only commits added after the prior intersection', () => {
  const m1 = { id: 'm1', sourceA: 'A', targetB: 'B', sourceHeadKey: 'A:1', targetParentKey: 'B:1', createdAt: 4 }
  const dag = fixture([m1], [commit('A:2', 'A', 5)])
  assert.deepEqual(dag.delta(dag.branchHeads.get('A'), dag.branchHeads.get('B')), ['A:2'])
})

test('Git revert cancels injection without deleting merge ancestry', () => {
  const m1 = {
    id: 'm1', sourceA: 'A', targetB: 'B', sourceHeadKey: 'A:1', targetParentKey: 'B:1', createdAt: 4, injected: true,
    revert: { id: 'r1', key: 'rv:r1', parentKey: 'mg:m1', createdAt: 6 },
  }
  const dag = fixture([m1], [commit('A:2', 'A', 5)])
  const bHead = dag.branchHeads.get('B')
  assert.equal(bHead, 'rv:r1')
  assert.equal(dag.ancestors(bHead).has('A:1'), true)
  assert.deepEqual(dag.delta(dag.branchHeads.get('A'), bHead), ['A:2'])
  assert.deepEqual(activeInjectedMergeIds(dag, bHead), [])
})

test('a transitive merge prevents the same source information from being merged again', () => {
  const commits = new Map([
    commit('root:0', 'root', 1), commit('A:1', 'A', 2), commit('C:1', 'C', 3), commit('B:1', 'B', 4),
  ])
  const branches = [
    { id: 'root', parentId: null, chain: ['root:0'], commitCount: 1 },
    { id: 'A', parentId: 'root', chain: ['root:0', 'A:1'], commitCount: 1 },
    { id: 'C', parentId: 'root', chain: ['root:0', 'C:1'], commitCount: 1 },
    { id: 'B', parentId: 'root', chain: ['root:0', 'B:1'], commitCount: 1 },
  ]
  const merges = [
    { id: 'ac', sourceA: 'A', targetB: 'C', sourceHeadKey: 'A:1', targetParentKey: 'C:1', createdAt: 5 },
    { id: 'cb', sourceA: 'C', targetB: 'B', sourceHeadKey: 'mg:ac', targetParentKey: 'B:1', createdAt: 6 },
  ]
  const dag = buildInformationDag({ branches, commitByKey: commits, merges })
  assert.deepEqual(dag.delta(dag.branchHeads.get('A'), dag.branchHeads.get('B')), [])
  assertDagInvariants(dag)
})

test('criss-cross history returns every maximal common ancestor', () => {
  const commits = new Map([
    commit('root:0', 'root', 1), commit('A:1', 'A', 2), commit('B:1', 'B', 3),
  ])
  const branches = [
    { id: 'root', parentId: null, chain: ['root:0'], commitCount: 1 },
    { id: 'A', parentId: 'root', chain: ['root:0', 'A:1'], commitCount: 1 },
    { id: 'B', parentId: 'root', chain: ['root:0', 'B:1'], commitCount: 1 },
  ]
  const merges = [
    { id: 'ab', sourceA: 'A', targetB: 'B', sourceHeadKey: 'A:1', targetParentKey: 'B:1', createdAt: 4 },
    { id: 'ba', sourceA: 'B', targetB: 'A', sourceHeadKey: 'B:1', targetParentKey: 'A:1', createdAt: 5 },
  ]
  const dag = buildInformationDag({ branches, commitByKey: commits, merges })
  assert.deepEqual(dag.mergeBases('mg:ab', 'mg:ba'), ['A:1', 'B:1'])
  assertDagInvariants(dag)
})
