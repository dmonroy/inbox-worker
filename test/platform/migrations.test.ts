/**
 * Against real local D1, because the questions here are all about what the
 * platform actually does. A mock would answer them the way I expected rather
 * than the way SQLite behaves.
 */

import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, test } from 'vitest'
import {
  CODE_SCHEMA_VERSION,
  isTolerant,
  MIGRATIONS,
  type Migration,
  migrate,
  schemaVersion,
  sqlOf,
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
 * Children before parents, then whatever else is lying around — the noop and
 * probe tables these tests invent have no references either way.
 *
 * D1 enforces foreign keys and ignores `PRAGMA foreign_keys = OFF` (§9.0), so
 * dropping `contents` while a `messages` row still points at it fails outright.
 * Alphabetical order — which is what `tables()` returns — happens to work only
 * while every table is empty, and the failure would land in `beforeEach` and
 * take down every test after it rather than the one that wrote the row.
 */
const CHILD_FIRST = [
  'failed_ingest',
  'conversation_index',
  'attachments',
  'participants',
  'messages',
  'contents',
  'contacts',
  'conversations',
]

/**
 * Explicit reset rather than relying on the pool to isolate storage per test.
 * These tests are entirely about what an empty database does versus a migrated
 * one, so "empty" has to be something this file guarantees rather than
 * inherits from a runner default that has already changed once.
 */
beforeEach(async () => {
  const present = await tables()
  const ordered = [
    ...CHILD_FIRST.filter((name) => present.includes(name)),
    ...present.filter((name) => !CHILD_FIRST.includes(name)),
  ]

  for (const name of ordered) {
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
    //
    // Bare re-execution is the right test only while every statement is a
    // plain string. A tolerant one is re-runnable *through the driver*, which
    // is what swallows its error — see 'a statement marked tolerant' below.
    await migrate(db())

    for (const statement of MIGRATIONS[0]?.statements ?? []) {
      expect(isTolerant(statement)).toBe(false)
      await db().prepare(sqlOf(statement)).run()
    }

    expect(await schemaVersion(db())).toBe(1)
  })
})

describe('a partially applied migration', () => {
  test('is repaired by running it again', async () => {
    // Simulates the CLI dying between statements: the schema is half there and
    // the version was never written, because the version write is last.
    const partial = MIGRATIONS[0]?.statements.slice(0, 3) ?? []
    for (const statement of partial) {
      await db().prepare(sqlOf(statement)).run()
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

describe('a statement marked tolerant', () => {
  /**
   * The shape §15.1 exists for: `ALTER TABLE … ADD COLUMN`, which SQLite has
   * no `IF NOT EXISTS` for, so it is the one statement that cannot be made
   * re-runnable by writing it more carefully.
   */
  const adding = (sql: string): Migration => ({
    version: 1,
    name: 'tolerant',
    statements: [
      `CREATE TABLE IF NOT EXISTS probe (x TEXT)`,
      { sql, tolerate: 'duplicate-column' },
    ],
  })

  const addsColumn = adding(`ALTER TABLE probe ADD COLUMN sniffed_type TEXT`)

  const columns = async (table: string): Promise<string[]> => {
    const { results } = await db()
      .prepare(`SELECT name FROM pragma_table_info(?) ORDER BY name`)
      .bind(table)
      .all<{ name: string }>()
    return results.map((r) => r.name)
  }

  test('an interrupted run is repaired by running it again', async () => {
    // The whole point of the mechanism, and the promise README makes: a run
    // that dies between statements left the schema half-applied and the
    // version unwritten, so the repair is to run the same thing again. Without
    // tolerance the re-run dies on the ALTER — and dies *every* time, so the
    // migration can never be recorded and the database is stuck.
    for (const statement of addsColumn.statements) {
      await db().prepare(sqlOf(statement)).run()
    }
    expect(await schemaVersion(db())).toBe(0)

    const { applied } = await migrate(db(), [addsColumn])

    expect(applied).toEqual([1])
    expect(await schemaVersion(db())).toBe(1)
    expect(await columns('probe')).toEqual(['sniffed_type', 'x'])
  })

  test('applying it a second time leaves one column, not two', async () => {
    // Tolerating the error must mean the column is already there — not that
    // the ALTER half-ran. If a re-run could duplicate or clobber the column,
    // swallowing the error would be hiding data loss rather than a no-op.
    await migrate(db(), [addsColumn])
    await migrate(db(), [{ ...addsColumn, version: 2 }])

    expect(await columns('probe')).toEqual(['sniffed_type', 'x'])
    expect(await schemaVersion(db())).toBe(2)
  })

  test('a failure that is not duplicate-column still propagates', async () => {
    // `tolerate` is a closed union rather than a boolean precisely so this
    // stays loud. A typo'd table name that got swallowed would let the version
    // be written for a schema that was never applied — the exact half-migrated
    // state the re-run promise is supposed to rule out.
    const typo = adding(`ALTER TABLE prboe ADD COLUMN sniffed_type TEXT`)

    await expect(migrate(db(), [typo])).rejects.toThrow(/no such table/)
    expect(await schemaVersion(db())).toBe(0)
  })

  test('earlier statements survive a later failure, because it is not a batch', async () => {
    // A tolerant migration cannot run in `batch()` — a transaction has no way
    // to express a swallowed error — so it runs sequentially and there is no
    // rollback. That is safe only because every statement is idempotent, and
    // this is the test that notices if someone puts it back in a batch and
    // gets rollback semantics it cannot honour.
    const typo = adding(`ALTER TABLE prboe ADD COLUMN sniffed_type TEXT`)

    await expect(migrate(db(), [typo])).rejects.toThrow()

    expect(await tables()).toContain('probe')
  })
})

describe('which driver a migration takes', () => {
  /** Only `prepare` and `batch` are used, so this is the whole surface. */
  const counting = (): { db: D1Database; batches: () => number } => {
    let batches = 0
    const spy = {
      prepare: (sql: string) => db().prepare(sql),
      batch: (statements: D1PreparedStatement[]) => {
        batches++
        return db().batch(statements)
      },
    } as unknown as D1Database
    return { db: spy, batches: () => batches }
  }

  const plain: Migration = {
    version: 1,
    name: 'plain',
    statements: [
      `CREATE TABLE IF NOT EXISTS probe (x TEXT)`,
      `CREATE INDEX IF NOT EXISTS idx_probe ON probe(x)`,
    ],
  }

  test('a migration of plain statements still goes through batch()', async () => {
    // Sequential is only *required* where a statement is tolerant. Everything
    // else keeps the transaction and the single round trip it already had —
    // making every migration sequential would be a silent regression, both in
    // speed and in atomicity.
    const { db: spy, batches } = counting()

    await migrate(spy, [plain])

    expect(batches()).toBe(1)
  })

  test('one tolerant statement moves the whole migration off batch()', async () => {
    // Not just the tolerant statement: `batch()` aborts the entire sequence on
    // any error, so a batch that a tolerant statement sits in cannot swallow
    // anything. The unit of choice is the migration.
    const { db: spy, batches } = counting()

    await migrate(spy, [
      {
        version: 1,
        name: 'mixed',
        statements: [
          `CREATE TABLE IF NOT EXISTS probe (x TEXT)`,
          {
            sql: `ALTER TABLE probe ADD COLUMN y TEXT`,
            tolerate: 'duplicate-column',
          },
        ],
      },
    ])

    expect(batches()).toBe(0)
  })
})

describe('the statements are not splittable text', () => {
  test('every statement is a single statement', () => {
    // D1's exec() splits on newlines and gets it wrong — a multi-line CREATE
    // TABLE fails with `incomplete input` (workers-sdk#9133), which a spike
    // reproduced against local D1. We never hand D1 splittable text, so a
    // stray semicolon that turns one entry into two must not creep in.
    for (const migration of MIGRATIONS) {
      for (const statement of migration.statements) {
        expect(sqlOf(statement).replace(/;\s*$/, '')).not.toContain(';')
      }
    }
  })
})
