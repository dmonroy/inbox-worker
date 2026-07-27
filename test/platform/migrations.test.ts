/**
 * Against real local D1, because the questions here are all about what the
 * platform actually does. A mock would answer them the way I expected rather
 * than the way SQLite behaves.
 */

import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, test } from 'vitest'
import {
  CODE_SCHEMA_VERSION,
  MIGRATIONS,
  type Migration,
  migrate,
  schemaVersion,
} from '../../src/migrations'

const db = () => env.INBOX_DB

/**
 * Our tables only. D1 keeps its own bookkeeping in `_cf_METADATA`, and SQLite
 * keeps `sqlite_*` — both appear in `sqlite_master` and neither is ours to
 * assert on.
 */
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
 * Explicit reset rather than relying on the pool to isolate storage per test.
 * These tests are entirely about what an empty database does versus a migrated
 * one, so "empty" has to be something this file guarantees rather than
 * inherits from a runner default that has already changed once.
 */
beforeEach(async () => {
  for (const name of await tables()) {
    await db().prepare(`DROP TABLE IF EXISTS "${name}"`).run()
  }
  expect(await tables()).toEqual([])
})

describe('a fresh database', () => {
  test('reports version 0 before anything is applied', async () => {
    // The `_inbox_meta` table does not exist yet, and that has to read as
    // "unmigrated" rather than blowing up — it is the state every new
    // deployment starts in, and the caller's next move is the same either way.
    expect(await schemaVersion(db())).toBe(0)
  })

  test('migrate creates every table the design calls for', async () => {
    await migrate(db())

    expect(await tables()).toEqual([
      '_inbox_meta',
      'attachments',
      'contacts',
      'contents',
      'conversation_index',
      'conversations',
      'failed_ingest',
      'messages',
      'participants',
    ])
  })

  test('migrate records the version it reached', async () => {
    const result = await migrate(db())

    expect(result.applied).toEqual([1])
    expect(result.version).toBe(CODE_SCHEMA_VERSION)
    expect(await schemaVersion(db())).toBe(CODE_SCHEMA_VERSION)
  })
})

describe('running it again', () => {
  test('is a no-op, and says so', async () => {
    await migrate(db())
    const second = await migrate(db())

    // `applied` empty is how a caller tells "already current" from "just
    // migrated" without a second read.
    expect(second.applied).toEqual([])
    expect(second.version).toBe(CODE_SCHEMA_VERSION)
  })

  test('re-applying the statements directly does not fail', async () => {
    // The property the CLI depends on. It runs one `wrangler d1 execute`
    // per statement with no transaction across them, so a run that dies
    // halfway has to be repairable by running it again. That is only true if
    // every statement is safe to re-run.
    await migrate(db())

    for (const sql of MIGRATIONS[0]?.statements ?? []) {
      await db().prepare(sql).run()
    }

    expect(await schemaVersion(db())).toBe(1)
  })
})

describe('a partially applied migration', () => {
  test('is repaired by running it again', async () => {
    // Simulates the CLI dying between statements: the schema is half there and
    // the version was never written, because the version write is last.
    const partial = MIGRATIONS[0]?.statements.slice(0, 3) ?? []
    for (const sql of partial) {
      await db().prepare(sql).run()
    }
    expect(await schemaVersion(db())).toBe(0)

    await migrate(db())

    expect(await schemaVersion(db())).toBe(1)
    expect(await tables()).toContain('failed_ingest')
  })
})

describe('the meta table is infrastructure, not schema content', () => {
  test('it is created even by a migration list that does not mention it', async () => {
    // Whatever records "we are at version n" has to exist before version 1 is
    // applied, so it cannot live inside migration 1. It did at first, which
    // coupled every migration run to migration 1 being present — a custom or
    // renumbered list then failed on the version write with `no such table`.
    const { applied } = await migrate(db(), [
      {
        version: 1,
        name: 'unrelated',
        statements: ['CREATE TABLE IF NOT EXISTS probe (x TEXT)'],
      },
    ])

    expect(applied).toEqual([1])
    expect(await schemaVersion(db())).toBe(1)
    expect(await tables()).toContain('_inbox_meta')
  })
})

describe('version ordering', () => {
  const noop = (version: number): Migration => ({
    version,
    name: `noop-${version}`,
    statements: [`CREATE TABLE IF NOT EXISTS probe_${version} (x TEXT)`],
  })

  test('migrations apply in version order regardless of array order', async () => {
    // Someone will eventually append a migration to the middle of the array.
    // Applying them out of order would run a later schema against an earlier
    // one and record a version that was never truly reached.
    const { applied } = await migrate(db(), [noop(3), noop(1), noop(2)])
    expect(applied).toEqual([1, 2, 3])
  })

  test('only migrations newer than the recorded version run', async () => {
    await migrate(db(), [noop(1), noop(2)])
    const { applied } = await migrate(db(), [noop(1), noop(2), noop(3)])

    expect(applied).toEqual([3])
  })

  test('a schema ahead of the code is left alone', async () => {
    // Migrations are additive and the deploy order is migrate-then-deploy, so
    // an isolate briefly seeing a newer schema is normal. Rolling it back
    // would destroy data the newer code had already written.
    await migrate(db(), [noop(1), noop(2), noop(3)])
    const { applied, version } = await migrate(db(), [noop(1)])

    expect(applied).toEqual([])
    expect(version).toBe(3)
  })
})

describe('the statements are not splittable text', () => {
  test('every statement is a single statement', () => {
    // D1's exec() splits on newlines and gets it wrong — a multi-line CREATE
    // TABLE fails with `incomplete input` (workers-sdk#9133), which a spike
    // reproduced against local D1. We never hand D1 splittable text, so a
    // stray semicolon that turns one entry into two must not creep in.
    for (const migration of MIGRATIONS) {
      for (const sql of migration.statements) {
        expect(sql.replace(/;\s*$/, '')).not.toContain(';')
      }
    }
  })
})
