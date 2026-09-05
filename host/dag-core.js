/**
 * Pure session-information DAG primitives.
 *
 * Branches remain a native fork tree. Merge/revert operations form a separate
 * append-only DAG whose edges point from causal parent to child.
 */

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

function ownKeysOf(branch) {
  const chain = Array.isArray(branch.chain) ? branch.chain : []
  const own = Math.max(0, Number(branch.commitCount) || 0)
  return own > 0 ? chain.slice(Math.max(0, chain.length - own)) : []
}

function forkKeyOf(branch) {
  const chain = Array.isArray(branch.chain) ? branch.chain : []
  const own = Math.max(0, Number(branch.commitCount) || 0)
  if (chain.length === 0) return null
  if (own > 0) return chain.length > own ? chain[chain.length - own - 1] : null
  return chain[chain.length - 1]
}

function eventOrder(a, b) {
  const time = (Number(a.time) || 0) - (Number(b.time) || 0)
  if (time) return time
  const rank = { commit: 0, merge: 1, revert: 2 }
  const kind = (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9)
  if (kind) return kind
  const order = (Number(a.order) || 0) - (Number(b.order) || 0)
  return order || String(a.key).localeCompare(String(b.key))
}

/**
 * Build a deterministic information DAG.
 *
 * @param {{branches:Array, commitByKey:Map, merges:Array}} input
 */
export function buildInformationDag(input) {
  const branches = Array.isArray(input.branches) ? input.branches : []
  const commitByKey = input.commitByKey instanceof Map ? input.commitByKey : new Map()
  const merges = Array.isArray(input.merges) ? input.merges : []
  const nodes = new Map()
  const parents = new Map()
  const eventsByBranch = new Map(branches.map((b) => [b.id, []]))

  for (const branch of branches) {
    const events = eventsByBranch.get(branch.id)
    for (const key of ownKeysOf(branch)) {
      const c = commitByKey.get(key) || {}
      const node = {
        key,
        kind: 'commit',
        branchId: branch.id,
        time: Number(c.time) || 0,
        order: Number(c.endSeq ?? c.turn) || 0,
      }
      nodes.set(key, node)
      events.push(node)
    }
  }

  for (const merge of merges) {
    if (!merge || !eventsByBranch.has(merge.targetB)) continue
    const key = merge.key || ('mg:' + merge.id)
    const node = {
      key,
      kind: 'merge',
      branchId: merge.targetB,
      sourceA: merge.sourceA,
      targetB: merge.targetB,
      sourceHeadKey: merge.sourceHeadKey || null,
      targetParentKey: merge.targetParentKey || merge.headBeforeB || null,
      time: Number(merge.createdAt) || 0,
      order: Number(merge.causalOrder) || 0,
      record: merge,
    }
    nodes.set(key, node)
    eventsByBranch.get(merge.targetB).push(node)

    if (merge.revert && merge.revert.id) {
      const revertKey = merge.revert.key || ('rv:' + merge.revert.id)
      const revert = {
        key: revertKey,
        kind: 'revert',
        branchId: merge.targetB,
        mergeId: merge.id,
        parentKey: merge.revert.parentKey || null,
        time: Number(merge.revert.createdAt) || (node.time + 1),
        order: Number(merge.revert.causalOrder) || 0,
        record: merge.revert,
      }
      nodes.set(revertKey, revert)
      eventsByBranch.get(merge.targetB).push(revert)
    }
  }

  const branchHeads = new Map()
  const nativeHeads = new Map()
  for (const branch of branches) {
    const events = eventsByBranch.get(branch.id).sort(eventOrder)
    let cursor = forkKeyOf(branch)
    for (const event of events) {
      if (event.kind === 'commit') {
        parents.set(event.key, cursor ? [cursor] : [])
        cursor = event.key
        nativeHeads.set(branch.id, event.key)
        continue
      }
      if (event.kind === 'merge') {
        // Schema-v2 records persist the exact target parent. Legacy records use
        // headBeforeB; cursor is the deterministic fallback during migration.
        const targetParent = event.targetParentKey || cursor
        parents.set(event.key, unique([targetParent, event.sourceHeadKey]))
        cursor = event.key
        continue
      }
      const parent = event.parentKey || cursor
      parents.set(event.key, parent ? [parent] : [])
      cursor = event.key
    }
    if (!nativeHeads.has(branch.id)) {
      const own = ownKeysOf(branch)
      nativeHeads.set(branch.id, own.length ? own[own.length - 1] : forkKeyOf(branch))
    }
    branchHeads.set(branch.id, cursor)
  }

  // Inherited native commits may not occur in their owner's event inventory
  // when the owner branch is outside a selected tree. Materialize safe stubs.
  for (const branch of branches) {
    const chain = Array.isArray(branch.chain) ? branch.chain : []
    for (let i = 0; i < chain.length; i++) {
      const key = chain[i]
      if (!nodes.has(key)) {
        const c = commitByKey.get(key) || {}
        nodes.set(key, { key, kind: 'commit', branchId: c.owner || branch.id, time: Number(c.time) || 0, order: Number(c.endSeq ?? c.turn) || 0 })
      }
      if (!parents.has(key)) parents.set(key, i > 0 ? [chain[i - 1]] : [])
    }
  }

  const ancestorCache = new Map()
  function ancestors(key) {
    if (!key) return new Set()
    if (ancestorCache.has(key)) return new Set(ancestorCache.get(key))
    const found = new Set()
    const visiting = new Set()
    function visit(k) {
      if (!k || found.has(k)) return
      if (visiting.has(k)) throw new Error('session-information DAG cycle at ' + k)
      visiting.add(k)
      for (const p of parents.get(k) || []) visit(p)
      visiting.delete(k)
      found.add(k)
    }
    visit(key)
    ancestorCache.set(key, found)
    return new Set(found)
  }

  function isAncestor(ancestor, descendant) {
    return ancestors(descendant).has(ancestor)
  }

  function delta(sourceHead, targetHead) {
    const source = ancestors(sourceHead)
    const target = ancestors(targetHead)
    const out = [...source].filter((key) => !target.has(key))
    out.sort((a, b) => eventOrder(nodes.get(a) || { key: a }, nodes.get(b) || { key: b }))
    return out
  }

  function mergeBases(leftHead, rightHead) {
    const left = ancestors(leftHead)
    const right = ancestors(rightHead)
    const common = [...left].filter((key) => right.has(key))
    return common.filter((candidate) => !common.some((other) => other !== candidate && isAncestor(candidate, other)))
      .sort((a, b) => eventOrder(nodes.get(a) || { key: a }, nodes.get(b) || { key: b }))
  }

  return { nodes, parents, branchHeads, nativeHeads, ancestors, isAncestor, delta, mergeBases }
}

export function activeInjectedMergeIds(dag, headKey) {
  const reachable = dag.ancestors(headKey)
  const canceled = new Set()
  for (const key of reachable) {
    const node = dag.nodes.get(key)
    if (node && node.kind === 'revert' && node.mergeId) canceled.add(node.mergeId)
  }
  const active = []
  for (const key of reachable) {
    const node = dag.nodes.get(key)
    if (!node || node.kind !== 'merge') continue
    const record = node.record || {}
    if (record.injected && !canceled.has(record.id)) active.push(record.id)
  }
  return active
}

export function assertDagInvariants(dag) {
  for (const [key, ps] of dag.parents) {
    const node = dag.nodes.get(key)
    if (!node) throw new Error('missing node ' + key)
    if (node.kind === 'merge' && ps.length !== 2) throw new Error('merge must have two parents: ' + key)
    if (node.kind !== 'merge' && ps.length > 1) throw new Error('non-merge has multiple parents: ' + key)
    dag.ancestors(key)
  }
  return true
}
