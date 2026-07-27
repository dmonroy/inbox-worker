/**
 * Draining `failed_ingest`, against real local D1 and R2.
 *
 * The never-throw rule (§7.4) is the most important property in the system and
 * it is only half a guarantee without this: a message that fails is kept, and
 * then has to actually come back. Every test here manufactures a real failure
 * through the real handler rather than inserting a row by hand — a hand-written
 * row would let replay pass against a shape ingest never produces.
 */

import {
  createExecutionContext,
  createScheduledController,
  env,
} from 'cloudflare:test'
import { beforeEach, describe, expect, test } from 'vitest'
import { Email, Team } from '../../src/config'
import { type Env, handlers } from '../../src/handler'
import { migrate } from '../../src/migrations'
import { REPLAY_BATCH, REPLAY_MAX_ATTEMPTS } from '../../src/replay'
import { createTestEnv, mockEmailMessage } from '../../src/testing'
import { mail, NESTED_BOMB, PLAIN_TEXT } from '../fixtures/email'

const EDGE = 'mx.cloudflare.net'

const { email, scheduled } = handlers({
  inboxes: { sales: Team('Sales'), billing: Team('Billing') },
  channels: [Email({ domain: 'example.org', authservId: EDGE })],
})

const db = () => env.INBOX_DB
const bucket = () => env.INBOX_BUCKET

beforeEach(async () => {
  await createTestEnv(env)
})

async function deliver(
  opts: { to?: string; raw?: Uint8Array | string } = {},
): Promise<void> {
  const message = mockEmailMessage({
    to: 'sales@example.org',
    from: 'ada@example.com',
    ...opts,
  })
  message.setReject = () => {}
  await email(message, env as Env, createExecutionContext())
}

/** One cron tick. */
async function drain(): Promise<void> {
  await scheduled(
    createScheduledController(),
    env as Env,
    createExecutionContext(),
  )
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

/**
 * Take `contents` away, deliver, put it back.
 *
 * The cheapest reachable failure *after* the parse succeeded, which is the
 * interesting kind: the message is fine and the deployment was not, so a
 * replay should simply work. A parser bomb fails identically forever and
 * proves nothing about recovery.
 */
async function failWhileStoring(
  deliveries: () => Promise<void>,
): Promise<void> {
  await db().prepare('DROP TABLE contents').run()
  try {
    await deliveries()
  } finally {
    // `migrate()` short-circuits on the recorded version, so forgetting the
    // version is what makes it run again and recreate the table.
    await db().prepare('DELETE FROM _inbox_meta').run()
    await migrate(db())
  }
}

describe('a message that failed after its bytes were safe', () => {
  test('is delivered by the next replay, and stops being a dead letter', async () => {
    await failWhileStoring(() => deliver({ raw: PLAIN_TEXT }))

    expect(await count('failed_ingest')).toBe(1)
    expect(await count('messages')).toBe(0)

    await drain()

    expect(await count('failed_ingest')).toBe(0)
    const message = await one('SELECT * FROM messages')
    expect(message.inbox_key).toBe('sales')
    expect(message.target).toBe('sales@example.org')

    const content = await one('SELECT * FROM contents')
    expect(content.subject).toBe('Quote request')
    // The row points at the object that was already there. Nothing was
    // re-uploaded under a second key, and the pointer is the one the dead
    // letter carried.
    expect((await bucket().list()).objects).toHaveLength(1)
  })
})

describe('a dead letter whose message already got through', () => {
  test('is dropped without writing anything twice', async () => {
    // Reachable without any bug: the first delivery fails at store, the sender
    // or the edge redelivers, the second succeeds, and the dead letter is now
    // stale. Replay has to be a no-op over it, not a second arrival.
    await failWhileStoring(() => deliver({ raw: PLAIN_TEXT }))
    await deliver({ raw: PLAIN_TEXT })

    const before = await snapshot()
    expect(before).toEqual({
      contents: 1,
      messages: 1,
      conversations: 1,
      participants: 1,
      contacts: 1,
      objects: 1,
      messageCount: 1,
    })

    await drain()

    expect(await snapshot()).toEqual(before)
    expect(await count('failed_ingest')).toBe(0)
  })
})

describe('a message that fails again', () => {
  test('counts the attempt rather than spinning on it', async () => {
    // A parser bomb fails identically forever (§7.4). The dead letter must
    // survive that with a number that goes up, because the alternatives are a
    // row that disappears — losing the pointer to the only copy — or a batch
    // slot consumed by the same message on every run for the rest of time.
    await deliver({ raw: NESTED_BOMB })
    expect(await attempts()).toBe(1)

    await drain()
    expect(await attempts()).toBe(2)
    expect((await one('SELECT * FROM failed_ingest')).stage).toBe('parse')

    await drain()
    expect(await attempts()).toBe(3)

    // Still exactly one row, and the raw bytes are still there to replay.
    expect(await count('failed_ingest')).toBe(1)
    expect((await bucket().list()).objects).toHaveLength(1)
  })

  test('is parked once it runs out of attempts, not deleted', async () => {
    await deliver({ raw: NESTED_BOMB })

    // The live failure was attempt 1, so this is the last one it gets.
    for (let i = 1; i < REPLAY_MAX_ATTEMPTS; i++) await drain()
    expect(await attempts()).toBe(REPLAY_MAX_ATTEMPTS)

    await drain()
    await drain()

    // Untouched, not retried and not swept: the row is the only pointer to a
    // raw object that §4 says must never be deleted as garbage.
    expect(await attempts()).toBe(REPLAY_MAX_ATTEMPTS)
    expect(await count('failed_ingest')).toBe(1)
    expect((await bucket().list()).objects).toHaveLength(1)
  })
})

describe('the batch bound', () => {
  test('caps one run, and the next run picks up the rest', async () => {
    // Draining everything in one invocation is how a dead letter becomes
    // undrainable: past D1's 1,000-queries-per-invocation limit the run fails
    // as a whole, identically, every time.
    const bulk = REPLAY_BATCH + 3

    await failWhileStoring(async () => {
      for (let i = 0; i < bulk; i++) {
        await deliver({ raw: distinct(i) })
      }
    })
    expect(await count('failed_ingest')).toBe(bulk)

    await drain()
    expect(await count('messages')).toBe(REPLAY_BATCH)
    expect(await count('failed_ingest')).toBe(bulk - REPLAY_BATCH)

    await drain()
    expect(await count('messages')).toBe(bulk)
    expect(await count('failed_ingest')).toBe(0)
  })
})

describe('replaying does not reorder the archive', () => {
  test('keeps the time the message arrived, not the time it was drained', async () => {
    // `received_at` is the only trusted ordering field (§3.1) and it is what
    // an inbox sorts on. Stamping `Date.now()` on a drained backlog would put
    // a week of old mail at the top of the list, which is a data change
    // dressed up as a recovery.
    await failWhileStoring(() => deliver({ raw: PLAIN_TEXT }))
    const arrived = Number(
      (await one('SELECT * FROM failed_ingest')).first_seen,
    )

    await drain()

    expect((await one('SELECT * FROM messages')).received_at).toBe(arrived)
  })
})

describe('routing is resolved again at replay time', () => {
  const withSupport = handlers({
    inboxes: { sales: Team('Sales'), support: Team('Support') },
    channels: [Email({ domain: 'example.org', authservId: EDGE })],
  })

  const elsewhere = handlers({
    inboxes: { sales: Team('Sales') },
    channels: [Email({ domain: 'example.net', authservId: EDGE })],
  })

  test('so mail that quarantined lands in an inbox added since', async () => {
    // The reason the row records the envelope address and not the inbox it
    // resolved to. Freezing the old answer would make replay re-deliver a
    // message to a queue the operator has just fixed.
    await failWhileStoring(() => deliver({ to: 'support@example.org' }))

    await withSupport.scheduled(
      createScheduledController(),
      env as Env,
      createExecutionContext(),
    )

    expect((await one('SELECT * FROM messages')).inbox_key).toBe('support')
  })

  test('and a domain nobody declares any more is recorded, not crashed on', async () => {
    await failWhileStoring(() => deliver({ raw: PLAIN_TEXT }))

    await elsewhere.scheduled(
      createScheduledController(),
      env as Env,
      createExecutionContext(),
    )

    const failure = await one('SELECT * FROM failed_ingest')
    expect(failure.stage).toBe('targets')
    expect(failure.attempts).toBe(2)
    expect(await count('messages')).toBe(0)
  })
})

describe('the raw object is gone', () => {
  test('is recorded as a fetch failure rather than throwing', async () => {
    // Not hypothetical: someone reads §4's "orphaned R2 objects" note
    // backwards and sweeps `raw/`, or `INBOX_PREFIX` changes under a backlog.
    await deliver({ raw: NESTED_BOMB })
    const key = String((await one('SELECT * FROM failed_ingest')).raw_r2_key)
    await bucket().delete(key)

    await drain()

    const failure = await one('SELECT * FROM failed_ingest')
    expect(failure.stage).toBe('fetch')
    expect(String(failure.error)).toContain(key)
    expect(failure.attempts).toBe(2)
  })
})

describe('the raw key is read as recorded, never rebuilt', () => {
  test('so a backlog survives INBOX_PREFIX changing under it', async () => {
    // `INBOX_PREFIX` is a deployment fact, not a content one (§2.7), so it can
    // differ between the invocation that failed and the one that drains. The
    // dead letter carries the whole key for exactly that reason; deriving it
    // from the current prefix plus the hash would look right and read from a
    // key that has nothing in it.
    const message = mockEmailMessage({ to: 'sales@example.org' })
    message.setReject = () => {}

    await failWhileStoring(async () => {
      await email(
        message,
        { ...(env as Env), INBOX_PREFIX: 'old/' },
        createExecutionContext(),
      )
    })

    const key = String((await one('SELECT * FROM failed_ingest')).raw_r2_key)
    expect(key).toMatch(/^old\/raw\//)

    await scheduled(
      createScheduledController(),
      { ...(env as Env), INBOX_PREFIX: 'new/' },
      createExecutionContext(),
    )

    expect(await count('failed_ingest')).toBe(0)
    expect((await one('SELECT * FROM contents')).raw_r2_key).toBe(key)
  })
})

describe('the scheduled handler', () => {
  test('never throws, whatever the deployment is missing', async () => {
    // Same rule as ingest, different reason: a cron that throws is a failed
    // run nobody is looking at, and the mail it concerns is safe in R2 either
    // way. There is nothing useful to propagate to.
    await deliver({ raw: NESTED_BOMB })

    for (const broken of [
      { INBOX_DB: undefined as unknown as D1Database },
      { INBOX_BUCKET: undefined as unknown as R2Bucket },
    ]) {
      await expect(
        scheduled(
          createScheduledController(),
          { ...(env as Env), ...broken },
          createExecutionContext(),
        ),
      ).resolves.toBeUndefined()
    }

    // And it changed nothing on the way past.
    expect(await attempts()).toBe(1)
  })
})

/** Distinct bytes, so each delivery is its own content and its own dead letter. */
function distinct(i: number): Uint8Array {
  return mail(
    [
      'From: Ada Lovelace <ada@example.com>',
      'To: sales@example.org',
      `Subject: Bulk ${i}`,
      `Message-ID: <bulk-${i}@example.com>`,
    ],
    `Message number ${i}.\r\n`,
  )
}

const attempts = async (): Promise<number> =>
  Number((await one('SELECT * FROM failed_ingest')).attempts)

/** Everything a second arrival would change. */
async function snapshot(): Promise<Record<string, number>> {
  const conversation = await db()
    .prepare('SELECT sum(message_count) AS n FROM conversations')
    .first<{ n: number | null }>()

  return {
    contents: await count('contents'),
    messages: await count('messages'),
    conversations: await count('conversations'),
    participants: await count('participants'),
    contacts: await count('contacts'),
    objects: (await bucket().list()).objects.length,
    messageCount: conversation?.n ?? 0,
  }
}
