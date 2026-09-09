/**
 * dsh-session-graph — Client half source v0.2 (browser bundle body).
 * build.mjs wraps this file into window.__ModuleLoader__.load({ id, factory }).
 *
 * v0.2:
 *  - 常驻右侧边栏：经 ctx.betterSidebar.registerTab 注册「Git 图谱」Tab（与现有
 *    dsh-better-sidebar 侧边栏同源，天然不双推；卡片开启即常驻，切换会话不卸载）。
 *  - 树形图：同一工作区一次只显示一棵树（顶部树切换），最新提交在顶；分叉 = 与原分支
 *    共享分叉前最后一个提交点位（肘形连接，参考 VSCode Git Branch，无 merge）。
 *  - 交互：点击节点才显示详情与 checkout（进入该节点会话位置）；悬停无副作用；
 *    仅滚轮控制图谱上下滚动（overscroll 限制）。
 *  - 空分支 tip：可点击（选中 → checkout 定位到分叉提交）。
 */

var React = require('react')

var CSS = `
.sgx-entry{cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:8px;padding:2px 8px;font-size:12px;line-height:18px}
.sgx-entry:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.sgx-tab{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;text-align:left}
.sgx-tabsBar{display:flex;flex-wrap:wrap;gap:6px;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.sgx-tree{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:11px;line-height:16px;max-width:200px}
.sgx-tree:hover{background:var(--dsw-alias-bg-layer-2)}
.sgx-tree .sgx-tdot{width:7px;height:7px;border-radius:50%;flex:none}
.sgx-tree.sgx-cur{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}
.sgx-ttext{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sgx-head{display:flex;align-items:center;flex-wrap:wrap;gap:6px;padding:6px 8px;flex:none;color:var(--dsw-alias-label-secondary);font-size:11px}
.sgx-meta{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sgx-grow{flex:1}
.sgx-btn{cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:8px;padding:1px 9px;font-size:11px;line-height:17px}
.sgx-btn:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.sgx-btn:disabled{opacity:.5;cursor:default}
.sgx-btn.sgx-main{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.sgx-net{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;touch-action:pan-y;padding:4px 2px}
.sgx-canvas{position:relative;width:100%}
.sgx-graph{position:absolute;left:0;top:0;overflow:visible}
.sgx-labels{position:absolute;top:0;right:6px;min-width:0}
.sgx-label{position:absolute;left:0;right:0;height:20px;box-sizing:border-box;border-radius:4px;padding:0 6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:20px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.sgx-label:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.sgx-label.sgx-current{background:rgba(86,129,210,0.18);color:var(--dsw-alias-label-primary)}
.sgx-detail{border-top:1px solid var(--dsw-alias-border-l1);padding:6px 8px;max-height:180px;overflow:auto;flex:none}
.sgx-dk{display:inline-block;font-size:10px;line-height:14px;border-radius:4px;padding:0 5px;margin-right:5px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);vertical-align:middle}
.sgx-dtitle{font-weight:600;margin:2px 0}
.sgx-dsum{color:var(--dsw-alias-label-secondary);white-space:pre-wrap}
.sgx-drow{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
.sgx-note{color:var(--dsw-alias-label-secondary);font-size:11px;padding:8px}
.sgx-err{color:var(--dsw-alias-state-error-primary);padding:6px 8px;font-size:11px}
`

function truncate(s, n) {
  var t = String(s || '')
  return t.length > n ? t.slice(0, n) + '…' : t
}

var LANE_W = 30
var ROW_H = 24
var PAD_X = 8
var LABEL_H = 2
var TOP_PAD = 14
var LANE_COLORS = ['#4f8ef7', '#39a97c', '#e3b341', '#b06fd8', '#e56a6a', '#50b8c0', '#f0885e', '#7f6be8']
function laneColor(i) { return LANE_COLORS[i % LANE_COLORS.length] }
var laneX = function (i) { return PAD_X + i * LANE_W + LANE_W / 2 }
var rowY = function (i) { return TOP_PAD + LABEL_H + i * ROW_H + ROW_H / 2 + 4 }

// One branch's lane line: the junction elbow (from the parent lane at the fork
// row) plus the vertical run to the branch head. The root branch has no fork
// row; it gets a straight trunk through its own commit block (oldest row ->
// newest row), otherwise its commits render as unconnected dots whenever
// child branches wedge between them.
function lanePathFor(g, L) {
  if (g.empty || g.headRow < 0) return null
  var lx = laneX(g.lane)
  var headY = rowY(g.headRow)
  var parentLane = g.parentId !== null && L.laneOf[g.parentId] !== undefined ? L.laneOf[g.parentId] : null
  if (g.forkRow >= 0) {
    var ly = rowY(g.forkRow)
    if (parentLane !== null) {
      var px = laneX(parentLane)
      return 'M ' + px + ' ' + ly + ' L ' + (lx - 5) + ' ' + ly + ' Q ' + lx + ' ' + ly + ' ' + lx + ' ' + (ly - 5) + ' L ' + lx + ' ' + headY
    }
    return 'M ' + lx + ' ' + ly + ' L ' + lx + ' ' + headY
  }
  if (g.tailRow >= 0 && g.tailRow !== g.headRow) return 'M ' + lx + ' ' + rowY(g.tailRow) + ' L ' + lx + ' ' + headY
  return null
}

function compactUpwardSegment(from, to) {
  if (from.x === to.x) return ' L ' + to.x + ' ' + to.y
  var distance = Math.max(0, from.y - to.y)
  var curveHeight = Math.min(ROW_H, distance)
  if (curveHeight <= 0) return ' L ' + to.x + ' ' + to.y
  var startY = to.y + curveHeight
  var d = from.y > startY ? (' L ' + from.x + ' ' + startY) : ''
  d += ' C ' + from.x + ' ' + (to.y + curveHeight * 0.68) + ', ' + to.x + ' ' + (to.y + curveHeight * 0.32) + ', ' + to.x + ' ' + to.y
  return d
}

function compactForkSegment(from, to) {
  if (from.x === to.x) return ' L ' + to.x + ' ' + to.y
  var distance = Math.max(0, from.y - to.y)
  var curveHeight = Math.min(ROW_H, distance)
  if (curveHeight <= 0) return ' L ' + to.x + ' ' + to.y
  var endY = from.y - curveHeight
  var d = ' C ' + from.x + ' ' + (from.y - curveHeight * 0.32) + ', ' + to.x + ' ' + (from.y - curveHeight * 0.68) + ', ' + to.x + ' ' + endY
  if (endY > to.y) d += ' L ' + to.x + ' ' + to.y
  return d
}

function rootOf(branch, byId) {
  var b = branch
  var p = b.parentId
  var hops = 0
  while (p && byId[p] && hops < 64) { b = byId[p]; p = b.parentId; hops++ }
  return b.id
}

function groupTrees(data) {
  var branches = (data && data.branches) || []
  var byId = {}
  for (var i = 0; i < branches.length; i++) byId[branches[i].id] = branches[i]
  var trees = []
  var treeIndex = {}
  for (var i = 0; i < branches.length; i++) {
    var id = branches[i].id
    var r = rootOf(branches[i], byId)
    if (treeIndex[r] === undefined) {
      treeIndex[r] = trees.length
      trees.push({ rootId: r, rootTitle: byId[r].title, branches: [] })
    }
    trees[treeIndex[r]].branches.push(id)
  }
  return {
    trees: trees,
    byId: byId,
    treeOfSession: function (sessionId) {
      if (sessionId && byId[sessionId]) return rootOf(byId[sessionId], byId)
      return undefined
    },
  }
}

function orderBranchesForMerges(branches, merges) {
  var baseIndex = {}
  var byId = {}
  var indegree = {}
  var outgoing = {}
  branches.forEach(function (b, i) {
    baseIndex[b.id] = i
    byId[b.id] = b
    indegree[b.id] = 0
    outgoing[b.id] = []
  })
  ;(merges || []).forEach(function (m) {
    // Prefer a permanent lane order in which every source sits to the right
    // of its target. Cyclic histories are handled per-node below.
    if (!byId[m.targetB] || !byId[m.sourceA] || m.targetB === m.sourceA) return
    if (outgoing[m.targetB].indexOf(m.sourceA) >= 0) return
    outgoing[m.targetB].push(m.sourceA)
    indegree[m.sourceA]++
  })
  var ready = branches.filter(function (b) { return indegree[b.id] === 0 })
  ready.sort(function (a, b) { return baseIndex[a.id] - baseIndex[b.id] })
  var result = []
  while (ready.length) {
    var current = ready.shift()
    result.push(current)
    outgoing[current.id].forEach(function (id) {
      indegree[id]--
      if (indegree[id] === 0) {
        ready.push(byId[id])
        ready.sort(function (a, b) { return baseIndex[a.id] - baseIndex[b.id] })
      }
    })
  }
  if (result.length < branches.length) {
    branches.forEach(function (b) {
      if (result.indexOf(b) < 0) result.push(b)
    })
  }
  return result
}

function orderRowsForGraph(rows, commitMap, branchInfo, merges) {
  var idOf = function (cell) { return cell.kind === 'tip' ? '__tip__' + cell.branchId : cell.key }
  var byKey = {}
  var originalIndex = {}
  var indegree = {}
  var outgoing = {}
  rows.forEach(function (cell, i) {
    var id = idOf(cell)
    byKey[id] = cell
    originalIndex[id] = i
    indegree[id] = 0
    outgoing[id] = []
  })
  var addBefore = function (newer, older) {
    if (!byKey[newer] || !byKey[older] || newer === older) return
    if (outgoing[newer].indexOf(older) >= 0) return
    outgoing[newer].push(older)
    indegree[older]++
  }
  for (var branchId in branchInfo) {
    var info = branchInfo[branchId]
    var newestFirst = info.ownKeys.slice().reverse()
    for (var i = 0; i + 1 < newestFirst.length; i++) addBefore(newestFirst[i], newestFirst[i + 1])
    if (newestFirst.length && info.forkKey && newestFirst[newestFirst.length - 1] !== info.forkKey) {
      addBefore(newestFirst[newestFirst.length - 1], info.forkKey)
    }
    if (info.empty && info.forkKey) addBefore('__tip__' + branchId, info.forkKey)
  }
  ;(merges || []).forEach(function (m) {
    addBefore(m.key, m.targetParentKey || m.headBeforeB)
    addBefore(m.key, m.sourceHeadKey)
    if (m.revert && m.revert.key) addBefore(m.revert.key, m.revert.parentKey || m.key)
  })
  var timeOf = function (id) {
    var cell = byKey[id]
    if (!cell) return 0
    if (cell.kind === 'commit') return (commitMap[cell.key] && commitMap[cell.key].time) || 0
    if (cell.kind === 'tip') return (commitMap[branchInfo[cell.branchId].forkKey] && commitMap[branchInfo[cell.branchId].forkKey].time + 0.5) || 0
    return cell.time || 0
  }
  var ready = Object.keys(byKey).filter(function (id) { return indegree[id] === 0 })
  var sortReady = function () {
    ready.sort(function (a, b) { return (timeOf(b) - timeOf(a)) || (originalIndex[a] - originalIndex[b]) })
  }
  sortReady()
  var ordered = []
  var emitted = {}
  while (ready.length) {
    var id = ready.shift()
    emitted[id] = true
    ordered.push(byKey[id])
    outgoing[id].forEach(function (next) {
      indegree[next]--
      if (indegree[next] === 0) ready.push(next)
    })
    sortReady()
  }
  if (ordered.length < rows.length) {
    rows.forEach(function (cell) {
      var id = idOf(cell)
      if (!emitted[id]) ordered.push(cell)
    })
  }
  return ordered
}

function layoutTree(data, treeId) {
  var g = groupTrees(data)
  var branchIds = []
  for (var i = 0; i < g.trees.length; i++) if (g.trees[i].rootId === treeId) branchIds = g.trees[i].branches
  var byId = g.byId
  function depthOf(id) {
    var d = 0
    var p = byId[id].parentId
    var hops = 0
    while (p && byId[p] && hops < 64) { d++; p = byId[p].parentId; hops++ }
    return d
  }
  var baseOrdered = branchIds.map(function (id) { return byId[id] }).sort(function (a, b) {
    // 自适应 lane：有提交的分支靠左（贴近主干），空分支 tip 靠右，
    // 避免空 lane 夹在中间造成"未连接"的观感。
    var ea = (a.commitCount || 0) > 0 ? 0 : 1
    var eb = (b.commitCount || 0) > 0 ? 0 : 1
    return (ea - eb) || (depthOf(a.id) - depthOf(b.id)) || (a.createdAt - b.createdAt) || 0
  })
  var merges = (data && data.merges) || []
  var ordered = orderBranchesForMerges(baseOrdered, merges)
  var laneOf = {}
  ordered.forEach(function (b, i) { laneOf[b.id] = i })

  var commitMap = {}
  for (var i = 0; i < ((data && data.commits) || []).length; i++) commitMap[data.commits[i].key] = data.commits[i]

  // Per-branch commit inventory (chain = [shared..., own...]).
  var branchInfo = {}
  ordered.forEach(function (b) {
    var chain = b.chain || []
    var own = b.commitCount || 0
    var ownKeys = own > 0 ? chain.slice(chain.length - own) : []
    branchInfo[b.id] = { ownKeys: ownKeys.slice(), forkKey: null, empty: own === 0, own: own }
  })

  // Fork point: normally the last shared ancestor in `chain`. A fork created
  // with zero inherited commits (e.g. a native subagent whose seedLength is 0)
  // carries NO shared ancestor, so `chain.length <= own`; that branch's fork
  // point cannot come from its own chain and must be derived from the parent
  // branch — the parent commit that immediately precedes the child's first own
  // commit. Without this, the branch is treated as forking from itself.
  function deriveForkKey(branchId) {
    var b = byId[branchId]
    if (!b || !b.parentId) return null
    var info = branchInfo[branchId]
    if (!info) return null
    var refTime = -1
    if (info.own > 0) {
      var ownC = info.ownKeys.map(function (k) { return commitMap[k] }).filter(Boolean)
      ownC.sort(function (x, y) { return (x.time - y.time) || (x.endSeq - y.endSeq) })
      if (ownC.length) { refTime = ownC[0].time }
    } else {
      refTime = Number(b.createdAt) || 0
    }
    var parent = byId[b.parentId]
    var pInfo = parent ? branchInfo[parent.id] : null
    if (!pInfo) return null
    var cand = pInfo.ownKeys.map(function (k) { return commitMap[k] }).filter(Boolean)
    var best = null
    cand.forEach(function (c) {
      if (c.time <= refTime && (!best || (c.time > best.time) || (c.time === best.time && c.endSeq > best.endSeq))) best = c
    })
    if (!best && cand.length) {
      cand.sort(function (x, y) { return (x.time - y.time) || (x.endSeq - y.endSeq) })
      best = cand[0]
    }
    return best ? best.key : null
  }
  ordered.forEach(function (b) {
    var chain = b.chain || []
    var info = branchInfo[b.id]
    var forkKey = null
    if (info.own > 0 && chain.length > info.own) forkKey = chain[chain.length - info.own - 1]
    else if (info.own === 0 && chain.length > 0) forkKey = chain[chain.length - 1]
    else forkKey = deriveForkKey(b.id)
    info.forkKey = forkKey
  })

  // Row construction: one CELL per element. The root's native commits seed
  // the rows (newest first). Each child branch inserts its own commits as a
  // contiguous block DIRECTLY ABOVE its fork commit (and empty branches
  // insert one tip cell there), so no own commit can ever land below its
  // junction (time anomalies included) and every cell holds exactly one
  // element.
  var rows = [] // { kind: 'commit', key } | { kind: 'tip', branchId }
  var rowIndex = {} // commit key -> row index (kept in sync while placing)
  var bumpAfter = function (at) {
    for (var k in rowIndex) if (rowIndex[k] >= at) rowIndex[k]++
  }
  var place = function (branchId) {
    var info = branchInfo[branchId]
    if (!info) return
    var at = info.forkKey !== null && rowIndex[info.forkKey] !== undefined ? rowIndex[info.forkKey] : rows.length
    var own = info.ownKeys.slice()
    own.sort(function (a, b) {
      var ca = commitMap[a]
      var cb = commitMap[b]
      if (!ca || !cb) return 0
      return (cb.time - ca.time) || (cb.endSeq - ca.endSeq)
    })
    // oldest first so the final order directly above the junction is
    // [newest ... oldest, junction]
    for (var i2 = own.length - 1; i2 >= 0; i2--) {
      rows.splice(at, 0, { kind: 'commit', key: own[i2] })
      bumpAfter(at)
      rowIndex[own[i2]] = at
    }
    if (info.empty && info.forkKey !== null) {
      rows.splice(at, 0, { kind: 'tip', branchId: branchId })
      bumpAfter(at)
    }
  }
  ordered.forEach(function (b) {
    if (b.parentId === null) {
      var rootOwn = branchInfo[b.id].ownKeys.slice()
      rootOwn.sort(function (a, b2) {
        var ca = commitMap[a]
        var cb = commitMap[b2]
        if (!ca || !cb) return 0
        return (cb.time - ca.time) || (cb.endSeq - ca.endSeq)
      })
      rootOwn.forEach(function (k) {
        rows.push({ kind: 'commit', key: k })
        rowIndex[k] = rows.length - 1
      })
    }
  })
  ordered.forEach(function (b) { if (b.parentId !== null) place(b.id) })

  var rowOf = rowIndex

  // DAG operation cells: place merge/revert directly above their persisted
  // target parent. Processing oldest-first makes repeated merges and Git
  // reverts become a real causal chain rather than decorative rows.
  var mergeRows = []
  var revertRows = []
  var operations = []
  merges.forEach(function (m) {
    operations.push({ kind: 'merge', key: m.key, time: m.time || 0, targetB: m.targetB, parentKey: m.targetParentKey || m.headBeforeB, merge: m })
    if (m.revert && m.revert.key) operations.push({ kind: 'revert', key: m.revert.key, time: m.revert.time || 0, targetB: m.targetB, parentKey: m.revert.parentKey || m.key, merge: m, revert: m.revert })
  })
  operations.sort(function (a, b) { return (a.time || 0) - (b.time || 0) || String(a.key).localeCompare(String(b.key)) }).forEach(function (op) {
    if (laneOf[op.targetB] === undefined) return
    var at = rowOf[op.parentKey] !== undefined ? rowOf[op.parentKey] : rows.length
    rows.splice(at, 0, op)
    bumpAfter(at)
    rowOf[op.key] = at
    if (op.kind === 'merge') mergeRows.push({ key: op.key, merge: op.merge })
    else revertRows.push({ key: op.key, merge: op.merge, revert: op.revert })
  })
  rows = orderRowsForGraph(rows, commitMap, branchInfo, merges)
  rowIndex = {}
  rows.forEach(function (cell, row) {
    if (cell.kind !== 'tip') rowIndex[cell.key] = row
  })
  rowOf = rowIndex
  mergeRows.forEach(function (mr) {
    for (var r2 = 0; r2 < rows.length; r2++) {
      if (rows[r2].kind === 'merge' && rows[r2].key === mr.key) { mr.row = r2; break }
    }
    mr.targetLane = laneOf[mr.merge.targetB]
    mr.sourceLane = laneOf[mr.merge.sourceA] !== undefined ? laneOf[mr.merge.sourceA] : mr.targetLane
    mr.sourceRow = mr.merge.sourceHeadKey !== undefined && rowOf[mr.merge.sourceHeadKey] !== undefined ? rowOf[mr.merge.sourceHeadKey] : -1
    var targetParentKey = mr.merge.targetParentKey || mr.merge.headBeforeB
    mr.headBeforeRow = targetParentKey !== undefined && rowOf[targetParentKey] !== undefined ? rowOf[targetParentKey] : -1
  })
  revertRows.forEach(function (rr) {
    rr.row = rowOf[rr.key] !== undefined ? rowOf[rr.key] : -1
    rr.targetLane = laneOf[rr.merge.targetB]
    rr.parentRow = rr.revert.parentKey && rowOf[rr.revert.parentKey] !== undefined ? rowOf[rr.revert.parentKey] : -1
  })

  // geom 必须在 merge 单元格插入之后计算：merge 行会 bump 后续所有行号，
  // 若先算 geom（forkRow/headRow/tipRow），lane 线与节点就会整体错位。
  var geom = []
  ordered.forEach(function (b) {
    var info = branchInfo[b.id]
    var forkRow = info.forkKey !== null && rowOf[info.forkKey] !== undefined ? rowOf[info.forkKey] : -1
    var headKey = info.ownKeys.length > 0 ? info.ownKeys.slice().sort(function (a, c) {
      var ca = commitMap[a]
      var cc = commitMap[c]
      if (!ca || !cc) return 0
      return (cc.time - ca.time) || (cc.endSeq - ca.endSeq)
    })[0] : null
    var headRow = headKey !== null && rowOf[headKey] !== undefined ? rowOf[headKey] : -1
    var tailRow = -1
    for (var oi0 = 0; oi0 < info.ownKeys.length; oi0++) {
      var or0 = rowOf[info.ownKeys[oi0]]
      if (or0 !== undefined && or0 > tailRow) tailRow = or0
    }
    var tipRow = -1
    if (info.empty) {
      for (var r2 = 0; r2 < rows.length; r2++) {
        if (rows[r2].kind === 'tip' && rows[r2].branchId === b.id) { tipRow = r2; break }
      }
    }
    geom.push({
      id: b.id,
      title: b.title,
      lane: laneOf[b.id],
      parentId: b.parentId,
      ownKeys: info.ownKeys,
      own: info.ownKeys.length,
      empty: info.empty,
      forkKey: info.forkKey,
      forkRow: forkRow,
      headRow: headRow,
      tailRow: tailRow,
      tipRow: tipRow,
    })
  })

  return {
    ordered: ordered,
    laneOf: laneOf,
    keys: rows.map(function (r) { return r.kind === 'commit' ? r.key : null }).filter(Boolean),
    rows: rows,
    rowOf: rowOf,
    commitMap: commitMap,
    geom: geom,
    mergeRows: mergeRows,
    revertRows: revertRows,
    lanes: ordered.length,
    rowCount: rows.length,
  }
}

function visualLanesFor(layout) {
  var nodeLane = {}
  layout.rows.forEach(function (cell) {
    if (cell.kind === 'commit') {
      var commit = layout.commitMap[cell.key]
      if (commit && layout.laneOf[commit.sessionId] !== undefined) nodeLane[cell.key] = layout.laneOf[commit.sessionId]
    } else if (cell.kind === 'tip') {
      nodeLane['__tip__' + cell.branchId] = layout.laneOf[cell.branchId]
    } else if (cell.kind === 'merge' || cell.kind === 'revert') {
      nodeLane[cell.key] = layout.laneOf[cell.targetB]
    }
  })
  layout.mergeRows.forEach(function (mr) {
    var sourceKey = mr.merge.sourceHeadKey
    if (sourceKey === undefined || nodeLane[sourceKey] === undefined || mr.targetLane === undefined) return
    nodeLane[sourceKey] = Math.max(nodeLane[sourceKey], mr.targetLane + 1)
  })
  var laneCount = layout.lanes
  for (var key in nodeLane) laneCount = Math.max(laneCount, nodeLane[key] + 1)
  return { nodeLane: nodeLane, lanes: laneCount }
}

var inject = ['slots', 'sessions', 'timer', 'betterSidebar']

function apply(ctx) {
  // package-owned stylesheet
  var styleEl = document.createElement('style')
  styleEl.setAttribute('data-sgx', '1')
  styleEl.textContent = CSS
  document.head.appendChild(styleEl)
  ctx.effect(function () {
    return function () {
      var s = document.querySelector('style[data-sgx]')
      if (s) s.remove()
    }
  }, 'dsh-session-graph: styles')

  var bsService = null
  ctx.inject(['betterSidebar'], function (scope) {
    bsService = scope.betterSidebar
  })

  var TAB_ID = 'dsh-session-graph'

  var fetchGraph = function (sessionId, signal) {
    return fetch('/sgx/graph?session=' + encodeURIComponent(sessionId), { signal: signal }).then(function (r) { return r.json() })
  }
  var postJson = function (path, payload) {
    return fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(function (r) { return r.json() })
  }
  var postSummarize = function (payload) {
    return postJson('/sgx/summarize', payload)
  }

  // pending checkout jump: consumed by the header scroll watcher.
  // Reactive store: every setJump notifies subscribers so the watcher always
  // re-evaluates (fixes same-branch checkout being skipped ~50% of the time).
  var jump = { target: null, version: 0, subs: new Set() }
  var setJump = function (t) {
    jump.target = t
    jump.version++
    for (var f of jump.subs) f()
  }
  var subJump = function (f) { jump.subs.add(f); return function () { jump.subs.delete(f) } }
  var getJumpVersion = function () { return jump.version }
  var clearJump = function () { setJump(null) }

  // ------------------------------------------------------------------
  // Graph card body (betterSidebar tab component)
  // ------------------------------------------------------------------
  function GraphCard(props) {
    var scope = props.scope || {}
    var visible = !!props.visible
    var sessionId = scope.sessionId
    var tabCtx = props.ctx || ctx
    var timerRef = React.useRef(null)
    if (timerRef.current === null) {
      var tTimer = tabCtx.get('timer')
      if (tTimer) timerRef.current = tTimer
    }
    var timerCtx = timerRef.current
    var sessionsSvc = tabCtx.get('sessions')
    var requestRef = React.useRef({ seq: 0, controller: null })

    var statePair = React.useState({ data: null, error: null, loading: false })
    var state = statePair[0]
    var setState = statePair[1]
    var selPair = React.useState(null)
    var selKey = selPair[0]
    var setSelKey = selPair[1]
    var busyPair = React.useState(null)
    var busy = busyPair[0]
    var setBusy = busyPair[1]
    var treePair = React.useState(null)
    var treeSel = treePair[0]
    var setTreeSel = treePair[1]

    var refresh = React.useCallback(function () {
      if (!sessionId) { setState({ data: null, error: null, loading: false }); return }
      if (requestRef.current.controller) requestRef.current.controller.abort()
      var controller = typeof AbortController === 'function' ? new AbortController() : null
      var seq = ++requestRef.current.seq
      requestRef.current.controller = controller
      setState(function (s) { return { data: s.data, error: null, loading: true } })
      fetchGraph(sessionId, controller ? controller.signal : undefined).then(function (data) {
        if (seq !== requestRef.current.seq) return
        setState({ data: data, error: data && data.error ? data.error : null, loading: false })
      }).catch(function (e) {
        if (e && e.name === 'AbortError') return
        if (seq !== requestRef.current.seq) return
        setState({ data: null, error: String((e && e.message) || e), loading: false })
      })
    }, [sessionId])

    React.useEffect(function () {
      var alive = true
      // 卡片可见性不阻塞数据加载：面板收起时也在后台刷新，
      // 避免打开面板后长期停在「加载中…」。
      refresh()
      if (!timerCtx) return function () { alive = false; if (requestRef.current.controller) requestRef.current.controller.abort() }
      var stop = timerCtx.interval(function () { if (alive && document.visibilityState !== 'hidden') refresh() }, 120000)
      var onVisible = function () { if (alive && document.visibilityState === 'visible') refresh() }
      document.addEventListener('visibilitychange', onVisible)
      return function () {
        alive = false
        stop()
        document.removeEventListener('visibilitychange', onVisible)
        if (requestRef.current.controller) requestRef.current.controller.abort()
      }
    }, [refresh, timerCtx])

    // follow the current session's tree when the session changes
    React.useEffect(function () { setTreeSel(null) }, [sessionId])

    var data = state.data
    var activeTree = null
    var trees = []
    if (data && !data.error) {
      var g = groupTrees(data)
      trees = g.trees
      var curTree = treeSel
      if (curTree === null) curTree = g.treeOfSession(sessionId)
      if (curTree === undefined && trees.length > 0) curTree = trees[0].rootId
      activeTree = curTree
    }
    var L = activeTree ? layoutTree(data, activeTree) : null
    var visual = L ? visualLanesFor(L) : { nodeLane: {}, lanes: 0 }
    var lanes = visual.lanes
    var rowCount = L ? L.rowCount : 0

    // 当前会话所处提交 = 自身分支最新的 native commit（空分支则为 tip）
    var curInfo = null
    if (data && data.branches && L) {
      for (var cbi0 = 0; cbi0 < data.branches.length; cbi0++) {
        var cb0 = data.branches[cbi0]
        if (cb0.id !== sessionId) continue
        var own0 = (cb0.chain || []).slice(Math.max(0, (cb0.chain || []).length - (cb0.commitCount || 0)))
        var hk0 = null
        var ht0 = -1
        for (var ki0 = 0; ki0 < own0.length; ki0++) {
          var c20 = L.commitMap[own0[ki0]]
          if (c20 && (c20.time || 0) > ht0) { ht0 = c20.time; hk0 = own0[ki0] }
        }
        curInfo = { headKey: cb0.effectiveHeadKey || hk0, nativeHeadKey: hk0, empty: (cb0.commitCount || 0) === 0, branchId: cb0.id }
        break
      }
    }
    var laneEndX = PAD_X + lanes * LANE_W
    var graphWidth = laneEndX + PAD_X
    var canvasMinWidth = laneEndX + 96
    var height = TOP_PAD + LABEL_H + rowCount * ROW_H + PAD_X + 6

    // jump into another session, keeping the Git 图谱 card open there.
    // url seed = CONTENT open => the panel is expanded automatically if collapsed.
    var prepareTargetSession = function (targetId) {
      if (!bsService || !bsService.openTab) return
      if (props.store && typeof props.store.reduceFor === 'function') {
        try {
          props.store.reduceFor(targetId, function (draft) { draft.panelOpen = true })
        } catch (e) { /* ignore */ }
      }
      try { bsService.openTab({ type: TAB_ID, url: 'dsh-session-graph://focus', title: 'Git 图谱' }, { sessionId: targetId }) } catch (e) { /* ignore */ }
    }
    var openCommit = function (c) {
      setJump({ sessionId: c.sessionId, turn: c.turn, userSeq: c.userSeq })
      if (c.sessionId !== sessionId && sessionsSvc) {
        prepareTargetSession(c.sessionId)
        sessionsSvc.open(c.sessionId)
      }
    }
    var forkAt = function (c) {
      if (busy || !sessionsSvc) return
      setBusy('fork')
      sessionsSvc.fork({ sessionId: c.sessionId, atSeq: c.userSeq, increaseTitle: true }).then(function (childId) {
        prepareTargetSession(childId)
        sessionsSvc.open(childId)
      }).catch(function (e) {
        setState(function (s) { return { data: s.data, error: String((e && e.message) || e), loading: false } })
      }).finally(function () { setBusy(null) })
    }
    var summarize = function (c) {
      if (busy) return
      setBusy('sum')
      postSummarize({ sessionId: c.sessionId, turn: c.turn }).then(function (r) {
        if (r && r.ok) refresh()
      }).catch(function (e) {
        setState(function (s) { return { data: s.data, error: String((e && e.message) || e), loading: false } })
      }).finally(function () { setBusy(null) })
    }

    if (!data && !state.loading) {
      return React.createElement('div', { className: 'sgx-tab' }, React.createElement('div', { className: 'sgx-note' }, sessionId ? '加载中…' : '选择一个会话后查看它的 Git 图谱'))
    }
    if (!data) {
      return React.createElement('div', { className: 'sgx-tab' }, React.createElement('div', { className: 'sgx-note' }, state.loading || !sessionId ? '加载中…' : '请先选择一个会话'))
    }
    if (data.error) {
      return React.createElement('div', { className: 'sgx-tab' }, React.createElement('div', { className: 'sgx-err' }, '加载失败：' + data.error))
    }

    // ---------- svg children (one CELL per element) ----------
    var branchPaths = []
    var commitGroups = []
    var tipGroups = []
    var mergePaths = []
    var mergeGroups = []
    var revertPaths = []
    var revertGroups = []
    var labels = []
    var addLabel = function (key, row, text, current, onClick) {
      labels.push(React.createElement('div', {
        key: 'label-' + key,
        className: 'sgx-label' + (current ? ' sgx-current' : ''),
        style: { top: (rowY(row) - 10) + 'px' },
        title: text,
        onClick: onClick,
      }, text))
    }

    // Rails follow the visual position of every node. A source commit can
    // temporarily move right for a merge without changing its branch identity.
    L.geom.forEach(function (g) {
      var points = []
      var color = laneColor(g.lane)
      if (g.forkRow >= 0) {
        var anchorLane = visual.nodeLane[g.forkKey]
        if (anchorLane === undefined) anchorLane = g.parentId !== null ? L.laneOf[g.parentId] : g.lane
        points.push({ x: laneX(anchorLane), y: rowY(g.forkRow) })
      }
      for (var ri = L.rows.length - 1; ri >= 0; ri--) {
        var cell = L.rows[ri]
        var belongs = false
        var nodeKey = cell.key
        if (cell.kind === 'commit') belongs = L.commitMap[cell.key] && L.commitMap[cell.key].sessionId === g.id
        else if (cell.kind === 'tip') { belongs = cell.branchId === g.id; nodeKey = '__tip__' + cell.branchId }
        else belongs = cell.targetB === g.id
        if (!belongs) continue
        var nodeLane = visual.nodeLane[nodeKey]
        if (nodeLane === undefined) nodeLane = g.lane
        var point = { x: laneX(nodeLane), y: rowY(ri) }
        if (points.length && points[points.length - 1].y === point.y) points[points.length - 1] = point
        else points.push(point)
      }
      if (points.length < 2) return
      var d = 'M ' + points[0].x + ' ' + points[0].y
      for (var pi = 1; pi < points.length; pi++) {
        var from = points[pi - 1]
        var to = points[pi]
        d += (pi === 1 && g.parentId !== null) ? compactForkSegment(from, to) : compactUpwardSegment(from, to)
      }
      branchPaths.push({ d: d, color: color })
    })

    // The solid source rail always flows from lower-right into upper-left;
    // its bend alone conveys which branch was merged into which target.
    L.mergeRows.forEach(function (mr) {
      var bx = laneX(visual.nodeLane[mr.key] !== undefined ? visual.nodeLane[mr.key] : mr.targetLane)
      var my = rowY(mr.row)
      var bColor = laneColor(mr.targetLane)
      var sColor = laneColor(mr.sourceLane !== undefined ? mr.sourceLane : 0)
      var isCurrentMerge = curInfo && curInfo.headKey === mr.key
      if (mr.sourceRow >= 0) {
        var sx = laneX(visual.nodeLane[mr.merge.sourceHeadKey] !== undefined ? visual.nodeLane[mr.merge.sourceHeadKey] : mr.sourceLane)
        var sy = rowY(mr.sourceRow)
        mergePaths.push({ d: 'M ' + sx + ' ' + sy + compactUpwardSegment({ x: sx, y: sy }, { x: bx, y: my }), color: sColor })
      }
      mergeGroups.push(React.createElement('g', { key: mr.key, className: 'sgx-mg', opacity: mr.merge.status === 'reverted' ? 0.55 : 1, style: { cursor: 'pointer' }, onClick: function () { setSelKey(mr.key) } },
        React.createElement('circle', { cx: bx, cy: my, r: 9, fill: 'transparent' }),
        (selKey === mr.key) && React.createElement('circle', { cx: bx, cy: my, r: 9, fill: 'none', stroke: 'var(--dsw-alias-brand-primary)', strokeWidth: 2 }),
        isCurrentMerge && React.createElement('circle', { cx: bx, cy: my, r: 9, fill: 'none', stroke: bColor, strokeWidth: 2 }),
        React.createElement('rect', { x: bx - 4.5, y: my - 4.5, width: 9, height: 9, rx: 2, fill: bColor, stroke: 'var(--dsw-alias-bg-overlay)', strokeWidth: 1 })))
      addLabel(mr.key, mr.row, (mr.merge.status === 'reverted' ? '已撤销 · ' : '') + (mr.merge.title || '合并'), isCurrentMerge, function () { setSelKey(mr.key) })
    })

    L.revertRows.forEach(function (rr) {
      if (rr.row < 0) return
      var rx = laneX(visual.nodeLane[rr.key] !== undefined ? visual.nodeLane[rr.key] : rr.targetLane)
      var ry = rowY(rr.row)
      var isCurrentRevert = curInfo && curInfo.headKey === rr.key
      revertGroups.push(React.createElement('g', { key: rr.key, className: 'sgx-rv', style: { cursor: 'pointer' }, onClick: function () { setSelKey(rr.key) } },
        React.createElement('circle', { cx: rx, cy: ry, r: 10, fill: 'transparent' }),
        (selKey === rr.key || isCurrentRevert) && React.createElement('circle', { cx: rx, cy: ry, r: 9, fill: 'none', stroke: 'var(--dsw-alias-state-error-primary)', strokeWidth: 2 }),
        React.createElement('polygon', { points: rx + ',' + (ry - 5.5) + ' ' + (rx + 5.5) + ',' + ry + ' ' + rx + ',' + (ry + 5.5) + ' ' + (rx - 5.5) + ',' + ry, fill: 'var(--dsw-alias-state-error-primary)', stroke: 'var(--dsw-alias-bg-overlay)', strokeWidth: 1 })))
      addLabel(rr.key, rr.row, 'Git revert · ' + (rr.merge.title || rr.merge.id), isCurrentRevert, function () { setSelKey(rr.key) })
    })

    L.rows.forEach(function (cell, ri) {
      var y = rowY(ri)
      if (cell.kind === 'commit') {
        var k = cell.key
        var c = L.commitMap[k]
        if (!c) return
        var ownerLane = L.laneOf[c.sessionId]
        if (ownerLane === undefined) return
        var dx = laneX(visual.nodeLane[k] !== undefined ? visual.nodeLane[k] : ownerLane)
        var dcolor = laneColor(ownerLane)
        var selected = selKey === k
        var isCur = curInfo && curInfo.headKey === k
        commitGroups.push(React.createElement('g', { key: k, className: 'sgx-cg', style: { cursor: 'pointer' }, onClick: function () { setSelKey(k) } },
          React.createElement('circle', { cx: dx, cy: y, r: 8, fill: 'transparent' }),
          selected && React.createElement('circle', { cx: dx, cy: y, r: 8, fill: 'none', stroke: 'var(--dsw-alias-brand-primary)', strokeWidth: 2 }),
          isCur && React.createElement('circle', { cx: dx, cy: y, r: 8, fill: 'none', stroke: dcolor, strokeWidth: 2 }),
          React.createElement('circle', { cx: dx, cy: y, r: 4.5, fill: dcolor, stroke: 'var(--dsw-alias-bg-overlay)', strokeWidth: 1 })))
        addLabel(k, ri, c.title || ('# ' + c.turn), isCur, function () { setSelKey(k) })
      } else if (cell.kind === 'tip') {
        var g = null
        for (var ti = 0; ti < L.geom.length; ti++) if (L.geom[ti].id === cell.branchId) { g = L.geom[ti]; break }
        if (!g) return
        var tipKey2 = '__tip__' + g.id
        var lx2 = laneX(visual.nodeLane[tipKey2] !== undefined ? visual.nodeLane[tipKey2] : g.lane)
        var color2 = laneColor(g.lane)
        var forkCommit = g.forkKey ? L.commitMap[g.forkKey] : null
        var sel2 = selKey === tipKey2
        var isCurTip = curInfo && curInfo.empty && g.id === curInfo.branchId
        tipGroups.push(React.createElement('g', { key: tipKey2, className: 'sgx-tip', style: { cursor: 'pointer' }, onClick: function () { setSelKey(tipKey2) } },
          React.createElement('circle', { cx: lx2, cy: y, r: 8, fill: 'transparent' }),
          React.createElement('circle', { cx: lx2, cy: y, r: 5, fill: 'none', stroke: color2, strokeWidth: isCurTip ? 2.5 : 2 }),
          sel2 && React.createElement('circle', { cx: lx2, cy: y, r: 8, fill: 'none', stroke: 'var(--dsw-alias-brand-primary)', strokeWidth: 2 }),
          React.createElement('circle', { cx: lx2, cy: y, r: 1.8, fill: color2 })))
        if (forkCommit) addLabel(tipKey2, ri, '新分支 · ' + g.title, isCurTip, function () { setSelKey(tipKey2) })
      }
    })

    // ---------- selection / detail ----------
    var currentBranchId = null
    for (var cbi = 0; cbi < data.branches.length; cbi++) if (data.branches[cbi].id === sessionId) { currentBranchId = data.branches[cbi].id; break }

    var mergeErrText = function (code) {
      var map = {
        'self': '不能合并到自身',
        'already-contained': '目标分支已包含该分支（无需合并）',
        'unrelated': '两个分支不属于同一棵树',
        'no-effective-increment': '未提取到有效增量，未合并',
        'llm-failed': 'AI 萃取失败',
        'not-found': '分支不存在',
      }
      return map[code] || ('合并失败：' + code)
    }
    var mergeIntoCurrent = function (branchId) {
      if (busy || !currentBranchId) return
      setBusy('merge')
      postJson('/sgx/merge', { sessionId: sessionId, sourceA: branchId, targetB: currentBranchId }).then(function (r) {
        if (r && r.ok) refresh()
        else setState(function (s) { return { data: s.data, error: r && r.code ? mergeErrText(r.code) : '合并失败', loading: false } })
      }).catch(function (e) {
        setState(function (s) { return { data: s.data, error: String((e && e.message) || e), loading: false } })
      }).finally(function () { setBusy(null) })
    }
    var revertMerge = function (m) {
      if (busy) return
      setBusy('revert')
      postJson('/sgx/merge/revert', { sessionId: sessionId, mergeId: m.id }).then(function () { refresh() }).finally(function () { setBusy(null) })
    }
    var injectMerge = function (m) {
      if (busy) return
      setBusy('inject')
      postJson('/sgx/merge/inject', { sessionId: sessionId, mergeId: m.id }).then(function (r) {
        if (r && r.ok) { setState(function (s) { return { data: s.data, error: null, loading: false } }); refresh() }
        else setState(function (s) { return { data: s.data, error: r && r.code ? ('注入失败：' + r.code) : '注入失败', loading: false } })
      }).catch(function (e) {
        setState(function (s) { return { data: s.data, error: String((e && e.message) || e), loading: false } })
      }).finally(function () { setBusy(null) })
    }
    var uninjectMerge = function (m) {
      if (busy) return
      setBusy('uninject')
      postJson('/sgx/merge/uninject', { sessionId: sessionId, mergeId: m.id }).then(function (r) {
        if (r && r.ok) refresh()
        else setState(function (s) { return { data: s.data, error: r && r.code ? ('停止注入失败：' + r.code) : '停止注入失败', loading: false } })
      }).catch(function (e) {
        setState(function (s) { return { data: s.data, error: String((e && e.message) || e), loading: false } })
      }).finally(function () { setBusy(null) })
    }
    var toggleAutoSummary = function () {
      if (busy) return
      setBusy('settings')
      postJson('/sgx/settings', { sessionId: sessionId, autoSummary: !(data.privacy && data.privacy.autoSummary) }).then(function (r) {
        if (r && r.ok) refresh()
        else setState(function (s) { return { data: s.data, error: r && r.code ? ('设置失败：' + r.code) : '设置失败', loading: false } })
      }).finally(function () { setBusy(null) })
    }
    var purgePluginData = function () {
      if (busy || !window.confirm('清除当前 workspace 的摘要、合入记录和插件设置？原始 DSH 会话不会删除。')) return
      setBusy('purge')
      postJson('/sgx/purge', { sessionId: sessionId, summaries: true, merges: true, settings: true }).then(function (r) {
        if (r && r.ok) { setSelKey(null); refresh() }
        else setState(function (s) { return { data: s.data, error: r && r.code ? ('清理失败：' + r.code) : '清理失败', loading: false } })
      }).finally(function () { setBusy(null) })
    }

    var sel = null
    if (selKey !== null && L) {
      if (selKey.indexOf('__tip__') === 0) {
        var gTip = null
        for (var gi = 0; gi < L.geom.length; gi++) if ('__tip__' + L.geom[gi].id === selKey) { gTip = L.geom[gi]; break }
        var fc = gTip && gTip.forkKey ? L.commitMap[gTip.forkKey] : null
        if (gTip && fc) sel = { kind: 'tip', branchTitle: gTip.title, branchId: gTip.id, commit: fc }
      } else if (selKey.indexOf('mg:') === 0) {
        for (var mi = 0; mi < L.mergeRows.length; mi++) if (L.mergeRows[mi].key === selKey) { sel = { kind: 'merge', merge: L.mergeRows[mi].merge }; break }
      } else if (selKey.indexOf('rv:') === 0) {
        for (var ri2 = 0; ri2 < L.revertRows.length; ri2++) if (L.revertRows[ri2].key === selKey) { sel = { kind: 'revert', merge: L.revertRows[ri2].merge, revert: L.revertRows[ri2].revert }; break }
      } else {
        var cSel = L.commitMap[selKey]
        if (cSel) sel = { kind: 'commit', commit: cSel }
      }
    }
    var detail = null
    if (sel) {
      if (sel.kind === 'revert') {
        detail = React.createElement('div', { className: 'sgx-detail' },
          React.createElement('div', null,
            React.createElement('span', { className: 'sgx-dk' }, 'Git revert'),
            React.createElement('span', { className: 'sgx-dk' }, new Date(sel.revert.time || sel.revert.createdAt).toLocaleString())),
          React.createElement('div', { className: 'sgx-dtitle' }, '已撤销：' + (sel.merge.title || sel.merge.id)),
          React.createElement('div', { className: 'sgx-dsum' }, '合入祖先关系保留；对应动态上下文已停止生效，后续 merge 只共享来源分支的新增节点。'))
      } else if (sel.kind === 'merge') {
        var m = sel.merge
        var io = m.io || {}
        var ioRows = []
        var evTurnOf = function (p, i) {
          var ev = p.ground && p.ground.evidence ? String(p.ground.evidence) : ''
          var mm = ev.match(/(\d+)/)
          var n = mm ? parseInt(mm[1], 10) : 0
          var dt = m.diffTurns || []
          if (n >= 1 && n <= dt.length) return '#' + dt[n - 1]
          return dt[i] !== undefined ? '#' + dt[i] : ev
        }
        var bases = m.mergeBaseKeys || (m.lcaKey ? [m.lcaKey] : [])
        var baseText = bases.length ? bases.map(function (key) { return String(key).replace(/^[^:]+:/, '#') }).join('、') : '无'
        ioRows.push(React.createElement('div', { key: 'entry', className: 'sgx-dsum' }, '被合入分支入口：并入 ' + (m.diffTurns || []).length + ' 个差分提交' + ((m.diffTurns || []).length ? ('（' + m.diffTurns.map(function (t) { return '#' + t }).join('、') + '）') : '') + '；最近公共祖先集：' + baseText))
        if (io.purpose) ioRows.push(React.createElement('div', { key: 'p', className: 'sgx-dsum' }, '目的：' + io.purpose))
        ;(io.propositions || []).forEach(function (p, pi) {
          ioRows.push(React.createElement('div', { key: 'pp' + pi, className: 'sgx-dsum' }, '• [' + ((p.ground && p.ground.kind) || 'inferred') + '] ' + p.claim + '（来源 ' + evTurnOf(p, pi) + ' · ' + truncate(m.sourceTitle, 14) + '）'))
        })
        ;(io.negativeConstraints || []).forEach(function (n, ni) {
          ioRows.push(React.createElement('div', { key: 'nc' + ni, className: 'sgx-dsum' }, '⊗ 不可行：' + n.claim + '（来源 ' + evTurnOf(n, ni) + ' · ' + truncate(m.sourceTitle, 14) + '）'))
        })
        ;(io.openQuestions || []).forEach(function (q, qi) {
          ioRows.push(React.createElement('div', { key: 'oq' + qi, className: 'sgx-dsum' }, '? 待验证：' + q))
        })
        detail = React.createElement('div', { className: 'sgx-detail' },
          React.createElement('div', null,
            React.createElement('span', { className: 'sgx-dk' }, '合并'),
            React.createElement('span', { className: 'sgx-dk' }, truncate(m.sourceTitle, 16) + ' → ' + truncate(m.targetTitle, 16)),
            React.createElement('span', { className: 'sgx-dk' }, new Date(m.time).toLocaleString())),
          React.createElement('div', { className: 'sgx-dtitle' }, m.title || '合并'),
          ioRows,
          React.createElement('div', { className: 'sgx-drow' },
            React.createElement('button', { className: 'sgx-btn', disabled: !!busy || m.status === 'reverted', onClick: function () { m.injected ? uninjectMerge(m) : injectMerge(m) } }, busy === 'inject' ? '注入中…' : (busy === 'uninject' ? '停止中…' : (m.injected ? '停止动态注入' : '动态注入到受体'))),
            React.createElement('button', { className: 'sgx-btn', disabled: !!busy || m.status === 'reverted', onClick: function () { revertMerge(m) } }, busy === 'revert' ? '撤销中…' : (m.status === 'reverted' ? '已 Git revert' : 'Git revert'))))
      } else {
        var cm = sel.commit
        var ownerBranch = null
        for (var oi = 0; oi < data.branches.length; oi++) if (data.branches[oi].id === cm.sessionId) { ownerBranch = data.branches[oi]; break }
        var selBranchId = sel.kind === 'tip' ? sel.branchId : (ownerBranch ? ownerBranch.id : null)
        var canMerge = selBranchId !== null && currentBranchId !== null && selBranchId !== currentBranchId
        detail = React.createElement('div', { className: 'sgx-detail' },
          React.createElement('div', null,
            React.createElement('span', { className: 'sgx-dk' }, cm.sessionId === sessionId ? '当前分支' : (sel.kind === 'tip' ? '新分支 tip' : '提交')),
            React.createElement('span', { className: 'sgx-dk' }, '#' + cm.turn),
            React.createElement('span', { className: 'sgx-dk' }, new Date(cm.time).toLocaleString())),
          React.createElement('div', { className: 'sgx-dtitle' }, sel.kind === 'tip' ? ('新分支：' + sel.branchTitle) : (cm.title || ('# ' + cm.turn))),
          React.createElement('div', { className: 'sgx-dsum' }, cm.summary || (cm.userText ? '待生成 AI 要点：' + truncate(cm.userText, 120) : '待生成 AI 要点')),
          React.createElement('div', { className: 'sgx-drow' },
            React.createElement('button', { className: 'sgx-btn sgx-main', onClick: function () { openCommit(cm) } }, 'checkout'),
            React.createElement('button', { className: 'sgx-btn', disabled: !!busy, onClick: function () { forkAt(cm) } }, busy === 'fork' ? '分叉中…' : '在此分叉'),
            (cm.status !== 'ai') && React.createElement('button', { className: 'sgx-btn', disabled: !!busy, onClick: function () { summarize(cm) } }, busy === 'sum' ? '摘要中…' : (cm.status === 'fallback' ? '重试 AI 摘要' : 'AI 摘要')),
            canMerge && React.createElement('button', { className: 'sgx-btn', disabled: !!busy, onClick: function () { mergeIntoCurrent(selBranchId) } }, busy === 'merge' ? '合并中…' : '合并此分支到当前分支'),
            ownerBranch && React.createElement('button', { className: 'sgx-btn', onClick: function () { sessionsSvc && sessionsSvc.open(ownerBranch.id) } }, '打开分支：' + truncate(ownerBranch.title, 16))))
      }
    }

    return React.createElement('div', { className: 'sgx-tab' },
      React.createElement('div', { className: 'sgx-head' },
        React.createElement('span', { className: 'sgx-meta' }, data.workspace.title + ' · ' + data.branches.length + ' 分支 / ' + data.commits.length + ' 提交'),
        React.createElement('span', { className: 'sgx-grow' }),
        React.createElement('span', { className: 'sgx-meta', title: (data.privacy && data.privacy.provider) ? ('AI: ' + data.privacy.provider + '/' + data.privacy.model) : '未配置默认模型' }, (data.privacy && data.privacy.autoSummary) ? '自动摘要：开' : '自动摘要：关'),
        React.createElement('button', { className: 'sgx-btn', disabled: !!busy, onClick: toggleAutoSummary }, busy === 'settings' ? '保存…' : ((data.privacy && data.privacy.autoSummary) ? '关闭' : '启用')),
        React.createElement('button', { className: 'sgx-btn', disabled: !!busy, onClick: purgePluginData }, busy === 'purge' ? '清理…' : '清除数据'),
        React.createElement('button', { className: 'sgx-btn', disabled: !!busy, onClick: function () { refresh() } }, state.loading ? '刷新…' : '刷新')),
      trees.length > 1 && React.createElement('div', { className: 'sgx-tabsBar' }, trees.map(function (t, ti) {
        return React.createElement('button', { key: t.rootId, className: 'sgx-tree' + (t.rootId === activeTree ? ' sgx-cur' : ''), onClick: function () { setTreeSel(t.rootId) }, title: t.rootTitle + ' · ' + t.branches.length + ' 分支' },
          React.createElement('span', { className: 'sgx-tdot', style: { background: laneColor(ti) } }),
          React.createElement('span', { className: 'sgx-ttext' }, t.rootTitle))
      })),
      React.createElement('div', { className: 'sgx-net' },
        React.createElement('div', { className: 'sgx-canvas', style: { height: height + 'px', minWidth: canvasMinWidth + 'px' } },
          React.createElement('svg', { className: 'sgx-graph', width: graphWidth, height: height, viewBox: '0 0 ' + graphWidth + ' ' + height, 'aria-hidden': true },
            branchPaths.map(function (lp, i) { return React.createElement('path', { key: 'lp' + i, d: lp.d, fill: 'none', stroke: lp.color, strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', opacity: 0.9 }) }),
            mergePaths.map(function (mp, i) { return React.createElement('path', { key: 'mp' + i, d: mp.d, fill: 'none', stroke: mp.color, strokeWidth: 2, strokeLinecap: 'round', opacity: 0.95 }) }),
            revertPaths.map(function (rp, i) { return React.createElement('path', { key: 'rp' + i, d: rp.d, fill: 'none', stroke: 'var(--dsw-alias-state-error-primary)', strokeWidth: 1.5, opacity: 0.85 }) }),
            tipGroups,
            mergeGroups,
            revertGroups,
            commitGroups),
          React.createElement('div', { className: 'sgx-labels', style: { left: (laneEndX + 6) + 'px', height: height + 'px' } }, labels))),
      detail,
      React.createElement('div', { className: 'sgx-note' }, '点击节点显示详情（checkout 进入该节点会话位置）；分叉与原分支共享分叉前最后一个提交，最新提交在顶部；方形节点=合入，菱形节点=Git revert，向左上弯入的实线=合入方向，圆环=当前会话所处提交。动态注入不改写聊天历史，模型可用 session_graph_view / session_graph_read 溯源原文。'))
  }

  // ------------------------------------------------------------------
  // Header entry: button (opens the side-card tab) + checkout scroll watcher
  // ------------------------------------------------------------------
  function HeaderEntry(props) {
    var sessionId = props.sessionId
    var useSession = props.useSession
    var jumpVersion = React.useSyncExternalStore(subJump, getJumpVersion)
    var target = jump.target
    var turn = target && target.sessionId === sessionId ? target.turn : undefined
    var userSeq = target && target.sessionId === sessionId ? target.userSeq : undefined
    var anchorKey = useSession(function (s) {
      if (turn === undefined || turn === null) return null
      if (!s || !s.chat || !s.chat.locations) return null
      var keys = s.chat.locations.getTurn(turn)
      if (!keys || keys.length === 0) return null
      for (var i = 0; i < keys.length; i++) {
        var n = s.chat.nodes.get(keys[i])
        if (n && typeof n.anchorSeq === 'number' && n.anchorSeq === userSeq) return keys[i]
      }
      return keys[0]
    })
    React.useEffect(function () {
      if (anchorKey === null || anchorKey === undefined) return
      var timerCtx = ctx.get('timer')
      if (!timerCtx) return
      var tries = 0
      var finished = false
      var clear = null
      var scroll = function () {
        var nodes = document.querySelectorAll('[data-chat-anchor-key]')
        for (var i = 0; i < nodes.length; i++) {
          if (nodes[i].getAttribute('data-chat-anchor-key') === anchorKey) {
            try { nodes[i].scrollIntoView({ behavior: 'auto', block: 'center' }) } catch (e) { nodes[i].scrollIntoView() }
            return true
          }
        }
        return false
      }
      var step = function () {
        if (finished) return
        if (scroll()) {
          finished = true
          clear = timerCtx.timeout(function () { scroll(); clearJump() }, 900)
          return
        }
        if (++tries >= 24) { finished = true; return }
        clear = timerCtx.timeout(step, 180)
      }
      clear = timerCtx.timeout(step, 150)
      return function () { finished = true; if (clear) clear() }
    }, [anchorKey, jumpVersion])
    return React.createElement('button', {
      type: 'button',
      className: 'sgx-entry',
      title: '在右侧边栏打开 Git 图谱（branch=会话，commit=一轮请求+完成）',
      onClick: function () {
        if (bsService && bsService.openTab) {
          if (sessionId) bsService.openTab({ type: TAB_ID, url: 'dsh-session-graph://focus', title: 'Git 图谱' }, { sessionId: sessionId })
          else bsService.openTab({ type: TAB_ID, url: 'dsh-session-graph://focus', title: 'Git 图谱' })
        }
      },
    }, 'Git 图谱')
  }

  // ------------------------------------------------------------------
  // register: side-card tab + header button
  // ------------------------------------------------------------------
  ctx.inject(['slots'], function (scope) {
    scope.slots.inject('conversation.session.header.actions', function () {
      return scope.slots.register({ name: 'conversation.session.header.actions', id: 'git-graph', order: 30, label: 'Git 图谱' }, HeaderEntry)
    })
  })
  ctx.inject(['betterSidebar'], function (scope) {
    ctx.effect(function () {
      return scope.betterSidebar.registerTab({
        id: TAB_ID,
        title: 'Git 图谱',
        single: true,
        order: 30,
        component: function (props) { return React.createElement(GraphCard, props) },
      })
    }, 'dsh-session-graph: side-card tab')
  })
}

exports.inject = inject
exports.apply = apply
exports.__test = {
  groupTrees: groupTrees,
  layoutTree: layoutTree,
  lanePathFor: lanePathFor,
  compactUpwardSegment: compactUpwardSegment,
  compactForkSegment: compactForkSegment,
  orderBranchesForMerges: orderBranchesForMerges,
  orderRowsForGraph: orderRowsForGraph,
  visualLanesFor: visualLanesFor,
}
