/**
 * The schema, and the two ways it gets applied.
 *
 * **Migrations never run from the worker** (§2.8). They are a local command,
 * run by a person or by CI; the worker only ever reads `schema_version`.
 * Putting DDL on the ingest path would mean running it from the one place that
 * must never throw, entered by an unauthenticated stranger, racing every other
 * isolate that started at the same time.
 */

/** Where the schema version is kept. See `META_STATEMENT`. */
const META_TABLE = '_inbox_meta'
const VERSION_KEY = 'schema_version'

/**
 * A statement, and the one escape hatch from "safe to re-run" (§15.1).
 *
 * Almost everything is a plain string made re-runnable by `IF NOT EXISTS`.
 * `ALTER TABLE … ADD COLUMN` is the exception SQLite gives no `IF NOT EXISTS`
 * for, so it says instead which failure it expects on a second run.
 *
 * `tolerate` is a closed union rather than a boolean on purpose. `true` would
 * swallow a typo'd table name as readily as a duplicate column, and the
 * version would still be written — a schema recorded as migrated that never
 * was. Naming the failure means anything else stays loud.
 */
export type Statement = string | { sql: string; tolerate: 'duplicate-column' }

export interface Migration {
  version: number
  name: string
  /**
   * DDL, in order. **Every statement must be safe to re-run** — a plain string
   * by being idempotent, a tolerant one by naming what it expects to fail
   * with. See `Statement`.
   *
   * The CLI applies these one `wrangler d1 execute --command` at a time, one
   * process per statement, so there is no transaction spanning them. Rather
   * than reach for atomicity we cannot get across process boundaries, the
   * half-applied state is made harmless: re-running the command is the repair.
   *
   * Never `.sql` text. D1's `exec()` splits on newlines and gets it wrong —
   * measured, not assumed: a multi-line `CREATE TABLE` fails with
   * `incomplete input`, reproducing workers-sdk#9133 exactly.
   */
  statements: Statement[]
}

/**
 * SQLite's own words for the one failure a tolerant statement may swallow.
 *
 * Measured, not assumed, against local D1 — and against `wrangler d1 execute`,
 * because the two drivers surface it differently and the matcher has to serve
 * both:
 *
 * - binding: a plain `Error`, own properties `stack`/`message`/`cause` and
 *   **nothing structured** — no `code`, no `errno`. `message` is
 *   `D1_ERROR: duplicate column name: sniffed_type: SQLITE_ERROR`, and `cause`
 *   is an `Error` carrying the same text without the `D1_ERROR:` prefix.
 * - wrangler: exit code 1, stderr `✘ [ERROR] duplicate column name:
 *   sniffed_type: SQLITE_ERROR`, no `D1_ERROR:` prefix at all.
 *
 * So SQLite's text is the only thing both agree on, which is why the matcher
 * keys on the text and not on the wrapper. It is specific: of every failure
 * spiked — `no such table`, `no such column`, `near "…": syntax error`,
 * `UNIQUE constraint failed`, `Cannot add a column to a view` — none contains
 * this phrase. `no such column` is the nearest miss, which is why the whole
 * phrase is required rather than something looser about columns.
 */
const DUPLICATE_COLUMN = 'duplicate column name:'

/**
 * Whether some text D1 produced is reporting a duplicate column.
 *
 * Takes text rather than an error because the CLI driver has no error to
 * inspect — it has an exit code and a stderr buffer. One phrase, one place,
 * two drivers.
 */
export function reportsDuplicateColumn(text: string): boolean {
  return text.includes(DUPLICATE_COLUMN)
}

/** True only for the duplicate-column failure. See `DUPLICATE_COLUMN`. */
export function isDuplicateColumnError(error: unknown): boolean {
  return messagesOf(error).some(reportsDuplicateColumn)
}

/**
 * Both the wrapper's message and its `cause`'s, because only one of them is
 * guaranteed to survive: the prefix is D1's, the text underneath is SQLite's,
 * and which layer a future runtime hands over is not ours to decide.
 */
function messagesOf(error: unknown): string[] {
  if (!(error instanceof Error)) return []
  return [error.message, ...messagesOf(error.cause)]
}

/**
 * Bookkeeping for the migration system itself, so it sits **outside** the
 * migration list rather than inside migration 1.
 *
 * It cannot be versioned by the thing it versions: whatever records "we are at
 * version n" has to exist before the first version is applied. Keeping it in
 * migration 1 also silently coupled every migration run to migration 1 being
 * present — which a test caught, by running a list that did not include it.
 *
 * Applied first by every driver, and idempotent like everything else.
 */
export const META_STATEMENT = `CREATE TABLE IF NOT EXISTS ${META_TABLE} (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'init',
    statements: [
      // CONTACT: who sent something, per channel.
      `CREATE TABLE IF NOT EXISTS contacts (
         id           TEXT PRIMARY KEY,
         channel      TEXT NOT NULL,
         external_id  TEXT NOT NULL,
         display_name TEXT,
         first_seen   INTEGER NOT NULL,
         last_seen    INTEGER NOT NULL,
         UNIQUE (channel, external_id)
       )`,

      `CREATE TABLE IF NOT EXISTS conversations (
         id               TEXT PRIMARY KEY,
         inbox_key        TEXT NOT NULL,
         channel          TEXT NOT NULL,
         provider_key     TEXT,
         title            TEXT,
         title_norm       TEXT,
         first_message_at INTEGER NOT NULL,
         last_message_at  INTEGER NOT NULL,
         message_count    INTEGER NOT NULL DEFAULT 0
       )`,
      `CREATE INDEX IF NOT EXISTS idx_conv_inbox_recent
         ON conversations(inbox_key, last_message_at DESC)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_provider
         ON conversations(inbox_key, channel, provider_key)
         WHERE provider_key IS NOT NULL`,

      // CONTENT: the payload, stored once however many inboxes received it.
      //
      // `has_attachments` is about the message as it **arrived**, not about
      // how many `attachments` rows hang off it — the caps can drop every one
      // of them, and a flag bound to the survivors would state that a message
      // carrying a 21 MB PDF carried nothing. See `hadAttachments` in
      // `store.ts`. So `has_attachments = 1` with no `attachments` rows is a
      // real state, and it is the query for "what did the caps truncate".
      `CREATE TABLE IF NOT EXISTS contents (
         id               TEXT PRIMARY KEY,
         channel          TEXT NOT NULL,
         external_id      TEXT,
         raw_sha256       TEXT NOT NULL,
         contact_id       TEXT REFERENCES contacts(id),
         subject          TEXT,
         subject_norm     TEXT,
         body_preview     TEXT,
         text_body        TEXT,
         html_body        TEXT,
         body_r2_key      TEXT,
         raw_r2_key       TEXT NOT NULL,
         raw_content_type TEXT NOT NULL,
         verified         INTEGER NOT NULL DEFAULT 0,
         sent_at          INTEGER,
         size_bytes       INTEGER NOT NULL,
         has_attachments  INTEGER NOT NULL DEFAULT 0,
         meta             TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS idx_contents_external
         ON contents(channel, external_id)`,
      `CREATE INDEX IF NOT EXISTS idx_contents_contact ON contents(contact_id)`,

      // MESSAGE: one arrival. Exactly one inbox, exactly one conversation.
      `CREATE TABLE IF NOT EXISTS messages (
         id              TEXT PRIMARY KEY,
         content_id      TEXT NOT NULL REFERENCES contents(id),
         inbox_key       TEXT NOT NULL,
         conversation_id TEXT NOT NULL REFERENCES conversations(id),
         direction       TEXT NOT NULL DEFAULT 'in',
         target          TEXT,
         tag             TEXT,
         matched_rule    TEXT,
         received_at     INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_messages_inbox
         ON messages(inbox_key, received_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_messages_conv
         ON messages(conversation_id, received_at)`,
      `CREATE INDEX IF NOT EXISTS idx_messages_content ON messages(content_id)`,

      // The primary key is the dedup key (§9.1). Without it, fan-out — two
      // envelope recipients deriving the *same* content_id, which is the whole
      // point of content addressing — appended a second full set of
      // participants to the same content, as did every retry.
      //
      // Keying on the natural triple means a header naming one address twice
      // in `To:` collapses to one row, and if that address arrives with two
      // display names one wins arbitrarily. Acceptable: `name` is cosmetic and
      // never a key (§3.1).
      //
      // No separate index on `content_id`: the composite key's own index
      // already leads with it, so one would only cost writes.
      `CREATE TABLE IF NOT EXISTS participants (
         content_id TEXT NOT NULL REFERENCES contents(id),
         role       TEXT NOT NULL,
         identifier TEXT NOT NULL,
         name       TEXT,
         PRIMARY KEY (content_id, role, identifier)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_participants_ident
         ON participants(identifier)`,

      // `id` is sha256(content_id + ':' + part_index) — see §9.1 and `store.ts`.
      // Part index rather than a hash of the bytes, because the same file
      // attached twice must stay two rows; hashing would silently collapse
      // them. Part order is deterministic for the same bytes, which is the
      // guarantee content addressing already rests on.
      `CREATE TABLE IF NOT EXISTS attachments (
         id         TEXT PRIMARY KEY,
         content_id TEXT NOT NULL REFERENCES contents(id),
         filename   TEXT,
         mime_type  TEXT,
         size_bytes INTEGER NOT NULL,
         r2_key     TEXT NOT NULL,
         cid        TEXT,
         is_inline  INTEGER NOT NULL DEFAULT 0,
         sha256     TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS idx_attachments_content
         ON attachments(content_id)`,

      // Maps any external id we have seen -- including ids only referenced,
      // never received -- to a conversation. Rows for not-yet-received ids are
      // only created by DMARC-passing mail (§8).
      `CREATE TABLE IF NOT EXISTS conversation_index (
         external_id     TEXT NOT NULL,
         inbox_key       TEXT NOT NULL,
         conversation_id TEXT NOT NULL REFERENCES conversations(id),
         received        INTEGER NOT NULL DEFAULT 0,
         PRIMARY KEY (external_id, inbox_key)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_conv_index_conv
         ON conversation_index(conversation_id)`,

      // Ingest failures after the raw bytes are safely in R2 (§7.4).
      `CREATE TABLE IF NOT EXISTS failed_ingest (
         id         TEXT PRIMARY KEY,
         raw_r2_key TEXT NOT NULL,
         channel    TEXT NOT NULL,
         target     TEXT,
         stage      TEXT NOT NULL,
         error      TEXT NOT NULL,
         attempts   INTEGER NOT NULL DEFAULT 1,
         first_seen INTEGER NOT NULL,
         last_seen  INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_failed_last_seen
         ON failed_ingest(last_seen DESC)`,
    ],
  },
]

/** The version the code in this build expects. */
export const CODE_SCHEMA_VERSION: number = MIGRATIONS.reduce(
  (max, m) => Math.max(max, m.version),
  0,
)

/** The statement that records a migration as done. Always applied last. */
export function versionStatement(version: number): string {
  return `INSERT INTO ${META_TABLE} (key, value) VALUES ('${VERSION_KEY}', '${version}')
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`
}

/** The SQL, whichever of the two forms a statement takes. */
export function sqlOf(statement: Statement): string {
  return typeof statement === 'string' ? statement : statement.sql
}

/** A statement is tolerant exactly when it is not a bare string. */
export function isTolerant(statement: Statement): boolean {
  return typeof statement !== 'string'
}

/**
 * One statement, on its own, swallowing its failure only if the statement
 * asked to tolerate it *and* the failure is the one it named.
 *
 * A plain string never swallows anything, so the escape hatch is opt-in per
 * statement and visible at the call site rather than a mode the whole
 * migration runs in.
 *
 * Switching on `tolerate` rather than on "is it tolerant" is what keeps a
 * second member of the union from silently inheriting the duplicate-column
 * matcher: an unrecognised one falls through and throws.
 */
async function apply(db: D1Database, statement: Statement): Promise<void> {
  try {
    await db.prepare(sqlOf(statement)).run()
  } catch (error) {
    if (typeof statement === 'string') throw error
    if (statement.tolerate === 'duplicate-column') {
      if (isDuplicateColumnError(error)) return
    }
    throw error
  }
}

/**
 * Read the applied schema version. `0` means nothing has been applied — which
 * is also what a database with no `_inbox_meta` table reports, since the
 * absence of the table and the absence of the row mean the same thing.
 */
export async function schemaVersion(db: D1Database): Promise<number> {
  try {
    const row = await db
      .prepare(`SELECT value FROM ${META_TABLE} WHERE key = ?`)
      .bind(VERSION_KEY)
      .first<{ value: string }>()

    const version = Number(row?.value)
    return Number.isInteger(version) && version > 0 ? version : 0
  } catch {
    // No table yet. Not an error worth surfacing: "unmigrated" is a state, and
    // the caller's next move is the same either way.
    return 0
  }
}

/**
 * Apply every migration newer than what is recorded.
 *
 * **For tests and `wrangler dev` only.** This is not a deployment mechanism —
 * production migrates with `inbox-worker migrate` before the deploy, never
 * from inside a running worker (§2.8). It is exported because
 * `createTestEnv()` needs a schema to exist before a test can write anything.
 *
 * Returns the versions it applied, so a caller can tell "already current" from
 * "just migrated" without a second read.
 */
export async function migrate(
  db: D1Database,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<{ applied: number[]; version: number }> {
  // Before anything else, and before reading the version: the table the
  // version lives in is infrastructure, not schema content.
  await db.prepare(META_STATEMENT).run()

  const current = await schemaVersion(db)
  const applied: number[] = []

  for (const migration of [...migrations].sort(
    (a, b) => a.version - b.version,
  )) {
    if (migration.version <= current) continue

    // Schema first, version second, in two batches rather than one.
    //
    // Create-then-use inside a single batch does work — measured against local
    // D1, along with the fact that batch() really is transactional across DDL
    // (a failing statement rolled back an earlier CREATE). But that was
    // miniflare, not production D1, and the version write has to be last on
    // the CLI path regardless. Splitting costs one round trip and makes both
    // drivers behave the same way.
    if (migration.statements.some(isTolerant)) {
      // Sequentially, because `batch()` is a transaction and a transaction has
      // no way to express a swallowed error (§15.1). The unit is the whole
      // migration rather than the one statement: an abort rolls back the
      // entire sequence, so a tolerant statement anywhere in a batch makes the
      // batch unable to tolerate it. The cost is round trips and the loss of
      // rollback, and the second is only affordable because every statement is
      // safe to re-run — see `Migration.statements`.
      for (const statement of migration.statements) {
        await apply(db, statement)
      }
    } else {
      await db.batch(migration.statements.map((s) => db.prepare(sqlOf(s))))
    }

    await db.prepare(versionStatement(migration.version)).run()

    applied.push(migration.version)
  }

  return { applied, version: applied.at(-1) ?? current }
}
