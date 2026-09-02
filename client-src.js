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
.sgx-head{display:flex;align-items:center;gap:8px;padding:6px 8px;flex:none;color:var(--dsw-alias-label-secondary);font-size:11px}
.sgx-meta{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sgx-grow{flex:1}
.sgx-btn{cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:8px;padding:1px 9px;font-size:11px;line-height:17px}
.sgx-btn:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.sgx-btn:disabled{opacity:.5;cursor:default}
.sgx-btn.sgx-main{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.sgx-net{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;touch-action:pan-y;padding:4px 2px}
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
var CONTENT_W = 230
var TIP_STUB = 14
var LANE_COLORS = ['#4f8ef7', '#39a97c', '#e3b341', '#b06fd8', '#e56a6a', '#50b8c0', '#f0885e', '#7f6be8']
function laneColor(i) { return LANE_COLORS[i % LANE_COLORS.length] }

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
  var ordered = branchIds.map(function (id) { return byId[id] }).sort(function (a, b) {
    return depthOf(a.id) - depthOf(b.id) || (a.createdAt - b.createdAt) || 0
  })
  var laneOf = {}
  ordered.forEach(function (b, i) { laneOf[b.id] = i })

  var keys = []
  var seen = {}
  ordered.forEach(function (b) {
    ;(b.chain || []).forEach(function (k) { if (!seen[k]) { seen[k] = 1; keys.push(k) } })
  })
  var commitMap = {}
  for (var i = 0; i < ((data && data.commits) || []).length; i++) commitMap[data.commits[i].key] = data.commits[i]
  keys.sort(function (a, b) {
    var ca = commitMap[a]
    var cb = commitMap[b]
    if (!ca || !cb) return 0
    return (cb.time - ca.time) || (cb.endSeq - ca.endSeq)
  })
  var rowOf = {}
  keys.forEach(function (k, i) { rowOf[k] = i })

  var geom = []
  ordered.forEach(function (b) {
    var chain = b.chain || []
    var own = b.commitCount || 0
    var ownKeys = own > 0 ? chain.slice(chain.length - own) : []
    var forkKey = null
    if (own > 0) forkKey = chain.length > own ? chain[chain.length - own - 1] : ownKeys[0]
    else forkKey = chain.length > 0 ? chain[chain.length - 1] : null
    var headKey = own > 0 ? ownKeys[ownKeys.length - 1] : forkKey
    geom.push({
      id: b.id,
      title: b.title,
      lane: laneOf[b.id],
      parentId: b.parentId,
      ownKeys: ownKeys,
      own: own,
      empty: own === 0,
      forkKey: forkKey,
      forkRow: forkKey !== null ? rowOf[forkKey] : -1,
      headRow: headKey !== null ? rowOf[headKey] : -1,
    })
  })
  return {
    ordered: ordered,
    laneOf: laneOf,
    keys: keys,
    rowOf: rowOf,
    commitMap: commitMap,
    geom: geom,
    lanes: ordered.length,
    rows: keys.length,
  }
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

  var fetchGraph = function (sessionId) {
    return fetch('/sgx/graph?session=' + encodeURIComponent(sessionId)).then(function (r) { return r.json() })
  }
  var postSummarize = function (payload) {
    return fetch('/sgx/summarize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(function (r) { return r.json() })
  }

  // pending checkout jump: consumed by the header scroll watcher.
  var jump = { target: null }

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
      setState(function (s) { return { data: s.data, error: null, loading: true } })
      fetchGraph(sessionId).then(function (data) {
        setState({ data: data, error: data && data.error ? data.error : null, loading: false })
      }).catch(function (e) {
        setState({ data: null, error: String((e && e.message) || e), loading: false })
      })
    }, [sessionId])

    React.useEffect(function () {
      var alive = true
      if (visible) refresh()
      if (!timerCtx) return
      var stop = timerCtx.interval(function () { if (alive && visible) refresh() }, 30000)
      return function () { alive = false; stop() }
    }, [refresh, visible, timerCtx])

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
    var lanes = L ? L.lanes : 0
    var rows = L ? L.rows : 0
    var width = PAD_X * 2 + lanes * LANE_W + CONTENT_W
    var laneEndX = PAD_X + lanes * LANE_W
    var height = LABEL_H + rows * ROW_H + PAD_X + 6
    var laneX = function (i) { return PAD_X + i * LANE_W + LANE_W / 2 }
    var rowY = function (i) { return LABEL_H + i * ROW_H + ROW_H / 2 + 4 }

    // jump into another session, keeping the Git 图谱 card open there
    var prepareTargetSession = function (targetId) {
      if (!bsService || !bsService.openTab) return
      if (props.store && typeof props.store.reduceFor === 'function') {
        try {
          props.store.reduceFor(targetId, function (draft) { draft.panelOpen = true })
        } catch (e) { /* ignore */ }
      }
      try { bsService.openTab({ type: TAB_ID }, { sessionId: targetId }) } catch (e) { /* ignore */ }
    }
    var openCommit = function (c) {
      jump.target = { sessionId: c.sessionId, turn: c.turn, userSeq: c.userSeq }
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

    // ---------- svg children ----------
    var lanePaths = []
    var commitGroups = []
    var tipGroups = []

    L.geom.forEach(function (g) {
      if (g.empty || g.forkRow < 0 || g.headRow < 0) return
      var lx = laneX(g.lane)
      var ly = rowY(g.forkRow)
      var headY = rowY(g.headRow)
      var color = laneColor(g.lane)
      var parentLane = g.parentId !== null && L.laneOf[g.parentId] !== undefined ? L.laneOf[g.parentId] : null
      var d
      if (parentLane !== null) {
        var px = laneX(parentLane)
        d = 'M ' + px + ' ' + ly + ' L ' + (lx - 5) + ' ' + ly + ' Q ' + lx + ' ' + ly + ' ' + lx + ' ' + (ly - 5) + ' L ' + lx + ' ' + headY
      } else {
        d = 'M ' + lx + ' ' + ly + ' L ' + lx + ' ' + headY
      }
      lanePaths.push({ d: d, color: color })
    })

    L.keys.forEach(function (k) {
      var c = L.commitMap[k]
      if (!c) return
      var ownerLane = L.laneOf[c.sessionId]
      if (ownerLane === undefined) return
      var dx = laneX(ownerLane)
      var dy = rowY(L.rowOf[k])
      var dcolor = laneColor(ownerLane)
      var selected = selKey === k
      commitGroups.push(React.createElement('g', { key: k, className: 'sgx-cg', style: { cursor: 'pointer' }, onClick: function () { setSelKey(k) } },
        React.createElement('circle', { cx: dx, cy: dy, r: 8, fill: 'transparent' }),
        selected && React.createElement('circle', { cx: dx, cy: dy, r: 8, fill: 'none', stroke: 'var(--dsw-alias-brand-primary)', strokeWidth: 2 }),
        React.createElement('circle', { cx: dx, cy: dy, r: 4.5, fill: dcolor, stroke: 'var(--dsw-alias-bg-overlay)', strokeWidth: 1 }),
        React.createElement('text', { x: laneEndX + 10, y: dy + 4, fontSize: 11.5, fill: 'var(--dsw-alias-label-secondary)', style: { cursor: 'pointer' } }, truncate(c.title, 30))))
    })

    // empty-branch tip markers: clickable hollow ring at the fork point
    L.geom.forEach(function (g) {
      if (!g.empty || g.forkRow < 0) return
      var lx = laneX(g.lane)
      var ly = rowY(g.forkRow)
      var ty = ly - TIP_STUB - 3
      var color = laneColor(g.lane)
      var parentLane = g.parentId !== null && L.laneOf[g.parentId] !== undefined ? L.laneOf[g.parentId] : null
      var d = null
      if (parentLane !== null) {
        var px = laneX(parentLane)
        d = 'M ' + px + ' ' + ly + ' L ' + (lx - 5) + ' ' + ly + ' Q ' + lx + ' ' + ly + ' ' + lx + ' ' + (ly - 5) + ' L ' + lx + ' ' + ty
      }
      if (d) lanePaths.push({ d: d, color: color })
      var tipKey = '__tip__' + g.id
      var forkCommit = g.forkKey ? L.commitMap[g.forkKey] : null
      var selected = selKey === tipKey
      tipGroups.push(React.createElement('g', { key: tipKey, className: 'sgx-tip', style: { cursor: 'pointer' }, onClick: function () { setSelKey(tipKey) } },
        React.createElement('circle', { cx: lx, cy: ty, r: 8, fill: 'transparent' }),
        React.createElement('circle', { cx: lx, cy: ty, r: 5, fill: 'none', stroke: color, strokeWidth: 2 }),
        selected && React.createElement('circle', { cx: lx, cy: ty, r: 8, fill: 'none', stroke: 'var(--dsw-alias-brand-primary)', strokeWidth: 2 }),
        React.createElement('circle', { cx: lx, cy: ty, r: 1.8, fill: color }),
        forkCommit && React.createElement('text', { x: laneEndX + 10, y: ty + 4, fontSize: 11.5, fill: 'var(--dsw-alias-label-secondary)', style: { cursor: 'pointer' } }, '新分支 · ' + truncate(g.title, 22))))
    })

    // ---------- selection / detail ----------
    var sel = null
    if (selKey !== null && L) {
      if (selKey.indexOf('__tip__') === 0) {
        var gTip = null
        for (var gi = 0; gi < L.geom.length; gi++) if ('__tip__' + L.geom[gi].id === selKey) { gTip = L.geom[gi]; break }
        var fc = gTip && gTip.forkKey ? L.commitMap[gTip.forkKey] : null
        if (gTip && fc) sel = { kind: 'tip', branchTitle: gTip.title, branchId: gTip.id, commit: fc }
      } else {
        var cSel = L.commitMap[selKey]
        if (cSel) sel = { kind: 'commit', commit: cSel }
      }
    }
    var detail = null
    if (sel) {
      var cm = sel.commit
      var ownerBranch = null
      for (var oi = 0; oi < data.branches.length; oi++) if (data.branches[oi].id === cm.sessionId) { ownerBranch = data.branches[oi]; break }
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
          ownerBranch && React.createElement('button', { className: 'sgx-btn', onClick: function () { sessionsSvc && sessionsSvc.open(ownerBranch.id) } }, '打开分支：' + truncate(ownerBranch.title, 16))))
    }

    return React.createElement('div', { className: 'sgx-tab' },
      React.createElement('div', { className: 'sgx-head' },
        React.createElement('span', { className: 'sgx-meta' }, data.workspace.title + ' · ' + data.branches.length + ' 分支 / ' + data.commits.length + ' 提交'),
        React.createElement('span', { className: 'sgx-grow' }),
        React.createElement('button', { className: 'sgx-btn', disabled: !!busy, onClick: function () { refresh() } }, state.loading ? '刷新…' : '刷新')),
      trees.length > 1 && React.createElement('div', { className: 'sgx-tabsBar' }, trees.map(function (t, ti) {
        return React.createElement('button', { key: t.rootId, className: 'sgx-tree' + (t.rootId === activeTree ? ' sgx-cur' : ''), onClick: function () { setTreeSel(t.rootId) }, title: t.rootTitle + ' · ' + t.branches.length + ' 分支' },
          React.createElement('span', { className: 'sgx-tdot', style: { background: laneColor(ti) } }),
          React.createElement('span', { className: 'sgx-ttext' }, t.rootTitle))
      })),
      React.createElement('div', { className: 'sgx-net' },
        React.createElement('svg', { width: width, height: height, viewBox: '0 0 ' + width + ' ' + height },
          lanePaths.map(function (lp, i) { return React.createElement('path', { key: 'lp' + i, d: lp.d, fill: 'none', stroke: lp.color, strokeWidth: 2, opacity: 0.9 }) }),
          tipGroups,
          commitGroups)),
      detail,
      React.createElement('div', { className: 'sgx-note' }, '点击节点显示详情（checkout 进入该节点会话位置）；分叉与原分支共享分叉前最后一个提交，最新提交在顶部。'))
  }

  // ------------------------------------------------------------------
  // Header entry: button (opens the side-card tab) + checkout scroll watcher
  // ------------------------------------------------------------------
  function HeaderEntry(props) {
    var sessionId = props.sessionId
    var useSession = props.useSession
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
          clear = timerCtx.timeout(function () { scroll(); jump.target = null }, 900)
          return
        }
        if (++tries >= 24) { finished = true; return }
        clear = timerCtx.timeout(step, 180)
      }
      clear = timerCtx.timeout(step, 150)
      return function () { finished = true; if (clear) clear() }
    }, [anchorKey])
    return React.createElement('button', {
      type: 'button',
      className: 'sgx-entry',
      title: '在右侧边栏打开 Git 图谱（branch=会话，commit=一轮请求+完成）',
      onClick: function () {
        if (bsService && bsService.openTab) {
          if (sessionId) bsService.openTab({ type: TAB_ID }, { sessionId: sessionId })
          else bsService.openTab({ type: TAB_ID })
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
