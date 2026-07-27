/**
 * Draining `failed_ingest` (§7.4).
 *
 * The never-throw rule only pays for itself if something picks the backlog up
 * afterwards. Without this, a message that fails is recorded and then sits
 * there forever, and "delayed, never dropped" is only the first half of a
 * sentence.
 *
 * **This runs in the worker, on a cron trigger, not in the CLI.** DESIGN §2.8
 * and §7.4 both name `inbox-worker replay <key>` and that command cannot be
 * written safely: the CLI shells out to `wrangler d1 execute --command`, one
 * statement at a time, with **no bound parameters**. Replaying a message means
 * writing a subject, a body and a filename that a stranger chose into a dozen
 * rows, so a CLI implementation would have to build that SQL by string
 * interpolation from attacker-controlled bytes. Every statement in `store.ts`
 * uses `.bind()` for exactly that reason, and no amount of quoting in a second
 * implementation would be as good as not having a second implementation.
 *
 * The cron handler has the opposite property: it is the *same* code path as
 * live ingest — `runPipeline`, byte for byte — with real D1 and R2 bindings,
 * no public endpoint, no credential, and nothing new for the consumer to
 * secure. All it costs is a `[triggers]` line in their `wrangler.toml`.
 */

import { sha256Hex } from './identity.js'
import {
  type Delivery,
  deliveryOf,
  describeError,
  runPipeline,
  type Stage,
} from './ingest.js'
import { resolveTarget } from './resolve.js'
import type { StoreEnv } from './store.js'
import type { EmailChannel, ResolvedConfig } from './types.js'

/**
 * Rows attempted per run.
 *
 * Bounded because an unbounded drain is a dead letter that can never be
 * drained: each replay is an R2 read plus a conversation lookup plus a store
 * batch, so a thousand rows in one invocation is past D1's
 * 1,000-queries-per-invocation limit and the run fails as a whole — the same
 * trap §8 refused to build when it declined to merge conversations.
 *
 * Not configurable. The consumer's lever is the cron interval, which they own
 * already; a second knob that has to be kept consistent with D1's limits is a
 * way to misconfigure the one path that exists to recover mail.
 */
export const REPLAY_BATCH = 10

/**
 * Attempts a row gets — **the original live one included** — before it is
 * parked.
 *
 * Parked means skipped, not deleted. Deleting would drop the only pointer to
 * the raw object, and §4 is explicit that an orphan in `raw/` is a message
 * awaiting replay rather than garbage. So the row stays, `attempts` says why
 * nothing is happening to it, and a fix that makes it replayable again is one
 * `UPDATE failed_ingest SET attempts = 0` away.
 *
 * The alternative — retrying forever — is worse than it looks. Most failures
 * that survive a fix are deterministic (a parser bomb, an object deleted out
 * from under us), so an unbounded retry is a message that can never succeed
 * consuming a slot in every batch, forever, ahead of messages that could.
 */
export const REPLAY_MAX_ATTEMPTS = 10

export interface ReplayReport {
  /** Rows this run picked up. */
  attempted: number
  /** …of which these were stored and their dead letter removed. */
  replayed: number
  /** …and these failed again and had `attempts` bumped. */
  failed: number
  /** Rows at the attempt ceiling. Not touched; reported so they are visible. */
  parked: number
}

interface DeadLetter {
  id: string
  raw_r2_key: string
  target: string | null
  first_seen: number
}

/**
 * One drain.
 *
 * Ordered by `last_seen` ascending — least recently attempted first — which is
 * round-robin rather than a priority: a failed replay writes `last_seen` and
 * goes to the back, so one message that keeps failing cannot hold up the
 * batch behind it. Ordering by `attempts` instead would do the same job until
 * two rows tied, and ordering by `first_seen` would let a permanently broken
 * old row occupy the same slot in every run until it parked.
 */
export async function replayFailed(
  config: ResolvedConfig,
  channel: EmailChannel,
  env: StoreEnv,
): Promise<ReplayReport> {
  const { results } = await env.db
    .prepare(
      `SELECT id, raw_r2_key, target, first_seen
         FROM failed_ingest
        WHERE channel = ? AND attempts < ?
        ORDER BY last_seen ASC
        LIMIT ?`,
    )
    // Rows from another channel are somebody else's to replay. There is only
    // one channel today, so this filter is inert — and it is the difference
    // between adding a webhook channel and silently feeding its JSON payloads
    // to the MIME parser.
    .bind(CHANNEL, REPLAY_MAX_ATTEMPTS, REPLAY_BATCH)
    .all<DeadLetter>()

  let replayed = 0

  for (const row of results) {
    // Per row, so one unreadable object does not abandon the rest of the batch.
    const outcome = await attempt(config, channel, env, row)
    if (outcome.ok) replayed += 1
  }

  return {
    attempted: results.length,
    replayed,
    failed: results.length - replayed,
    parked: await countParked(env.db),
  }
}

const CHANNEL = 'email'

/**
 * Replay one dead letter. Never throws: this is the recovery path for the path
 * that must not throw, and a bug here would take the whole batch with it.
 */
async function attempt(
  config: ResolvedConfig,
  channel: EmailChannel,
  env: StoreEnv,
  row: DeadLetter,
): Promise<{ ok: boolean }> {
  try {
    const outcome = await replayOne(config, channel, env, row)

    if (outcome.ok) {
      // The row *is* the backlog entry, so removing it is what "drained"
      // means. The raw object stays: it is the archived message, now with a
      // `contents` row pointing at it.
      await env.db
        .prepare('DELETE FROM failed_ingest WHERE id = ?')
        .bind(row.id)
        .run()
      return { ok: true }
    }

    await recordRetry(env.db, row.id, outcome.stage, outcome.error)
    return { ok: false }
  } catch (error) {
    // Reached only if the bookkeeping itself failed — D1 gone, say. Log and
    // move on; the row is untouched, so the next run tries it again.
    console.error(
      `inbox-worker: replay of ${row.raw_r2_key} could not be recorded: ${describeError(error)}`,
    )
    return { ok: false }
  }
}

type Attempt = { ok: true } | { ok: false; stage: Stage; error: unknown }

async function replayOne(
  config: ResolvedConfig,
  channel: EmailChannel,
  env: StoreEnv,
  row: DeadLetter,
): Promise<Attempt> {
  const delivery = redeliver(config, row.target)
  if (delivery === undefined) {
    return {
      ok: false,
      stage: 'targets',
      error: new Error(
        `no inbox for ${row.target ?? '(no target recorded)'} — ` +
          `no Email() channel declares that domain any more`,
      ),
    }
  }

  // The key is stored absolute, prefix included, so it is used as written
  // rather than rebuilt: `INBOX_PREFIX` is a deployment fact and may have
  // changed since the failure, and the object is wherever it was put.
  const object = await env.bucket.get(row.raw_r2_key)
  if (object === null) {
    return {
      ok: false,
      stage: 'fetch',
      error: new Error(`no object at ${row.raw_r2_key}`),
    }
  }

  const bytes = new Uint8Array(await object.arrayBuffer())

  return runPipeline(env, channel, {
    bytes,
    // Hashed from the bytes that came back, not sliced out of the key. They
    // agree — the key is the hash (§4) — and deriving identity from a string
    // rather than from the content is the habit this design does not have.
    raw: { key: row.raw_r2_key, sha256: await sha256Hex(bytes) },
    delivery,
    // **The original arrival time, not now.** `received_at` is the only
    // trusted ordering field (§3.1), so a backlog drained on Tuesday must not
    // stack a week of mail at the top of the inbox. `first_seen` is when the
    // handler wrote the dead letter, which is the moment the message arrived.
    receivedAt: new Date(row.first_seen),
  })
}

/**
 * Re-resolve the envelope address, rather than trusting the `inbox_key` — which
 * the row does not carry, deliberately.
 *
 * Routing is config, and config changes. A message that quarantined because
 * `support` did not exist yet should land in `support` when it is replayed
 * after that inbox is added; that is a large part of what makes replay worth
 * having. Storing the resolved inbox would freeze the old answer.
 */
function redeliver(
  config: ResolvedConfig,
  target: string | null,
): Delivery | undefined {
  if (target === null) return undefined

  const resolution = resolveTarget(config, target)
  return resolution.status === 'rejected' ? undefined : deliveryOf(resolution)
}

/**
 * A failed replay bumps `attempts` and moves to the back of the queue.
 *
 * `stage` and `error` are overwritten rather than appended: the row is a
 * pointer to a message plus the current reason it is stuck, and a growing
 * attacker-influenced text column is a table nobody can read.
 *
 * `first_seen` is untouched, because it is the arrival time the replay depends
 * on — see `replayOne`.
 */
async function recordRetry(
  db: D1Database,
  id: string,
  stage: Stage,
  error: unknown,
): Promise<void> {
  const reason = describeError(error)
  console.error(`inbox-worker: replay failed at ${stage} for ${id}: ${reason}`)

  await db
    .prepare(
      `UPDATE failed_ingest
          SET attempts  = attempts + 1,
              stage     = ?,
              error     = ?,
              last_seen = ?
        WHERE id = ?`,
    )
    .bind(stage, reason, Date.now(), id)
    .run()
}

/**
 * Rows that have run out of attempts.
 *
 * Counted on every run, not derived from the batch, because the whole point of
 * parking is that those rows stop appearing anywhere. A number nobody prints
 * is a backlog nobody knows about.
 */
async function countParked(db: D1Database): Promise<number> {
  const row = await db
    .prepare(
      `SELECT count(*) AS n FROM failed_ingest
        WHERE channel = ? AND attempts >= ?`,
    )
    .bind(CHANNEL, REPLAY_MAX_ATTEMPTS)
    .first<{ n: number }>()

  return row?.n ?? 0
}
