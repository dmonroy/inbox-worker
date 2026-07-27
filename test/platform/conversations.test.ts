/**
 * Threading, against real local D1. Every decision in §8 is about what happens
 * when two writers, two inboxes, or a liar are involved, and none of those
 * survive a mock: `INSERT OR IGNORE` collapsing a duplicate, `ORDER BY` on a
 * TEXT primary key, and foreign keys inside a batch are all SQLite behaviours.
 */

import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, test } from 'vitest'
import {
  type ConversationResult,
  resolveConversation,
} from '../../src/conversations'
import type { Inbound } from '../../src/inbound'
import { migrate } from '../../src/migrations'
import { parseEmail } from '../../src/mime'
import { mail } from '../fixtures/email'

const db = () => env.INBOX_DB

const RECEIVED = new Date('2025-01-14T10:00:00Z')

/**
 * Child-first. D1 enforces foreign keys and ignores `PRAGMA foreign_keys = OFF`
 * (§9.0), so dropping `conversations` while a `conversation_index` row still
 * points at it fails outright.
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

beforeEach(async () => {
  for (const name of TABLES) {
    await db().prepare(`DROP TABLE IF EXISTS "${name}"`).run()
  }
  await migrate(db())
})

/**
 * A message in a reference chain. Only the threading headers vary between
 * these tests, so they are all the fixture takes; the rest is filler that keeps
 * the message a plausible one.
 */
function threaded(fields: {
  id?: string
  inReplyTo?: string
  references?: string[]
  to?: string
  subject?: string
  receivedAt?: Date
}): Promise<Inbound> {
  const to = fields.to ?? 'sales@example.org'
  const bracketed = (id: string) => `<${id}>`

  const raw = mail(
    [
      'From: Ada Lovelace <ada@example.com>',
      `To: ${to}`,
      `Subject: ${fields.subject ?? 'Quote request'}`,
      ...(fields.id === undefined ? [] : [`Message-ID: <${fields.id}>`]),
      ...(fields.inReplyTo === undefined
        ? []
        : [`In-Reply-To: <${fields.inReplyTo}>`]),
      ...(fields.references === undefined
        ? []
        : [`References: ${fields.references.map(bracketed).join(' ')}`]),
    ],
    'Body.\r\n',
  )

  return parseEmail(raw, {
    target: to,
    receivedAt: fields.receivedAt ?? RECEIVED,
  })
}

/** Resolve one message. `verified` is DMARC, and defaults to failing. */
async function resolve(
  message: Inbound,
  inboxKey = 'sales',
  verified = true,
): Promise<ConversationResult> {
  return resolveConversation(db(), { message, inboxKey, verified })
}

const count = async (table: string): Promise<number> => {
  const row = await db()
    .prepare(`SELECT count(*) AS n FROM ${table}`)
    .first<{ n: number }>()
  return row?.n ?? 0
}

const indexed = async (
  externalId: string,
  inboxKey = 'sales',
): Promise<{ conversation_id: string; received: number } | null> =>
  db()
    .prepare(
      `SELECT conversation_id, received FROM conversation_index
       WHERE external_id = ? AND inbox_key = ?`,
    )
    .bind(externalId, inboxKey)
    .first<{ conversation_id: string; received: number }>()

describe('a parent and its reply', () => {
  /**
   * The same two messages every time. The only variable is arrival order, and
   * SMTP guarantees nothing about it — a parent delayed by a greylist or a
   * retry arrives after the reply it caused, routinely.
   */
  const chain = async (): Promise<[Inbound, Inbound]> => [
    await threaded({ id: 'p-1@example.com' }),
    await threaded({
      id: 'r-1@example.com',
      inReplyTo: 'p-1@example.com',
      references: ['p-1@example.com'],
    }),
  ]

  const inOrder = async (messages: Inbound[]): Promise<Set<string>> => {
    const ids = new Set<string>()
    for (const message of messages) {
      ids.add((await resolve(message)).conversationId)
    }
    return ids
  }

  test('are one conversation when the parent arrives first', async () => {
    const [parent, reply] = await chain()

    expect((await inOrder([parent, reply])).size).toBe(1)
    expect(await count('conversations')).toBe(1)
  })

  test('are one conversation when the reply arrives first', async () => {
    // Seeding ids we have not yet received is what §8 says lets "a late-
    // arriving parent join instead of forking". That only works if the
    // parent's own `Message-ID` is looked up — it has no references of its
    // own, so the literal candidate set of §8 step 2 is empty for it and it
    // forks into a second conversation.
    const [parent, reply] = await chain()

    expect((await inOrder([reply, parent])).size).toBe(1)
    expect(await count('conversations')).toBe(1)
  })
})

describe('the conversation row itself', () => {
  test('spans every message in it, in whatever order they arrive', async () => {
    // `idx_conv_inbox_recent` orders an inbox by `last_message_at`, so a
    // conversation that never updates it sinks the moment it gets a second
    // message — the exact opposite of what a reply should do.
    //
    // `min`/`max` rather than assignment, for the same reason `contacts` uses
    // them: `inbox-worker replay` exists, so a message older than everything
    // we hold can arrive after all of it.
    const january = new Date('2025-01-14T10:00:00Z')
    const february = new Date('2025-02-14T10:00:00Z')
    const march = new Date('2025-03-14T10:00:00Z')

    const opened = await resolve(
      await threaded({ id: 'p-1@example.com', receivedAt: february }),
    )
    for (const [id, receivedAt] of [
      ['r-1@example.com', march],
      ['r-2@example.com', january],
    ] as const) {
      await resolve(
        await threaded({ id, inReplyTo: 'p-1@example.com', receivedAt }),
      )
    }

    const row = await db()
      .prepare(
        `SELECT first_message_at, last_message_at, title FROM conversations
         WHERE id = ?`,
      )
      .bind(opened.conversationId)
      .first<{
        first_message_at: number
        last_message_at: number
        title: string | null
      }>()

    expect(row?.first_message_at).toBe(january.getTime())
    expect(row?.last_message_at).toBe(march.getTime())
    // The title is the opening subject and stays put. Letting each reply
    // rewrite it would rename a thread from whatever the last "Re: fwd:"
    // mangling happened to say.
    expect(row?.title).toBe('Quote request')
  })
})

describe('one email delivered to two inboxes', () => {
  test('is two conversations, and each threads on its own', async () => {
    // A conversation belongs to exactly one inbox (§8). One global thread
    // would show sales every reply that was only ever routed to billing, and
    // each inbox's history would stop matching what it was actually sent.
    const first = await threaded({ id: 'x-1@example.com' })
    const sales = await resolve(first, 'sales')
    const billing = await resolve(first, 'billing')

    expect(billing.conversationId).not.toBe(sales.conversationId)
    expect(billing.created).toBe(true)
    expect(await count('conversations')).toBe(2)

    // The same id is indexed twice, once per inbox — the index is scoped, not
    // global, so `sales` can never be joined through `billing`'s history.
    const reply = await threaded({
      id: 'r-1@example.com',
      inReplyTo: 'x-1@example.com',
    })
    expect((await resolve(reply, 'sales')).conversationId).toBe(
      sales.conversationId,
    )
    expect((await resolve(reply, 'billing')).conversationId).toBe(
      billing.conversationId,
    )
  })
})

describe('one message resolved twice at once', () => {
  test('converges on a single conversation without a lock', async () => {
    // There is no lock and no Durable Object (§8), so both invocations read an
    // empty index before either writes. What keeps them together is that the
    // proposed conversation id is *derived* — same message, same inbox, same
    // id — so the second insert collides with the first instead of adding a
    // second conversation for one thread. A random id here would look correct
    // in every sequential test and silently fork under load.
    const message = await threaded({ id: 'x-1@example.com' })

    const [a, b] = await Promise.all([resolve(message), resolve(message)])

    expect(b.conversationId).toBe(a.conversationId)
    expect(await count('conversations')).toBe(1)
    // The index agrees with what both callers were told. A message whose own
    // id points somewhere else would send the next reply to a conversation
    // its parent is not in.
    expect((await indexed('x-1@example.com'))?.conversation_id).toBe(
      a.conversationId,
    )
  })
})

describe('an id seeded before the message itself arrived', () => {
  test('is marked received when the message finally lands', async () => {
    // `received` means "we hold the content" (§9). `INSERT OR IGNORE` on its
    // own leaves a seeded row claiming 0 forever, so anything later asking
    // "have we actually got this message, or only a reference to it?" — a
    // repair pass, a gap report — reads a lie.
    await resolve(
      await threaded({
        id: 'r-1@example.com',
        inReplyTo: 'p-1@example.com',
      }),
    )
    expect((await indexed('p-1@example.com'))?.received).toBe(0)

    const parent = await resolve(await threaded({ id: 'p-1@example.com' }))

    const row = await indexed('p-1@example.com')
    expect(row?.received).toBe(1)
    // Marked, never repointed: the row still names the conversation it was
    // seeded into, which is the one the parent joined.
    expect(row?.conversation_id).toBe(parent.conversationId)
  })
})

describe('a message with no Message-ID', () => {
  test('gets a conversation of its own, not one shared with every other', async () => {
    // Nothing can ever thread to it — there is no id to reference — so the
    // only failure available is grouping unrelated strangers' mail together,
    // which is the same thing that killed subject fallback (§8).
    const first = await resolve(await threaded({ subject: 'One' }))
    const second = await resolve(await threaded({ subject: 'Two' }))

    expect(first.created).toBe(true)
    expect(second.created).toBe(true)
    expect(second.conversationId).not.toBe(first.conversationId)
    expect(await count('conversations')).toBe(2)

    // And no index row: there is no id to key one on, and an empty-string key
    // would be the shared bucket this test exists to prevent.
    expect(await count('conversation_index')).toBe(0)
  })
})

describe('a reference chain longer than the cap', () => {
  test('is read from the tail, and the head is ignored', async () => {
    // The bound is what makes step 3 one statement of fixed size, so it has to
    // hold here even if a caller skipped `applyCaps` or raised its limit — a
    // 4000-entry `References` is one `IN` list D1 will refuse.
    //
    // The tail is the end that is kept, per JWZ: `References` runs oldest to
    // newest and near ancestry is what a reply threads against.
    const ancient = await resolve(await threaded({ id: 'old-1@example.com' }))

    const filler = Array.from(
      { length: 20 },
      (_, i) => `filler-${i}@example.com`,
    )
    const late = await resolve(
      await threaded({
        id: 'late-1@example.com',
        references: ['old-1@example.com', ...filler],
      }),
    )

    expect(late.conversationId).not.toBe(ancient.conversationId)
    expect(late.created).toBe(true)
  })

  test('still honours In-Reply-To, which is never trimmed', async () => {
    // `In-Reply-To` is a single header naming the immediate parent, so it is
    // unioned with the trimmed tail rather than being part of it. Folding it
    // into the count would let 20 filler references push the one id that
    // actually identifies the parent out of the candidate set.
    const parent = await resolve(await threaded({ id: 'p-1@example.com' }))

    const filler = Array.from(
      { length: 20 },
      (_, i) => `filler-${i}@example.com`,
    )
    const reply = await resolve(
      await threaded({
        id: 'r-1@example.com',
        inReplyTo: 'p-1@example.com',
        references: ['p-1@example.com', ...filler],
      }),
    )

    expect(reply.conversationId).toBe(parent.conversationId)
  })
})

describe('a sender who failed DMARC', () => {
  test('cannot claim an id nobody has received yet', async () => {
    // The thread-hijacking primitive §8 gates against: mail `support@` with
    // `References: <id-you-expect-to-see>` and the real message joins *your*
    // conversation when it lands. Seeding is only allowed to a sender the
    // channel authenticated.
    const forged = await resolve(
      await threaded({
        id: 'forger-1@example.com',
        references: ['victim-1@example.com'],
      }),
      'sales',
      false,
    )

    expect(await indexed('victim-1@example.com')).toBeNull()

    // And the claim does not pay off later: the real message forks into its
    // own conversation rather than joining the forger's.
    const victim = await resolve(await threaded({ id: 'victim-1@example.com' }))
    expect(victim.conversationId).not.toBe(forged.conversationId)
  })

  test('can still join a conversation that already exists', async () => {
    // Only *creating* a row for an unseen id is gated. Refusing the join too
    // would drop every unauthenticated reply — most mailing list traffic —
    // into a conversation of its own.
    const parent = await resolve(await threaded({ id: 'p-1@example.com' }))

    const reply = await resolve(
      await threaded({
        id: 'r-1@example.com',
        inReplyTo: 'p-1@example.com',
      }),
      'sales',
      false,
    )

    expect(reply.conversationId).toBe(parent.conversationId)
    expect(reply.created).toBe(false)
  })
})

describe('a message referencing two conversations', () => {
  test('joins the smaller one and leaves the other alone', async () => {
    // Merging is attacker-writable: `References` is unauthenticated, so one
    // email listing ids harvested from two customer threads would expose each
    // customer's mail in the other's conversation (§8). The cost — a thread
    // that stays split — is the deliberate trade.
    const a = await resolve(await threaded({ id: 'a-1@example.com' }))
    const b = await resolve(await threaded({ id: 'b-1@example.com' }))
    expect(a.conversationId).not.toBe(b.conversationId)

    const merger = await resolve(
      await threaded({
        id: 'm-1@example.com',
        references: ['a-1@example.com', 'b-1@example.com'],
      }),
    )

    const [smaller] = [a.conversationId, b.conversationId].sort()
    expect(merger.conversationId).toBe(smaller)
    expect(merger.created).toBe(false)

    // The loser is untouched — not repointed, not deleted.
    expect(await count('conversations')).toBe(2)
    expect((await indexed('a-1@example.com'))?.conversation_id).toBe(
      a.conversationId,
    )
    expect((await indexed('b-1@example.com'))?.conversation_id).toBe(
      b.conversationId,
    )
    expect((await indexed('m-1@example.com'))?.conversation_id).toBe(smaller)
  })
})
