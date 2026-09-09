# Changelog

## 0.7.0 - 2026-09-05

- Add one trusted `sessionGraph` coordinator service for higher-level workflow plugins.
- Support explicit logical-graph membership across physical worktree workspaces.
- Add managed mutation guards without changing the existing HTTP or model-tool interfaces.
- Add durable, idempotent prepare/commit/abort merge records with source/target expected-head fencing.
- Add explicit graph-cache invalidation and coordinator teardown.

## 0.6.0 - 2026-09-05

- Replace linear-prefix merge calculation with a two-parent session-information DAG and reachable-set difference.
- Preserve merge ancestry through explicit Git-revert nodes.
- Replace appended chat-message injection with idempotent dynamic prompt injection and uninject.
- Add workspace-scoped persistence and authorization checks.
- Disable automatic summaries by default; expose provider/model, workspace settings, and metadata purge.
- Change background refresh from 30 seconds to 120 seconds with visibility and stale-request guards.
- Add Node tests, CI, a reproducible client build check, and the complete MIT license.

## 0.5.1 - 2026-09-05

- Fix merge-row lane geometry, direction arrows, current-head highlighting, empty lanes, and preload behavior.
