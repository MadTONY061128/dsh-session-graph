// Import every suite into one process. This keeps Windows environments that
// deny child-process spawning reliable while remaining compatible with the
// minimum supported Node 22.19 runtime.
await import("./client-layout.test.js")
await import('./dag-core.test.js')
await import('./host-integration.test.js')
await import('./membership-closure.test.js')
