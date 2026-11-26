import { CACHE_DIR_ENV, resetDiskCache } from '../src/core/disk-cache.js'
import { configureHostLimiter } from '../src/core/http.js'

// Stubbed fetch answers instantly, so the 200 ms per-host gap would only slow the
// suite down. tests/http.test.ts covers the limiter with its own instances.
configureHostLimiter({ minGapMs: 0 })

// A unit test must never read or write a developer's real disk cache.
delete process.env[CACHE_DIR_ENV]
resetDiskCache()
