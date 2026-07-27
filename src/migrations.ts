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

export interface Migration {
  version: number
  name: string
  /**
   * DDL, in order. **Every statement must be safe to re-run.**
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
  statements: string[]
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
    await db.batch(migration.statements.map((sql) => db.prepare(sql)))
    await db.prepare(versionStatement(migration.version)).run()

    applied.push(migration.version)
  }

  return { applied, version: applied.at(-1) ?? current }
}
