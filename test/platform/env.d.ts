/**
 * Types for the `cloudflare:test` module, which only exists inside the workers
 * pool.
 *
 * `env` is typed as `Cloudflare.Env`, so the bindings go on that global
 * namespace rather than on a `ProvidedEnv` interface — the pool changed this
 * shape, and the older form silently produced an empty `env` type instead of
 * an error.
 *
 * These must match the bindings declared in `vitest.config.ts`. Nothing
 * derives one from the other, so they are two places that have to agree.
 */

/// <reference types="@cloudflare/vitest-pool-workers/types" />

declare namespace Cloudflare {
  interface Env {
    INBOX_DB: D1Database
    INBOX_BUCKET: R2Bucket
  }
}
