/**
 * `createTestEnv()` against real local D1 and R2, because everything it claims
 * is a claim about storage: that a schema exists, and that nothing survives
 * from the test before.
 *
 * Named `test-env` rather than `storage`, so it never collides with the
 * storage suite.
 */

import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, test } from 'vitest'
import {
  CODE_SCHEMA_VERSION,
  migrate,
  schemaVersion,
} from '../../src/migrations'
import { createTestEnv, INBOX_TABLES } from '../../src/testing'

const db = () => env.INBOX_DB
const bucket = () => env.INBOX_BUCKET

/** Our tables and anyone else's — D1's `_cf_*` and SQLite's own are not ours. */
const tables = async (): Promise<string[]> => {
  const { results } = await db()
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
         AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
       ORDER BY name`,
    )
    .all<{ name: string }>()
  return results.map((r) => r.name)
}

/**
 * The pool does not isolate storage per test in this version — which is the
 * whole reason `createTestEnv()` has to reset explicitly. A suite that tests
 * the reset cannot then rely on it to set itself up, so this starts from
 * nothing by hand.
 */
beforeEach(async () => {
  for (const name of await tables()) {
    await db().prepare(`DROP TABLE IF EXISTS "${name}"`).run()
  }
  for (const object of (await bucket().list()).objects) {
    await bucket().delete(object.key)
  }
})

describe('the schema', () => {
  test('exists before a test writes anything', async () => {
    // The one thing §12 says it does. Without it every consumer's first
    // integration test fails on `no such table`, and the fix they reach for is
    // to copy our SQL into their repo — exactly what §2.8 rules out.
    await createTestEnv(env)

    expect(await schemaVersion(db())).toBe(CODE_SCHEMA_VERSION)
  })
})

describe('the reset', () => {
  test('clears rows left behind by an earlier test', async () => {
    // A parent row and a child row that references it, not one lonely row.
    // D1 enforces foreign keys and will not let you turn them off (§9.0), so
    // clearing in the wrong order is an error rather than a mess — and only a
    // referenced row can prove the order is right.
    await migrate(db())
    await db().batch([
      db().prepare(
        `INSERT INTO contacts (id, channel, external_id, first_seen, last_seen)
         VALUES ('c1', 'email', 'ada@example.com', 0, 0)`,
      ),
      db().prepare(
        `INSERT INTO contents
           (id, channel, raw_sha256, contact_id, raw_r2_key,
            raw_content_type, size_bytes)
         VALUES ('k1', 'email', 'deadbeef', 'c1', 'raw/email/2025/01/deadbeef',
                 'message/rfc822', 12)`,
      ),
    ])

    await createTestEnv(env)

    const row = await db()
      .prepare(
        `SELECT (SELECT COUNT(*) FROM contacts)
              + (SELECT COUNT(*) FROM contents) AS n`,
      )
      .first<{ n: number }>()
    expect(row?.n).toBe(0)
  })

  test('clears the bucket as well as the database', async () => {
    // Raw objects are content-addressed (§9), so a leftover from a previous
    // test is byte-identical to the one the current test expects to create.
    // It would satisfy every assertion about the object existing while the
    // code that should have written it never ran.
    await bucket().put('raw/email/2025/01/abc', 'stale')

    await createTestEnv(env)

    expect(await bucket().get('raw/email/2025/01/abc')).toBeNull()
  })

  test('leaves tables it does not own alone', async () => {
    // Whether the package gets its own D1 is still open (§2.9), so a consumer
    // may well point `INBOX_DB` at the database their app already uses.
    // Wiping it in a `beforeEach` would be an unrecoverable surprise.
    await db().prepare('CREATE TABLE consumer_orders (id TEXT)').run()
    await db().prepare(`INSERT INTO consumer_orders VALUES ('o1')`).run()

    await createTestEnv(env)

    const row = await db()
      .prepare('SELECT COUNT(*) AS n FROM consumer_orders')
      .first<{ n: number }>()
    expect(row?.n).toBe(1)
  })

  test('knows about every table the schema creates', async () => {
    // The owned-table list is derived from the migration statements, so a
    // migration that declares a table some other way — or a rename — drops it
    // out of the reset silently. The symptom would be one test seeing another
    // test's rows, which is the worst kind of flake to chase.
    await migrate(db())

    expect([...INBOX_TABLES].sort()).toEqual(await tables())
  })
})
