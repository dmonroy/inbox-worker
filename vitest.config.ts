import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

/**
 * Two projects, because the two kinds of test have very different costs.
 *
 * `unit` is pure logic on the default pool — the sub-second cycle that
 * `npm run test:watch` depends on. `platform` runs inside workerd against real
 * local D1 and R2, which is slower to start and only worth paying for the
 * tests that actually touch a binding.
 *
 * Bindings are declared inline rather than through a `wrangler.toml`: this
 * package is a library, not a worker, so it has no deployment config of its
 * own, and inventing one only to satisfy the test runner would be misleading
 * about what consumers are expected to copy.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/*.test.ts'],
        },
      },
      {
        plugins: [
          cloudflareTest({
            miniflare: {
              d1Databases: ['INBOX_DB'],
              r2Buckets: ['INBOX_BUCKET'],
            },
          }),
        ],
        test: {
          name: 'platform',
          include: ['test/platform/*.test.ts'],
        },
      },
    ],
  },
})
