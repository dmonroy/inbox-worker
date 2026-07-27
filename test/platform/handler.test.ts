/**
 * The email handler, end to end, against real local D1 and R2.
 *
 * Nothing here is a mock of storage. Every claim the handler makes — the raw
 * bytes survived, the caps were applied, the gate stayed shut, nothing was
 * written twice — is a claim about what is in a database and a bucket
 * afterwards, and a fake would answer all of them the way I expected.
 */

import { createExecutionContext, env } from 'cloudflare:test'
import { beforeEach, describe, expect, test } from 'vitest'
import { Email, Team } from '../../src/config'
import { type Env, handlers } from '../../src/handler'
import { migrate } from '../../src/migrations'
import { createTestEnv, mockEmailMessage } from '../../src/testing'
import {
  mail,
  manyAttachments,
  NESTED_BOMB,
  PLAIN_TEXT,
} from '../fixtures/email'

/** The edge this deployment believes. See `src/dmarc.ts`. */
const EDGE = 'mx.cloudflare.net'

const { email } = handlers({
  inboxes: { sales: Team('Sales'), billing: Team('Billing') },
  channels: [Email({ domain: 'example.org', authservId: EDGE })],
})

const db = () => env.INBOX_DB
const bucket = () => env.INBOX_BUCKET

beforeEach(async () => {
  await createTestEnv(env)
})

interface Delivery {
  to?: string
  from?: string
  raw?: Uint8Array | string
}

/**
 * One invocation of the Email Worker.
 *
 * `setReject` is replaced rather than spied on: the harness ships it inert so
 * that a handler calling it cannot blow up a test (§7.4), which also means
 * there is nothing to assert against without doing this.
 */
async function deliver(
  opts: Delivery = {},
  bindings: Partial<Env> = {},
): Promise<{ rejected: string[] }> {
  const message = mockEmailMessage({
    to: 'sales@example.org',
    from: 'ada@example.com',
    ...opts,
  })
  const rejected: string[] = []
  message.setReject = (reason: string) => {
    rejected.push(reason)
  }

  await email(
    message,
    { ...(env as Env), ...bindings },
    createExecutionContext(),
  )
  return { rejected }
}

const count = async (table: string): Promise<number> => {
  const row = await db()
    .prepare(`SELECT count(*) AS n FROM ${table}`)
    .first<{ n: number }>()
  return row?.n ?? 0
}

const one = async (sql: string): Promise<Record<string, unknown>> => {
  const row = await db().prepare(sql).first()
  if (row === null) throw new Error(`no row for: ${sql}`)
  return row
}

const keys = async (): Promise<string[]> =>
  (await bucket().list({ limit: 1000 })).objects.map((o) => o.key).sort()

describe('a message to a declared inbox', () => {
  test('lands in that inbox, whole', async () => {
    await deliver({ raw: PLAIN_TEXT })

    const message = await one('SELECT * FROM messages')
    expect(message.inbox_key).toBe('sales')
    expect(message.target).toBe('sales@example.org')
    expect(message.direction).toBe('in')

    const content = await one('SELECT * FROM contents')
    expect(content.subject).toBe('Quote request')
    expect(content.external_id).toBe('plain-1@example.com')

    expect(await count('conversations')).toBe(1)
    expect(await count('contacts')).toBe(1)
  })

  test('stores the raw bytes, all of them, before parsing anything', async () => {
    // `message.raw` is single-use and of unknown length (§4.1). Streaming it
    // straight to R2 does not fail cleanly — it hangs to a five-minute worker
    // timeout — and reading it for R2 *then* parsing leaves a perfect .eml in
    // the bucket beside a row with no subject and no body. Both halves are
    // asserted here, because either one alone passes for the wrong reason.
    await deliver({ raw: PLAIN_TEXT })

    const [rawKey] = (await keys()).filter((k) => k.startsWith('raw/'))
    const object = await bucket().get(rawKey as string)

    expect(object?.size).toBe(PLAIN_TEXT.length)
    expect(object?.httpMetadata?.contentType).toBe('message/rfc822')

    const content = await one('SELECT * FROM contents')
    expect(content.body_preview).toContain('Could you send a quote?')
    expect(content.size_bytes).toBe(PLAIN_TEXT.length)
  })
})

describe('a message that breaks the parser', () => {
  test('is kept and recorded rather than lost', async () => {
    // An exception here becomes a permanent 521 and the sender never retries,
    // so a reachable parser crash is not an error — it is mail loss, and a
    // censorship primitive for anyone who can send mail (§7.4).
    const { rejected } = await deliver({ raw: NESTED_BOMB })

    expect(rejected).toEqual([])

    const [rawKey] = await keys()
    expect(rawKey).toMatch(/^raw\/email\//)
    expect((await bucket().get(rawKey as string))?.size).toBe(
      NESTED_BOMB.length,
    )

    const failure = await one('SELECT * FROM failed_ingest')
    expect(failure.stage).toBe('parse')
    expect(failure.channel).toBe('email')
    expect(failure.target).toBe('sales@example.org')
    expect(failure.raw_r2_key).toBe(rawKey)
    expect(String(failure.error)).toMatch(/nesting depth/i)

    // Nothing half-written. The dead letter is the whole record.
    expect(await count('contents')).toBe(0)
    expect(await count('messages')).toBe(0)
  })

  test('counts attempts instead of accumulating rows on redelivery', async () => {
    await deliver({ raw: NESTED_BOMB })
    await deliver({ raw: NESTED_BOMB })

    expect(await count('failed_ingest')).toBe(1)
    expect((await one('SELECT * FROM failed_ingest')).attempts).toBe(2)
  })
})

describe('the ingest caps', () => {
  test('are applied, and say what they dropped', async () => {
    // `storeInbound` takes the overflow list as an *input* and enforces
    // nothing, so if the handler does not call `applyCaps` the caps do not
    // exist at all. This is the test that they exist.
    await deliver({ raw: manyAttachments(60) })

    expect(await count('attachments')).toBe(50)

    const content = await one('SELECT * FROM contents')
    expect(JSON.parse(String(content.meta)).overflows).toContainEqual({
      cap: 'attachments',
      limit: 50,
      found: 60,
      dropped: 10,
    })
  })
})

describe('the DMARC gate', () => {
  const referencing = (authResults: string[]) =>
    mail([
      ...authResults,
      'From: mallory@example.com',
      'To: sales@example.org',
      'Subject: Re: Your invoice',
      'Message-ID: <claim-1@example.com>',
      // An id this sender has never received. Seeding it means the genuine
      // message, when it arrives, joins *their* conversation (§8).
      'References: <victim-thread@example.com>',
    ])

  const seeded = async (): Promise<string[]> => {
    const { results } = await db()
      .prepare('SELECT external_id FROM conversation_index ORDER BY 1')
      .all<{ external_id: string }>()
    return results.map((r) => r.external_id)
  }

  test('opens for the edge result, seeding the referenced id', async () => {
    await deliver({
      raw: referencing([`Authentication-Results: ${EDGE}; dmarc=pass`]),
    })

    expect(await seeded()).toEqual([
      'claim-1@example.com',
      'victim-thread@example.com',
    ])
    expect((await one('SELECT * FROM contents')).verified).toBe(1)
  })

  test('stays shut for a forged result below the edge result', async () => {
    // The whole reason this is not a substring search. Cloudflare prepends its
    // own header, the sender writes a second one carrying the same
    // authserv-id, and `Headers.get()` joins them into one string in which
    // `dmarc=pass` is present — belonging to the attacker.
    await deliver({
      raw: referencing([
        `Authentication-Results: ${EDGE}; dmarc=fail header.from=example.com`,
        `Authentication-Results: ${EDGE}; dmarc=pass header.from=example.com`,
      ]),
    })

    // The message's own id is indexed unauthenticated and always has been —
    // an accepted residual (§8). The *referenced* id must not be.
    expect(await seeded()).toEqual(['claim-1@example.com'])
    expect((await one('SELECT * FROM contents')).verified).toBe(0)
  })

  test('stays shut when the sender is the only one to have stamped it', async () => {
    await deliver({
      raw: referencing([
        'Authentication-Results: mallory.example.net; dmarc=pass',
      ]),
    })

    expect(await seeded()).toEqual(['claim-1@example.com'])
  })
})

describe('envelope fan-out', () => {
  test('is two arrivals of one content, stored once', async () => {
    // `message.to` is a single envelope recipient, so one email addressed to
    // two of our inboxes is two invocations with identical bytes (§4). That is
    // the case the content/message split exists for.
    await deliver({ to: 'sales@example.org', raw: PLAIN_TEXT })
    await deliver({ to: 'billing@example.org', raw: PLAIN_TEXT })

    expect(await count('contents')).toBe(1)
    expect(await count('messages')).toBe(2)
    expect(await count('participants')).toBe(1)
    expect((await keys()).filter((k) => k.startsWith('raw/'))).toHaveLength(1)

    const { results } = await db()
      .prepare('SELECT inbox_key FROM messages ORDER BY inbox_key')
      .all<{ inbox_key: string }>()
    expect(results.map((r) => r.inbox_key)).toEqual(['billing', 'sales'])

    // One conversation each: a conversation belongs to exactly one inbox (§8).
    expect(await count('conversations')).toBe(2)
  })

  test('a redelivery to the same inbox changes nothing', async () => {
    await deliver({ raw: PLAIN_TEXT })
    await deliver({ raw: PLAIN_TEXT })

    expect(await count('contents')).toBe(1)
    expect(await count('messages')).toBe(1)
    expect(await count('conversations')).toBe(1)
  })
})

describe('message_count', () => {
  const REPLY = mail(
    [
      'From: Grace Hopper <grace@example.com>',
      'To: sales@example.org',
      'Subject: Re: Quote request',
      'Message-ID: <reply-1@example.com>',
      'In-Reply-To: <plain-1@example.com>',
      'References: <plain-1@example.com>',
    ],
    'Yes please.\r\n',
  )

  const counts = async (): Promise<number[]> => {
    const { results } = await db()
      .prepare('SELECT message_count FROM conversations ORDER BY 1')
      .all<{ message_count: number }>()
    return results.map((r) => r.message_count)
  }

  test('counts arrivals, and an ignored redelivery is not one', async () => {
    // The column nobody owned. `resolveConversation` runs first and cannot
    // tell a new arrival from a redelivery it is about to ignore, so this is
    // the assertion that separates counting rows from counting invocations.
    await deliver({ raw: PLAIN_TEXT })
    expect(await counts()).toEqual([1])

    await deliver({ raw: PLAIN_TEXT })
    expect(await counts()).toEqual([1])

    await deliver({ raw: REPLY })
    expect(await counts()).toEqual([2])
    expect(await count('messages')).toBe(2)
  })

  test('is per inbox, like the conversation it is on', async () => {
    await deliver({ to: 'sales@example.org', raw: PLAIN_TEXT })
    await deliver({ to: 'billing@example.org', raw: PLAIN_TEXT })

    // Two conversations, one arrival each — not one conversation with two.
    expect(await counts()).toEqual([1, 1])
  })
})

describe('an address that matches no inbox', () => {
  test('is quarantined, not refused', async () => {
    // Never `setReject()`: it is a permanent SMTP error, so an unknown local
    // part would bounce irrecoverably rather than land somewhere reviewable
    // (§7.2). Quarantine also does not leak which addresses exist.
    const { rejected } = await deliver({ to: 'nobody@example.org' })

    expect(rejected).toEqual([])
    expect((await one('SELECT * FROM messages')).inbox_key).toBe('quarantine')
  })

  test('cannot be aimed at quarantine on purpose', async () => {
    // Mail to `quarantine@` falls *into* quarantine by matching nothing, which
    // is not the same as matching it — or anyone could post to the review
    // queue (§7.2).
    const { rejected } = await deliver({ to: 'quarantine@example.org' })

    expect(rejected).toEqual([])
    expect((await one('SELECT * FROM messages')).inbox_key).toBe('quarantine')
  })
})

describe('a plus-addressed recipient', () => {
  test('lands in the base inbox, carrying the tag', async () => {
    await deliver({ to: 'sales+acme@example.org' })

    const message = await one('SELECT * FROM messages')
    expect(message.inbox_key).toBe('sales')
    expect(message.tag).toBe('acme')
    // The envelope address as it arrived, not the normalised form: it is what
    // the sender actually wrote to.
    expect(message.target).toBe('sales+acme@example.org')
  })
})

describe('the INBOX_PREFIX binding', () => {
  test('scopes every key, so one bucket can hold two deployments', async () => {
    await deliver({ raw: PLAIN_TEXT }, { INBOX_PREFIX: 'staging/' })

    for (const key of await keys()) expect(key).toMatch(/^staging\//)
    expect(String((await one('SELECT * FROM contents')).raw_r2_key)).toMatch(
      /^staging\/raw\//,
    )
  })
})

describe('a failure after the message parsed', () => {
  test('is dead-lettered too, naming the stage it reached', async () => {
    // The never-throw rule is not about the parser specifically. Anything
    // between the R2 write and the commit can fail — an unmigrated schema, D1
    // being unreachable — and the answer is the same every time.
    await db().prepare('DROP TABLE contents').run()

    try {
      const { rejected } = await deliver({ raw: PLAIN_TEXT })

      expect(rejected).toEqual([])
      expect((await keys()).some((k) => k.startsWith('raw/'))).toBe(true)

      const failure = await one('SELECT * FROM failed_ingest')
      expect(failure.stage).toBe('store')
      expect(String(failure.error)).toMatch(/contents/)
    } finally {
      // `createTestEnv()` cannot repair this. It clears rows from a list of
      // tables it expects to exist, and `migrate()` short-circuits on the
      // recorded `schema_version`, so a dropped table stays dropped and every
      // test after this one fails on `no such table`. Forgetting the version
      // is what makes the migration run again.
      await db().prepare('DELETE FROM _inbox_meta').run()
      await migrate(db())
    }
  })
})

describe('a missing binding', () => {
  test('throws for the bucket, because nothing could be kept', async () => {
    // The one binding that gets to be loud. With nowhere to put the bytes
    // there is nothing for a `failed_ingest` row to point at and nothing to
    // replay, so returning success would discard the message silently — and a
    // missing binding is a deploy-time developer error (§2.7).
    await expect(
      deliver({}, { INBOX_BUCKET: undefined as unknown as R2Bucket }),
    ).rejects.toThrow(/INBOX_BUCKET/)
  })

  test('does not throw for the database, because the bytes are safe', async () => {
    // R2 needs no schema and no D1. The bytes land, the dead letter cannot be
    // written, and the loud log is the signal — §2.8's degradation ladder.
    const { rejected } = await deliver(
      {},
      { INBOX_DB: undefined as unknown as D1Database },
    )

    expect(rejected).toEqual([])
    expect((await keys()).some((k) => k.startsWith('raw/'))).toBe(true)
  })
})

describe('a domain nobody declared', () => {
  test('is refused before anything is stored', async () => {
    // The one refusal §7.4 allows, and it has to happen before the R2 write.
    // Mail for an undeclared domain means a zone is pointed here by mistake;
    // quarantining it silently would make a misconfiguration look like
    // ordinary unknown-address traffic (§7.1).
    const { rejected } = await deliver({ to: 'sales@not-ours.example' })

    expect(rejected).toEqual([
      'No mailbox is configured for sales@not-ours.example',
    ])
    expect(await keys()).toEqual([])
    expect(await count('contents')).toBe(0)
    expect(await count('failed_ingest')).toBe(0)
  })
})
