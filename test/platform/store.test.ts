/**
 * Against real local D1 and R2. Every question here — does `INSERT OR IGNORE`
 * on a composite key really collapse a duplicate, does a batch honour foreign
 * keys, does the same content-addressed key overwrite or accumulate — is a
 * question about the platform, and a mock would answer them the way I expected.
 */

import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, test } from 'vitest'
import { applyCaps, DEFAULT_CAPS } from '../../src/caps'
import type { Inbound } from '../../src/inbound'
import { migrate } from '../../src/migrations'
import { parseEmail } from '../../src/mime'
import { type StoreRequest, storeInbound } from '../../src/store'
import {
  HOSTILE_FILENAMES,
  HTML_ONLY,
  INLINE_AND_ATTACHMENT,
  NO_FROM,
  OVERSIZED_BODY,
  PLAIN_TEXT,
} from '../fixtures/email'

const db = () => env.INBOX_DB
const bucket = () => env.INBOX_BUCKET

const RECEIVED = new Date('2025-01-14T10:00:00Z')

/**
 * Child-first, and rows before tables. D1 enforces foreign keys and ignores
 * `PRAGMA foreign_keys = OFF` — measured — so dropping `contents` while a
 * `messages` row still points at it fails with a constraint error rather than
 * cascading.
 */
const TABLES = [
  'failed_ingest',
  'conversation_index',
  'attachments',
  'participants',
  'messages',
  'contents',
  'contacts',
  'conversations',
  '_inbox_meta',
]

/**
 * Explicit reset. Storage is not isolated per test, and every assertion here
 * counts rows — a leftover row from the previous test would turn "written
 * once" into "written twice" and the failure would blame the wrong code.
 */
beforeEach(async () => {
  for (const name of TABLES) {
    await db().prepare(`DROP TABLE IF EXISTS "${name}"`).run()
  }
  await migrate(db())

  const listed = await bucket().list({ limit: 1000 })
  for (const object of listed.objects) await bucket().delete(object.key)
})

/** Conversations are resolved by the step after this one (§8). */
async function conversation(id: string, inboxKey: string): Promise<void> {
  await db()
    .prepare(
      `INSERT OR IGNORE INTO conversations
         (id, inbox_key, channel, first_message_at, last_message_at)
       VALUES (?, ?, 'email', ?, ?)`,
    )
    .bind(id, inboxKey, RECEIVED.getTime(), RECEIVED.getTime())
    .run()
}

function parse(
  raw: Uint8Array,
  target: string,
  receivedAt: Date = RECEIVED,
): Promise<Inbound> {
  return parseEmail(raw, { target, receivedAt })
}

function request(
  message: Inbound,
  inboxKey: string,
  conversationId: string,
): StoreRequest {
  return { message, inboxKey, conversationId }
}

const count = async (table: string): Promise<number> => {
  const row = await db()
    .prepare(`SELECT count(*) AS n FROM ${table}`)
    .first<{ n: number }>()
  return row?.n ?? 0
}

const contentRow = async (): Promise<Record<string, unknown>> => {
  const row = await db().prepare('SELECT * FROM contents').first()
  if (row === null) throw new Error('no contents row was written')
  return row
}

const keys = async (): Promise<string[]> => {
  const listed = await bucket().list({ limit: 1000 })
  return listed.objects.map((o) => o.key).sort()
}

describe('replaying the same message', () => {
  test('writes one of everything, children included', async () => {
    // The whole point of deriving ids from content: a redelivery — Cloudflare
    // retrying, an operator replaying a dead letter — must be a no-op. Before
    // §9.1 `contents` and `messages` collapsed but participants and
    // attachments did not, so every retry appended duplicate children to the
    // same content.
    await conversation('v-sales', 'sales')
    const message = await parse(PLAIN_TEXT, 'sales@example.org')

    const first = await storeInbound(
      { db: db(), bucket: bucket() },
      request(message, 'sales', 'v-sales'),
    )
    const second = await storeInbound(
      { db: db(), bucket: bucket() },
      request(message, 'sales', 'v-sales'),
    )

    expect(second.contentId).toBe(first.contentId)
    expect(second.messageId).toBe(first.messageId)

    expect(await count('contents')).toBe(1)
    expect(await count('messages')).toBe(1)
    expect(await count('contacts')).toBe(1)
    expect(await count('participants')).toBe(1)
    expect(await keys()).toHaveLength(1)
  })
})

describe('two envelope recipients', () => {
  test('share one content and one raw object, and add a message each', async () => {
    // Fan-out is two invocations of the worker with byte-identical content
    // (§4), so both derive the *same* content_id — that is the point of
    // content addressing, not an accident. Everything hanging off the content
    // must therefore be written once; only the arrival is per inbox.
    await conversation('v-sales', 'sales')
    await conversation('v-billing', 'billing')

    const toSales = await parse(INLINE_AND_ATTACHMENT, 'sales@example.org')
    const toBilling = await parse(INLINE_AND_ATTACHMENT, 'billing@example.org')

    const sales = await storeInbound(
      { db: db(), bucket: bucket() },
      request(toSales, 'sales', 'v-sales'),
    )
    const billing = await storeInbound(
      { db: db(), bucket: bucket() },
      request(toBilling, 'billing', 'v-billing'),
    )

    expect(billing.contentId).toBe(sales.contentId)
    expect(billing.messageId).not.toBe(sales.messageId)

    expect(await count('contents')).toBe(1)
    expect(await count('messages')).toBe(2)
    expect(await count('attachments')).toBe(2)
    expect(await count('participants')).toBe(1)

    const inboxes = await db()
      .prepare('SELECT inbox_key FROM messages ORDER BY inbox_key')
      .all<{ inbox_key: string }>()
    expect(inboxes.results.map((r) => r.inbox_key)).toEqual([
      'billing',
      'sales',
    ])

    // One raw object, not two. The envelope recipient differs but the bytes do
    // not, and the key is a hash of the bytes.
    const raw = (await keys()).filter((k) => k.startsWith('raw/'))
    expect(raw).toEqual([sales.rawKey])
  })
})

describe('where the body lives', () => {
  test('a body past the inline limit spills to R2 and nulls the columns', async () => {
    // Both halves matter. Spilling but leaving the text in D1 too would defeat
    // the reason for spilling — list queries scan `contents`, and a row
    // carrying 600 KB of log dump makes every one of them expensive.
    await conversation('v-sales', 'sales')
    const message = await parse(OVERSIZED_BODY, 'sales@example.org')

    const result = await storeInbound(
      { db: db(), bucket: bucket() },
      request(message, 'sales', 'v-sales'),
    )

    const row = await contentRow()
    expect(row.text_body).toBeNull()
    expect(row.html_body).toBeNull()
    expect(row.body_r2_key).toBe(`body/${result.contentId}.json`)
    expect(result.bodyKey).toBe(row.body_r2_key)

    // A preview is still in D1, always — a list view must never have to reach
    // into R2 for something to show.
    expect(row.body_preview).not.toBeNull()
    expect((row.body_preview as string).length).toBe(2048)

    const spilled = await bucket().get(row.body_r2_key as string)
    expect(spilled).not.toBeNull()
    expect(await (spilled as R2ObjectBody).json()).toEqual({
      text: message.text,
    })
  })

  test('an ordinary body stays inline, with no R2 object at all', async () => {
    await conversation('v-sales', 'sales')
    const message = await parse(PLAIN_TEXT, 'sales@example.org')

    const result = await storeInbound(
      { db: db(), bucket: bucket() },
      request(message, 'sales', 'v-sales'),
    )

    const row = await contentRow()
    expect(row.text_body).toBe('Could you send a quote?')
    expect(row.body_r2_key).toBeNull()
    expect(result.bodyKey).toBeUndefined()
    expect((await keys()).filter((k) => k.startsWith('body/'))).toEqual([])
  })
})

describe('attachment keys', () => {
  test('are content hashes with no filename anywhere in them', async () => {
    // The name never reaches the key space (§4), which removes path traversal
    // and header injection from storage structurally rather than by relying on
    // the sanitiser in `mime.ts` being complete. The name is still kept — in
    // D1, where it is data rather than a path.
    await conversation('v-sales', 'sales')
    const message = await parse(INLINE_AND_ATTACHMENT, 'sales@example.org')

    const result = await storeInbound(
      { db: db(), bucket: bucket() },
      request(message, 'sales', 'v-sales'),
    )

    const rows = await db()
      .prepare('SELECT filename, r2_key FROM attachments')
      .all<{ filename: string | null; r2_key: string }>()

    expect(rows.results.map((r) => r.filename).sort()).toEqual([
      null,
      'terms.pdf',
    ])
    for (const key of await keys()) expect(key).not.toContain('terms')

    for (const key of result.attachmentKeys) {
      expect(key).toMatch(
        new RegExp(`^att/${result.contentId}/[0-9a-f]{64}$`, 'u'),
      )
    }
  })

  test('survive names built to escape the place they are written', async () => {
    // Names decoded from RFC 2047: traversal, absolute path, Windows path,
    // CRLF injection, all-dots, overlong, and the line-terminator variants
    // that once defeated the basename strip entirely. None of them can reach
    // the key, so none of them can reach a bucket path.
    await conversation('v-sales', 'sales')
    const message = await parse(HOSTILE_FILENAMES, 'sales@example.org')

    const result = await storeInbound(
      { db: db(), bucket: bucket() },
      request(message, 'sales', 'v-sales'),
    )

    // Derived, not a literal. This asserted `6` and broke the moment the
    // fixture grew — a count is not what this test protects, and hard-coding
    // it turns every new hostile name into a false failure here.
    expect(result.attachmentKeys).toHaveLength(message.attachments.length)
    expect(result.attachmentKeys.length).toBeGreaterThan(0)
    for (const key of result.attachmentKeys) {
      expect(key).toMatch(
        new RegExp(`^att/${result.contentId}/[0-9a-f]{64}$`, 'u'),
      )
    }
  })
})

describe('the contact behind a message', () => {
  test('accumulates across arrivals instead of being overwritten', async () => {
    // Deliberately out of order: the later message is stored first, then an
    // earlier one — which is what `inbox-worker replay` and any backfill look
    // like. A plain assignment on either timestamp gets this wrong, and it
    // gets it wrong silently: the contact simply claims to have first written
    // in March.
    await conversation('v-sales', 'sales')
    const march = await parse(
      HTML_ONLY,
      'sales@example.org',
      new Date('2025-03-01T08:00:00Z'),
    )
    const january = await parse(
      PLAIN_TEXT,
      'sales@example.org',
      new Date('2025-01-14T10:00:00Z'),
    )

    await storeInbound(
      { db: db(), bucket: bucket() },
      request(march, 'sales', 'v-sales'),
    )
    await storeInbound(
      { db: db(), bucket: bucket() },
      request(january, 'sales', 'v-sales'),
    )

    expect(await count('contacts')).toBe(1)
    expect(await count('contents')).toBe(2)

    const contact = await db()
      .prepare('SELECT * FROM contacts')
      .first<Record<string, unknown>>()
    expect(contact?.external_id).toBe('ada@example.com')
    expect(contact?.first_seen).toBe(january.receivedAt.getTime())
    expect(contact?.last_seen).toBe(march.receivedAt.getTime())
  })

  test('keeps a display name a later message does not carry', async () => {
    // Stored in arrival order this time, so the *last* write is the one with
    // no name. Plain assignment blanks a name we already knew, and nothing
    // about the row afterwards says that a name was ever there.
    await conversation('v-sales', 'sales')
    const named = await parse(
      PLAIN_TEXT,
      'sales@example.org',
      new Date('2025-01-14T10:00:00Z'),
    )
    const bare = await parse(
      HTML_ONLY,
      'sales@example.org',
      new Date('2025-03-01T08:00:00Z'),
    )

    await storeInbound(
      { db: db(), bucket: bucket() },
      request(named, 'sales', 'v-sales'),
    )
    await storeInbound(
      { db: db(), bucket: bucket() },
      request(bare, 'sales', 'v-sales'),
    )

    const contact = await db()
      .prepare('SELECT display_name FROM contacts')
      .first<{ display_name: string | null }>()
    expect(contact?.display_name).toBe('Ada Lovelace')
  })

  test('is absent rather than invented when the sender is unreadable', async () => {
    // A placeholder contact would gather every unparseable sender under one
    // identity, merging strangers' history in the reader. `contact_id` is
    // nullable for exactly this.
    await conversation('v-sales', 'sales')
    const message = await parse(NO_FROM, 'sales@example.org')

    await storeInbound(
      { db: db(), bucket: bucket() },
      request(message, 'sales', 'v-sales'),
    )

    expect(await count('contacts')).toBe(0)
    expect((await contentRow()).contact_id).toBeNull()
  })
})

describe('what the caps discarded', () => {
  test('is recorded on the content, not left to a log', async () => {
    // A message stored with 1 of its 2 attachments has to say so where whoever
    // opens it will see it. In a log line it is invisible to the reader and
    // gone by the time anyone asks why the PDF is missing.
    await conversation('v-sales', 'sales')
    const parsed = await parse(INLINE_AND_ATTACHMENT, 'sales@example.org')
    const { message, overflows } = applyCaps(parsed, {
      ...DEFAULT_CAPS,
      attachments: 1,
    })

    await storeInbound(
      { db: db(), bucket: bucket() },
      { message, inboxKey: 'sales', conversationId: 'v-sales', overflows },
    )

    expect(await count('attachments')).toBe(1)
    const meta = JSON.parse((await contentRow()).meta as string)
    expect(meta.overflows).toEqual([
      { cap: 'attachments', limit: 1, found: 2, dropped: 1 },
    ])
  })

  test('never lets the row claim a message arrived with no attachments', async () => {
    // `has_attachments` describes what *arrived*, not what survived the caps.
    //
    // Reachable on the defaults, not just on a lowered cap: `attachmentBytes`
    // is 20 MB and the platform accepts 25 MB inbound, and `byBytes` stops at
    // the first attachment that does not fit rather than skipping it — so one
    // 21 MB attachment leaves `kept: []`. Bound from the capped message, the
    // row then states the message had none, and every `WHERE has_attachments`
    // query skips it silently. The overflow in `meta` says otherwise, so the
    // row also contradicts itself.
    //
    // The lowered cap here reproduces the same `kept: []` in a few hundred
    // bytes. Asserted together with zero `attachments` rows, because the pair
    // is the point: "carried attachments, holds none of them extracted" has to
    // be a state the row can express.
    await conversation('v-sales', 'sales')
    const parsed = await parse(INLINE_AND_ATTACHMENT, 'sales@example.org')
    const { message, overflows } = applyCaps(parsed, {
      ...DEFAULT_CAPS,
      attachmentBytes: 1,
    })
    expect(message.attachments).toEqual([])

    await storeInbound(
      { db: db(), bucket: bucket() },
      { message, inboxKey: 'sales', conversationId: 'v-sales', overflows },
    )

    expect(await count('attachments')).toBe(0)
    expect(
      (await contentRow()).has_attachments,
      'has_attachments says the message carried none, but the byte cap dropped one it did carry',
    ).toBe(1)
  })

  test('says the same when the count cap, not the byte cap, emptied the list', async () => {
    // The two caps are separate `Overflow.cap` values and only one of them can
    // be checked by accident. `applyCaps` takes its caps as an argument, so a
    // deployment that wants raw-only archival can set `attachments: 0` — and
    // that must not turn into the row asserting nothing was attached either.
    //
    // This fails if someone later decides only `attachmentBytes` can empty the
    // list.
    await conversation('v-sales', 'sales')
    const parsed = await parse(INLINE_AND_ATTACHMENT, 'sales@example.org')
    const { message, overflows } = applyCaps(parsed, {
      ...DEFAULT_CAPS,
      attachments: 0,
    })
    expect(overflows.map((o) => o.cap)).toEqual(['attachments'])

    await storeInbound(
      { db: db(), bucket: bucket() },
      { message, inboxKey: 'sales', conversationId: 'v-sales', overflows },
    )

    expect(await count('attachments')).toBe(0)
    expect(
      (await contentRow()).has_attachments,
      'has_attachments says the message carried none, but the count cap dropped the ones it did carry',
    ).toBe(1)
  })

  test('leaves has_attachments false when nothing was attached at all', async () => {
    // The other half. A flag that is true whenever an overflow list is
    // non-empty would pass both tests above and be useless — a `participants`
    // or `references` overflow says nothing about attachments.
    await conversation('v-sales', 'sales')
    const parsed = await parse(PLAIN_TEXT, 'sales@example.org')
    const { message, overflows } = applyCaps(parsed, {
      ...DEFAULT_CAPS,
      participants: 0,
    })
    expect(overflows.map((o) => o.cap)).toEqual(['participants'])

    await storeInbound(
      { db: db(), bucket: bucket() },
      { message, inboxKey: 'sales', conversationId: 'v-sales', overflows },
    )

    expect(
      (await contentRow()).has_attachments,
      'has_attachments claims an attachment that never existed — an unrelated overflow set it',
    ).toBe(0)
  })
})

describe('a key prefix', () => {
  test('moves every object without touching any derived id', async () => {
    // The prefix addresses an object; it does not identify one. Folding it
    // into a hash would give the same message two content ids depending on
    // which deployment stored it, and fan-out dedup would stop working.
    await conversation('v-sales', 'sales')
    const message = await parse(INLINE_AND_ATTACHMENT, 'sales@example.org')

    const plain = await storeInbound(
      { db: db(), bucket: bucket() },
      request(message, 'sales', 'v-sales'),
    )
    const prefixed = await storeInbound(
      { db: db(), bucket: bucket(), prefix: 'tenant-a/' },
      request(message, 'sales', 'v-sales'),
    )

    expect(prefixed.contentId).toBe(plain.contentId)
    expect(prefixed.rawKey).toBe(`tenant-a/${plain.rawKey}`)
    for (const key of prefixed.attachmentKeys) {
      expect(key.startsWith('tenant-a/att/')).toBe(true)
    }
  })
})
