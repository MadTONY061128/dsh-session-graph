window.__ModuleLoader__.load({
  id: "dsh-session-graph",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
/**
 * dsh-session-graph — Client half source (browser bundle body).
 * build.mjs wraps this file into window.__ModuleLoader__.load({ id, factory }).
 * 与动态版逻辑一致：header「Git 图谱」按钮 + shell.overlay 图谱面板；
 * 数据经本插件 host 半区的 /sgx/* 同源路由获取（无 host.call，无 styles 全局）。
 */

var React = require('react')

var CSS = `
.sgx-entry{cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:8px;padding:2px 8px;font-size:12px;line-height:18px}
.sgx-entry:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.sgx-panel{position:fixed;top:16px;right:16px;width:min(760px,calc(100vw - 32px));max-height:78vh;display:flex;flex-direction:column;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.28);pointer-events:auto;z-index:80;overflow:hidden;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;text-align:left}
.sgx-head{display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l2);flex:none}
.sgx-title{font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sgx-meta{color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap}
.sgx-grow{flex:1}
.sgx-btn{cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:8px;padding:2px 10px;font-size:12px;line-height:18px}
.sgx-btn:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.sgx-btn:disabled{opacity:.5;cursor:default}
.sgx-chips{display:flex;flex-wrap:wrap;gap:6px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.sgx-chip{display:inline-flex;align-items:center;gap:6px;padding:2px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;line-height:18px;max-width:220px}
.sgx-chip:hover{background:var(--dsw-alias-bg-layer-1)}
.sgx-chip .sgx-dot{width:8px;height:8px;border-radius:50%;flex:none}
.sgx-chip.sgx-cur{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}
.sgx-chipText{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sgx-net{overflow:auto;flex:auto;padding:4px 0 8px}
.sgx-detail{border-top:1px solid var(--dsw-alias-border-l2);padding:8px 12px;max-height:200px;overflow:auto;flex:none}
.sgx-dk{display:inline-block;font-size:11px;line-height:16px;border-radius:4px;padding:0 6px;margin-right:6px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);vertical-align:middle}
.sgx-dtitle{font-weight:600;margin:2px 0}
.sgx-dsum{color:var(--dsw-alias-label-secondary);white-space:pre-wrap}
.sgx-drow{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
.sgx-note{color:var(--dsw-alias-label-secondary);font-size:12px;padding:12px}
.sgx-err{color:var(--dsw-alias-state-error-primary);padding:8px 12px;font-size:12px}
`

function truncate(s, n) {
  var t = String(s || '')
  return t.length > n ? t.slice(0, n) + '…' : t
}

var LANE_W = 36
var ROW_H = 26
var PAD_X = 14
var LABEL_H = 4
var CONTENT_W = 300
var LANE_COLORS = ['#4f8ef7', '#39a97c', '#e3b341', '#b06fd8', '#e56a6a', '#50b8c0']

function layoutGraph(data) {
  var branches = (data && data.branches) || []
  var byId = {}
  for (var i = 0; i < branches.length; i++) byId[branches[i].id] = branches[i]
  var depthOf = function (b) {
    var d = 0
    var p = b.parentId
    while (p && byId[p]) { d++; p = byId[p].parentId }
    return d
  }
  var ordered = branches.slice().sort(function (a, b) { return depthOf(a) - depthOf(b) || a.createdAt - b.createdAt })
  var laneOf = {}
  ordered.forEach(function (b, i) { laneOf[b.id] = i })
  var rows = []
  var seen = new Set()
  ordered.forEach(function (b) {
    (b.chain || []).forEach(function (k) {
      if (!seen.has(k)) { seen.add(k); rows.push(k) }
    })
  })
  var rowOf = {}
  rows.forEach(function (k, i) { rowOf[k] = i })
  var commitMap = {}
  for (var j = 0; j < ((data && data.commits) || []).length; j++) commitMap[data.commits[j].key] = data.commits[j]
  var curHeadKey = null
  for (var q = 0; q < branches.length; q++) if (branches[q].id === data.current) curHeadKey = branches[q].headKey || null
  return { ordered: ordered, laneOf: laneOf, rows: rows, rowOf: rowOf, commits: commitMap, curHeadKey: curHeadKey }
}

var inject = ['slots', 'sessions', 'timer']

function apply(ctx) {
  // package-owned stylesheet (bundle land has no `styles` builtin)
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

  ctx.inject(['slots', 'sessions', 'timer'], function (scope) {
    var slots = scope.slots
    var sessionsSvc = scope.sessions
    var timer = scope.timer

    var ui = { value: false, subs: new Set() }
    var setOpen = function (v) { ui.value = !!v; for (var f of ui.subs) f() }
    var subOpen = function (f) { ui.subs.add(f); return function () { ui.subs.delete(f) } }
    var getOpen = function () { return ui.value }
    var jump = { target: null }

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

    // ---------- header entry: toggle button + scroll watcher ----------
    function HeaderEntry(props) {
      var sessionId = props.sessionId
      var useSession = props.useSession
      var open = React.useSyncExternalStore(subOpen, getOpen)
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
            clear = timer.timeout(function () { scroll(); jump.target = null }, 900)
            return
          }
          if (++tries >= 24) { finished = true; return }
          clear = timer.timeout(step, 180)
        }
        clear = timer.timeout(step, 150)
        return function () { finished = true; if (clear) clear() }
      }, [anchorKey])
      return React.createElement('button', { type: 'button', className: 'sgx-entry', title: '以 Git 图谱查看本项目会话分支与提交（branch=会话，commit=一轮请求+完成）', onClick: function () { setOpen(!open) } }, 'Git 图谱')
    }

    // ---------- panel body ----------
    function PanelBody(props) {
      var current = props.current
      var statePair = React.useState({ data: null, error: null, loading: false })
      var state = statePair[0]
      var setState = statePair[1]
      var selPair = React.useState(null)
      var selKey = selPair[0]
      var setSelKey = selPair[1]
      var busyPair = React.useState(null)
      var busy = busyPair[0]
      var setBusy = busyPair[1]
      var refresh = React.useCallback(function () {
        if (!current) { setState({ data: null, error: null, loading: false }); return }
        setState(function (s) { return { data: s.data, error: null, loading: true } })
        fetchGraph(current).then(function (data) {
          setState({ data: data, error: data && data.error ? data.error : null, loading: false })
        }).catch(function (e) {
          setState({ data: null, error: String((e && e.message) || e), loading: false })
        })
      }, [current])
      React.useEffect(function () {
        var alive = true
        refresh()
        var stop = timer.interval(function () { if (alive) refresh() }, 30000)
        return function () { alive = false; stop() }
      }, [refresh])

      var data = state.data
      var L = data && !data.error ? layoutGraph(data) : null
      var lanes = L ? L.ordered.length : 0
      var rows = L ? L.rows.length : 0
      var width = PAD_X * 2 + lanes * LANE_W + CONTENT_W
      var height = LABEL_H + rows * ROW_H + PAD_X + 8
      var laneX = function (i) { return PAD_X + i * LANE_W + LANE_W / 2 }
      var rowY = function (i) { return LABEL_H + i * ROW_H + ROW_H / 2 + 4 }
      var colorOf = function (i) { return LANE_COLORS[i % LANE_COLORS.length] }

      var openBranch = function (id) {
        setOpen(false)
        if (id !== current) sessionsSvc.open(id)
      }
      var openCommit = function (c) {
        jump.target = { sessionId: c.sessionId, turn: c.turn, userSeq: c.userSeq }
        setOpen(false)
        if (c.sessionId !== current) sessionsSvc.open(c.sessionId)
      }
      var forkAt = function (c) {
        if (busy) return
        setBusy('fork')
        sessionsSvc.fork({ sessionId: c.sessionId, atSeq: c.userSeq, increaseTitle: true }).then(function (childId) {
          setOpen(false)
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

      if (!data) {
        return React.createElement('div', { className: 'sgx-panel' }, React.createElement('div', { className: 'sgx-note' }, state.loading || !current ? '加载中…' : '请先选择一个会话'))
      }
      if (data.error) {
        return React.createElement('div', { className: 'sgx-panel' },
          React.createElement('div', { className: 'sgx-head' }, React.createElement('span', { className: 'sgx-title' }, 'Git 图谱'), React.createElement('span', { className: 'sgx-grow' }),
            React.createElement('button', { className: 'sgx-btn', onClick: function () { setOpen(false) } }, '关闭')),
          React.createElement('div', { className: 'sgx-err' }, '加载失败：' + data.error))
      }

      var laneLines = []
      var forkPaths = []
      var tipCircles = []
      var dotGroups = []

      for (var bi = 0; bi < L.ordered.length; bi++) {
        var b = L.ordered[bi]
        var li = L.laneOf[b.id]
        var x = laneX(li)
        var chain = b.chain || []
        if (chain.length === 0) continue
        var own = b.commitCount || 0
        var isChild = !!(b.parentId && L.laneOf[b.parentId] !== undefined && L.laneOf[b.parentId] !== li)
        var endKey = chain[chain.length - 1]
        var startKey
        if (own > 0 && chain.length > own) startKey = chain[chain.length - own - 1]
        else if (own === 0 && isChild) startKey = endKey
        else startKey = chain[0]
        var r0 = L.rowOf[startKey]
        var r1 = L.rowOf[endKey]
        if (r0 === undefined || r1 === undefined) continue
        var laneColor = colorOf(li)
        laneLines.push({ x: x, y0: rowY(r0), y1: rowY(r1), color: laneColor })
        if (isChild) {
          var pi = L.laneOf[b.parentId]
          var firstOwnKey = own > 0 ? chain[chain.length - own] : endKey
          var rFork = L.rowOf[firstOwnKey]
          if (rFork !== undefined) {
            forkPaths.push({ x0: laneX(pi), y0: rowY(r0), x1: x, y1: rowY(rFork), color: laneColor })
          }
          if (own === 0) {
            tipCircles.push({ cx: x, cy: rowY(r1), color: laneColor, label: '新分支：' + truncate(b.title, 20) })
          }
        }
      }

      for (var ri = 0; ri < rows; ri++) {
        (function (k, cm, dyIdx) {
          if (!cm) return
          var ownerLane = L.laneOf[cm.sessionId]
          if (ownerLane === undefined) return
          var dx = laneX(ownerLane)
          var dy = rowY(dyIdx)
          var dcolor = colorOf(ownerLane)
          var selected = selKey === k
          var isCur = k === L.curHeadKey
          dotGroups.push(React.createElement('g', { key: k, className: 'sgx-cg', style: { cursor: 'pointer' }, onClick: function () { openCommit(cm) }, onMouseEnter: function () { setSelKey(k) } },
            React.createElement('title', null, (cm.title || '') + (isCur ? '（当前分支 head）' : '') + '\n' + (cm.status === 'ai' ? 'AI 已总结' : '待 AI 总结')),
            React.createElement('circle', { cx: dx, cy: dy, r: 9, fill: 'transparent' }),
            isCur && React.createElement('circle', { cx: dx, cy: dy, r: 8, fill: 'none', stroke: dcolor, strokeWidth: 1.5, opacity: 0.7 }),
            React.createElement('circle', { cx: dx, cy: dy, r: 5, fill: dcolor, stroke: selected || isCur ? '#ffffff' : 'var(--dsw-alias-bg-overlay)', strokeWidth: selected ? 2 : (isCur ? 2 : 1) }),
            React.createElement('text', { x: PAD_X + lanes * LANE_W + 10, y: dy + 4, fontSize: 12, fill: 'var(--dsw-alias-label-secondary)', style: { cursor: 'pointer' } }, truncate(cm.title, 34))))
        })(L.rows[ri], L.commits[L.rows[ri]], ri)
      }

      var sel = selKey ? L.commits[selKey] : null
      var detail = null
      if (sel) {
        var owner = null
        for (var oi = 0; oi < data.branches.length; oi++) if (data.branches[oi].id === sel.sessionId) { owner = data.branches[oi]; break }
        detail = React.createElement('div', { className: 'sgx-detail' },
          React.createElement('div', null,
            React.createElement('span', { className: 'sgx-dk' }, sel.sessionId === current ? '当前分支' : '提交'),
            React.createElement('span', { className: 'sgx-dk' }, '#' + sel.turn),
            React.createElement('span', { className: 'sgx-dk' }, new Date(sel.time).toLocaleString())),
          React.createElement('div', { className: 'sgx-dtitle' }, sel.title || ('# ' + sel.turn)),
          React.createElement('div', { className: 'sgx-dsum' }, sel.summary || (sel.userText ? '待生成 AI 要点：' + truncate(sel.userText, 120) : '待生成 AI 要点')),
          React.createElement('div', { className: 'sgx-drow' },
            React.createElement('button', { className: 'sgx-btn', onClick: function () { openCommit(sel) } }, '跳转到此提交'),
            React.createElement('button', { className: 'sgx-btn', disabled: !!busy, onClick: function () { forkAt(sel) } }, busy === 'fork' ? '分叉中…' : '在此分叉'),
            (sel.status !== 'ai') && React.createElement('button', { className: 'sgx-btn', disabled: !!busy, onClick: function () { summarize(sel) } }, busy === 'sum' ? '摘要中…' : (sel.status === 'fallback' ? '重试 AI 摘要' : 'AI 摘要')),
            owner && React.createElement('button', { className: 'sgx-btn', onClick: function () { openBranch(owner.id) } }, '打开分支：' + truncate(owner.title, 18))))
      }

      return React.createElement('div', { className: 'sgx-panel' },
        React.createElement('div', { className: 'sgx-head' },
          React.createElement('span', { className: 'sgx-title' }, 'Git 图谱 · ' + data.workspace.title),
          React.createElement('span', { className: 'sgx-meta' }, data.branches.length + ' 分支 / ' + data.commits.length + ' 提交'),
          React.createElement('span', { className: 'sgx-grow' }),
          React.createElement('button', { className: 'sgx-btn', disabled: !!busy, onClick: function () { refresh() } }, state.loading ? '刷新…' : '刷新'),
          React.createElement('button', { className: 'sgx-btn', onClick: function () { setOpen(false) } }, '关闭')),
        React.createElement('div', { className: 'sgx-chips' }, L.ordered.map(function (b) {
          return React.createElement('button', { key: b.id, className: 'sgx-chip' + (b.id === current ? ' sgx-cur' : ''), onClick: function () { openBranch(b.id) }, title: b.title + '\n' + b.commitCount + ' 个原生提交' },
            React.createElement('span', { className: 'sgx-dot', style: { background: colorOf(L.laneOf[b.id]) } }),
            React.createElement('span', { className: 'sgx-chipText' }, b.title))
        })),
        React.createElement('div', { className: 'sgx-net' },
          React.createElement('svg', { width: width, height: height, viewBox: '0 0 ' + width + ' ' + height },
            laneLines.map(function (ln, i) { return React.createElement('line', { key: 'l' + i, x1: ln.x, y1: ln.y0, x2: ln.x, y2: ln.y1, stroke: ln.color, strokeWidth: 2, opacity: 0.85 }) }),
            tipCircles.map(function (tp, i) {
              return React.createElement('g', { key: 'tip' + i },
                React.createElement('title', null, tp.label || '新分支'),
                React.createElement('circle', { cx: tp.cx, cy: tp.cy, r: 6, fill: 'none', stroke: tp.color, strokeWidth: 2 }),
                React.createElement('circle', { cx: tp.cx, cy: tp.cy, r: 2, fill: tp.color }))
            }),
            forkPaths.map(function (fp, i) {
              var mid = (fp.y0 + fp.y1) / 2
              return React.createElement('path', { key: 'f' + i, d: 'M ' + fp.x0 + ' ' + fp.y0 + ' C ' + fp.x0 + ' ' + mid + ', ' + fp.x1 + ' ' + mid + ', ' + fp.x1 + ' ' + fp.y1, fill: 'none', stroke: fp.color, strokeWidth: 1.5, strokeDasharray: '3 3', opacity: 0.9 })
            }),
            dotGroups)),
        detail,
        React.createElement('div', { className: 'sgx-note', style: { borderTop: '1px solid var(--dsw-alias-border-l1)' } }, '圆点=提交（用户请求+完成），竖线=分支（会话），虚线=分叉。点击圆点跳转，悬停选择，底部执行分叉 / AI 摘要。'))
    }

    // ---------- overlay panel ----------
    function GraphOverlay(props) {
      var open = React.useSyncExternalStore(subOpen, getOpen)
      var current = props.useSessions(function (s) { return s.current })
      if (!open) return null
      return React.createElement(PanelBody, { current: current })
    }

    slots.inject('conversation.session.header.actions', function () {
      return slots.register({ name: 'conversation.session.header.actions', id: 'git-graph', order: 30, label: 'Git 图谱' }, HeaderEntry)
    })
    slots.inject('shell.overlay', function () {
      return slots.register({ name: 'shell.overlay', id: 'git-graph-panel', order: 60 }, GraphOverlay)
    })
  })
}

exports.inject = inject
exports.apply = apply

    return module.exports;
  }
});
