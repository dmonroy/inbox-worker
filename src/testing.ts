/**
 * The test harness consumers get, at `inbox-worker/testing` (§12).
 *
 * Shipped rather than kept internal because the ingest path cannot be
 * exercised any other way: `wrangler dev` cannot receive mail and webhooks
 * need a public URL, so mocks are the primary development loop rather than a
 * fallback. A package that can only be tested by its own repo is reusable but
 * not usable.
 *
 * A second entry point rather than part of the main one, so nothing here is
 * reachable from production code by autocomplete alone.
 *
 * `D1Database`, `R2Bucket` and `ForwardableEmailMessage` are ambient globals
 * from `@cloudflare/workers-types`, and the emitted `.d.ts` names them without
 * declaring them — which is why that package is a **peer dependency** rather
 * than only a dev one. A consumer whose tsconfig does not list it gets `any`
 * under `skipLibCheck` and `Cannot find name` without it; both were measured.
 *
 * A `/// <reference types>` here would be the tidier fix, and does not work:
 * tsc strips it from the declaration output rather than passing it on.
 * Importing the types as a module does not work either — the package has no
 * `types` or `main` field, so it only resolves under `moduleResolution:
 * bundler`, and would break any consumer on `node16`.
 */

import { META_STATEMENT, MIGRATIONS, migrate } from './migrations.js'

const encoder = new TextEncoder()

export interface MockEmailOptions {
  /** Envelope sender. Not the `From:` header — see `mockEmailMessage`. */
  from?: string
  /** Envelope recipient. Not the `To:` header — see `mockEmailMessage`. */
  to?: string
  /** Wire bytes. A string is encoded as UTF-8. */
  raw?: Uint8Array | string
  /** Added to, and overriding, whatever `raw`'s header block already carries. */
  headers?: Record<string, string>
}

const DEFAULT_FROM = 'sender@example.com'
const DEFAULT_TO = 'recipient@example.org'

/**
 * A stand-in for the `ForwardableEmailMessage` an Email Worker receives.
 *
 * **Envelope and headers are separate inputs on purpose.** `from` and `to` are
 * the SMTP envelope, and a message addressed to `sales@` and `billing@`
 * arrives as two invocations with identical bytes and different `to` (§4).
 * Deriving them from the `To:` header would make fan-out — the thing that
 * forces the whole content/message split — impossible to write a test for.
 *
 * Headers, by contrast, *are* read out of `raw`, so a test cannot assert on a
 * `Message-ID` that is nowhere in the bytes the parser will see.
 *
 * `raw` is one `ReadableStream`, built once. Nothing here makes it single-use;
 * it is single-use because that is what a `ReadableStream` is, which is the
 * only way to be sure the mock cannot be more forgiving than the runtime
 * (§4.1).
 */
export function mockEmailMessage(
  opts: MockEmailOptions = {},
): ForwardableEmailMessage {
  const from = opts.from ?? DEFAULT_FROM
  const to = opts.to ?? DEFAULT_TO

  const raw =
    opts.raw === undefined
      ? defaultMessage(from, to)
      : typeof opts.raw === 'string'
        ? encoder.encode(opts.raw)
        : opts.raw

  const headers = parseHeaders(raw)
  for (const [name, value] of Object.entries(opts.headers ?? {})) {
    headers.set(name, value)
  }

  return {
    from,
    to,
    rawSize: raw.byteLength,
    headers,
    raw: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(raw)
        controller.close()
      },
    }),
    // Inert, not throwing. The ingest path must never throw once the bytes are
    // in R2 (§7.4); a harness that blew up here would make that untestable.
    setReject() {},
    forward: async () => ({ messageId: MOCK_SEND_ID }),
    reply: async () => ({ messageId: MOCK_SEND_ID }),
  }
}

const MOCK_SEND_ID = '<mock-send@example.com>'

/**
 * Deterministic — no clock, no counter. A default that changed between runs
 * would make a hash or a threading assertion flap for reasons unrelated to the
 * code under test.
 *
 * The header addresses mirror the envelope so the default is not
 * self-contradictory. Real mail routinely differs, which is why they are two
 * options rather than one.
 */
function defaultMessage(from: string, to: string): Uint8Array {
  return encoder.encode(
    [
      `From: ${from}`,
      `To: ${to}`,
      'Subject: Test message',
      'Message-ID: <mock-1@example.com>',
      'Date: Tue, 14 Jan 2025 09:30:00 +0000',
      '',
      'Test body.',
      '',
    ].join('\r\n'),
  )
}

const LF = 0x0a
const CR = 0x0d

/**
 * The header block, as a `Headers` — the same type the runtime hands over.
 *
 * Only the bytes before the blank line are decoded. The body is arbitrary
 * bytes and may not be valid UTF-8, and a body line shaped like a header is
 * not a header — treating it as one is how a hostile sender injects whatever
 * it likes.
 */
function parseHeaders(raw: Uint8Array): Headers {
  const headers = new Headers()

  const block = new TextDecoder()
    .decode(raw.subarray(0, endOfHeaders(raw)))
    // Unfold first. A folded value is one value split across continuation
    // lines; reading only its first line is the classic threading bug, since
    // long `References` chains are exactly what gets folded (§8).
    .replace(/\r?\n(?=[ \t])/g, '')

  for (const line of block.split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue

    try {
      headers.append(line.slice(0, colon), line.slice(colon + 1).trim())
    } catch {
      // A name or value the `Headers` type rejects. Fixtures are deliberately
      // hostile (§12), and a harness that threw while building the mock would
      // fail before the code under test ever ran — which is the opposite of
      // what those fixtures are for.
    }
  }

  return headers
}

/** Offset of the blank line that ends the header block, or the whole message. */
function endOfHeaders(raw: Uint8Array): number {
  let start = 0

  while (start < raw.length) {
    const lf = raw.indexOf(LF, start)
    if (lf === -1) break

    const contentEnd = raw[lf - 1] === CR ? lf - 1 : lf
    if (contentEnd === start) return start

    start = lf + 1
  }

  return raw.length
}

/** The bindings the package resolves by name (§2.7). */
export interface TestBindings {
  INBOX_DB: D1Database
  INBOX_BUCKET: R2Bucket
}

const CREATE_TABLE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)/i

const tableName = (sql: string): string | undefined =>
  CREATE_TABLE.exec(sql)?.[1]

/** Derived rather than repeated — `migrations.ts` keeps the name private. */
const META_TABLE = tableName(META_STATEMENT)

/**
 * Every table this package owns, in the order the schema creates them.
 *
 * Derived from the migration statements rather than written out, because a
 * second hand-maintained list of table names is a list that goes stale — and
 * the way it fails is one test quietly seeing another test's rows.
 *
 * Exported because a consumer pointing `INBOX_DB` at a database they already
 * use is entitled to know exactly which names this package claims.
 */
export const INBOX_TABLES: readonly string[] = [
  ...new Set(
    [META_STATEMENT, ...MIGRATIONS.flatMap((m) => m.statements)]
      .map(tableName)
      .filter((name) => name !== undefined),
  ),
]

/**
 * A migrated, empty environment — the bindings back, with a schema in place
 * and nothing in it.
 *
 * The pool does not isolate storage between tests in this version, so a
 * `beforeEach` that only migrates would hand each test the previous test's
 * rows. That is worse than no reset at all: content is addressed by the hash
 * of its own bytes (§9), so a leftover object or row is byte-identical to the
 * one the current test means to create, and satisfies every assertion about it
 * existing while the code that should have written it never ran.
 *
 * `migrate()` here is the exception §2.8 allows, not a change to the rule: the
 * worker itself still never migrates.
 */
export async function createTestEnv<E extends TestBindings>(
  env: E,
): Promise<E> {
  await migrate(env.INBOX_DB)
  await clearTables(env.INBOX_DB)
  await clearBucket(env.INBOX_BUCKET)
  return env
}

async function clearTables(db: D1Database): Promise<void> {
  // Reverse creation order, so a child is emptied before whatever it
  // references. D1 enforces foreign keys and ignores `PRAGMA foreign_keys =
  // OFF` (§9.0), so this ordering is the only lever there is.
  //
  // `_inbox_meta` is skipped rather than cleared: it records the version of
  // the schema that is still standing, so wiping it would leave the database
  // claiming to be unmigrated while every table still exists.
  const statements = INBOX_TABLES.filter((name) => name !== META_TABLE)
    .reverse()
    .map((name) => db.prepare(`DELETE FROM "${name}"`))

  await db.batch(statements)
}

/**
 * The whole bucket, not a prefix. Keys carry a configurable prefix (§9), so
 * there is nothing reliable to filter on — and unlike D1, the bucket is ours
 * by convention (§2.7) rather than possibly shared.
 */
async function clearBucket(bucket: R2Bucket): Promise<void> {
  let cursor: string | undefined

  do {
    // `exactOptionalPropertyTypes` — `{ cursor: undefined }` is not the same
    // as no options, so the first page has to pass nothing at all.
    const page = cursor === undefined ? undefined : { cursor }
    const listed = await bucket.list(page)

    if (listed.objects.length > 0) {
      await bucket.delete(listed.objects.map((object) => object.key))
    }
    cursor = listed.truncated ? listed.cursor : undefined
  } while (cursor !== undefined)
}
