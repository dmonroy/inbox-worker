/**
 * The worker entry point — ingest, end to end (§4).
 *
 * ```
 * resolve target -> buffer raw -> put raw to R2 -> parse -> caps
 *                -> DMARC -> conversation -> store
 * ```
 *
 * **Once the raw bytes are in R2 this never throws** (§7.4). An Email Worker
 * has no transient-failure path: an unhandled exception makes Cloudflare
 * return 521 after DATA, which is a *permanent* 5xx, so the sending server
 * bounces to its author and never retries. A crash here is therefore not an
 * error, it is mail loss — and since parse failure is reachable by anyone who
 * can send mail, a crash is also a censorship primitive. Craft one message
 * that breaks the parser and you drop a thread, repeatably, for free.
 *
 * So everything after the R2 write is wrapped, and a failure writes a
 * `failed_ingest` row and returns normally. The raw object is the message, and
 * `scheduled()` — a cron trigger, not the CLI command DESIGN sketched — drains
 * the backlog once the bug is fixed. See `replay.ts` for why.
 *
 * Two things sit deliberately *outside* that guarantee, and both are cases
 * where returning success would mean discarding mail with no record of it:
 *
 * - **An undeclared domain is refused before the R2 write.** It means a zone
 *   is pointed here by mistake, and quarantining it silently would make a
 *   misconfiguration look like ordinary unknown-address traffic (§7.1).
 * - **A missing `INBOX_BUCKET` throws.** With nowhere to put the bytes there
 *   is nothing to recover later, and a deploy-time developer error is the one
 *   thing that should fail loudly (§2.7). A missing `INBOX_DB` does *not*
 *   throw: the bytes still reach R2, which is the whole point of the ordering.
 */

import { resolveConfig } from './config.js'
import { sha256Hex } from './identity.js'
import { deliveryOf, describeError, runPipeline, type Stage } from './ingest.js'
import { replayFailed } from './replay.js'
import { resolveTarget } from './resolve.js'
import { putRaw, type StoredRaw, type StoreEnv } from './store.js'
import type { EmailChannel, InboxConfig, ResolvedConfig } from './types.js'

const enc = new TextEncoder()

const CHANNEL = 'email'
const RFC822 = 'message/rfc822'

/** The bindings the package resolves by name (§2.7). */
export interface Env {
  INBOX_DB: D1Database
  INBOX_BUCKET: R2Bucket
  /**
   * Prepended to every R2 key, so one bucket can hold more than one
   * deployment. A binding rather than config: which bucket a deployment shares
   * is a deployment fact, and staging and production run the same config file.
   */
  INBOX_PREFIX?: string
}

export interface Handlers {
  email(
    message: ForwardableEmailMessage,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void>
  /**
   * Drains `failed_ingest` (§7.4). Needs a cron trigger in the consumer's
   * `wrangler.toml`; without one it is simply never called and the backlog
   * keeps accumulating, which is the state before this existed.
   */
  scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void>
}

/**
 * The handlers on their own, for a consumer who already exports a worker of
 * their own and wants to mount ours inside it (§2.1).
 *
 * Config is validated here rather than per message, so a broken config throws
 * at module scope where a deploy notices it.
 */
export function handlers(config: InboxConfig): Handlers {
  const resolved = resolveConfig(config)
  const channel = emailChannelOf(resolved)

  // The one place this package logs. `validate` returns warnings rather than
  // printing them precisely so that the decision lives here, at the consumer's
  // own boot, and happens once per isolate instead of once per message.
  for (const warning of resolved.warnings) {
    console.warn(`inbox-worker: ${warning}`)
  }

  return {
    email: (message, env, _ctx) => handleEmail(resolved, channel, message, env),
    scheduled: (_controller, env, _ctx) => drain(resolved, channel, env),
  }
}

/**
 * A ready-made worker: `export default inbox(config)`.
 *
 * §2.1 asks for `fetch` here too, for webhook channels. There are none yet,
 * and an endpoint that accepts unauthenticated POSTs on behalf of zero
 * configured channels is a liability rather than a placeholder — it lands when
 * the first webhook channel does.
 */
export function inbox(config: InboxConfig): ExportedHandler<Env> {
  const { email, scheduled } = handlers(config)
  return { email, scheduled }
}

/**
 * The cron entry point (§7.4).
 *
 * **This never throws either**, for a different reason than ingest does: a
 * scheduled invocation that throws is recorded as a failed cron run and
 * nothing else happens, so propagating would trade a log line an operator can
 * read for one they have to go looking for. Everything that could fail here —
 * an unmigrated database, a missing binding — is a deployment problem, and the
 * message it concerns is still safe in R2 either way.
 */
async function drain(
  config: ResolvedConfig,
  channel: EmailChannel,
  env: Env,
): Promise<void> {
  try {
    const report = await replayFailed(config, channel, storeEnv(env))

    if (report.attempted > 0 || report.parked > 0) {
      console.log(
        `inbox-worker: replayed ${report.replayed} of ${report.attempted}, ` +
          `${report.failed} failed again, ${report.parked} parked.`,
      )
    }
  } catch (error) {
    console.error(`inbox-worker: replay run failed: ${describeError(error)}`)
  }
}

async function handleEmail(
  config: ResolvedConfig,
  channel: EmailChannel,
  message: ForwardableEmailMessage,
  env: Env,
): Promise<void> {
  // Before the bytes are touched: a rejection has to happen before the R2
  // write, and a message for a domain we never declared is the only one there
  // is (§7.4). Cheap, too — no reason to buffer 25 MB we are about to refuse.
  const resolution = resolveTarget(config, message.to)
  if (resolution.status === 'rejected') {
    // Loud, because it is a misconfiguration rather than traffic: a zone is
    // pointed at this worker that no `Email()` channel declares (§7.1). The
    // operator is the one who has to see it — the sender only gets the bounce.
    console.error(
      `inbox-worker: refused ${resolution.target} (${resolution.reason}). ` +
        `No Email() channel declares that domain.`,
    )
    // Read by a human in a bounce message, so it says what happened rather
    // than naming our enum. It leaks nothing: which domains this worker
    // accepts is already public in their MX records.
    message.setReject(`No mailbox is configured for ${resolution.target}`)
    return
  }

  const store = storeEnv(env)
  const receivedAt = new Date()

  // **Read once.** `message.raw` is a `ReadableStream` of unknown length and
  // is single-use (§4.1). Handing it to `R2.put` does not fail cleanly — R2
  // needs a known length and the reported symptom is a five-minute worker
  // timeout — and letting R2 drain it before parsing yields a perfect .eml in
  // the bucket beside a row with no subject, no body and no attachments.
  // Silently. Everything below is fed from this buffer.
  const bytes = new Uint8Array(await new Response(message.raw).arrayBuffer())

  const raw = await putRaw(store, {
    bytes,
    contentType: RFC822,
    channel: CHANNEL,
    receivedAt,
  })

  // From here on, nothing throws — `runPipeline` returns its failures.
  const outcome = await runPipeline(store, channel, {
    bytes,
    raw,
    delivery: deliveryOf(resolution),
    receivedAt,
  })

  if (!outcome.ok) {
    await deadLetter(store.db, {
      raw,
      target: resolution.target,
      stage: outcome.stage,
      error: outcome.error,
      at: receivedAt,
    })
  }
}

interface Failure {
  raw: StoredRaw
  target: string
  stage: Stage
  error: unknown
  at: Date
}

/**
 * Record a failure and return. The raw bytes are already safe; this is the
 * pointer to them (§7.4).
 *
 * Keyed on the bytes and the envelope target, so the same message failing
 * again — a redelivery, a replay that hits the same bug — bumps `attempts`
 * rather than adding a row. Fan-out fails twice under two targets, which is
 * correct: those are two deliveries.
 *
 * **This cannot throw either.** If D1 is unreachable, or unmigrated, or the
 * binding is missing, there is nowhere to write the row and the only remaining
 * move is to log and return success — §2.8's degradation ladder, reached the
 * same way. An object in `raw/` with no `failed_ingest` row is exactly that
 * case, and §4 says to replay it rather than sweep it.
 */
async function deadLetter(db: D1Database, failure: Failure): Promise<void> {
  const { raw, target, stage } = failure
  const reason = describeError(failure.error)

  // Always, whether or not the row lands. A row nobody queries is invisible;
  // the log is the signal a human is meant to see.
  console.error(
    `inbox-worker: ingest failed at ${stage} for ${raw.key}: ${reason}`,
  )

  try {
    const at = failure.at.getTime()
    const id = await sha256Hex(enc.encode(`${raw.sha256}:${target}`))

    await db
      .prepare(
        `INSERT INTO failed_ingest
           (id, raw_r2_key, channel, target, stage, error, attempts,
            first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           attempts  = attempts + 1,
           stage     = excluded.stage,
           error     = excluded.error,
           last_seen = max(last_seen, excluded.last_seen)`,
      )
      .bind(id, raw.key, CHANNEL, target, stage, reason, at, at)
      .run()
  } catch (error) {
    console.error(
      `inbox-worker: could not record the failure for ${raw.key}: ${describeError(error)}`,
    )
  }
}

function storeEnv(env: Env): StoreEnv {
  if (env.INBOX_BUCKET === undefined) {
    // Loud, and the only binding that gets this treatment. Without a bucket
    // the bytes have nowhere to go, so there is nothing for a `failed_ingest`
    // row to point at and nothing to replay — accepting the message would
    // discard it silently. `INBOX_DB` missing is survivable and stays inside
    // the never-throw path.
    throw new Error(
      'inbox-worker: the INBOX_BUCKET binding is missing. Add an R2 bucket ' +
        'binding named INBOX_BUCKET (§2.7).',
    )
  }

  return {
    db: env.INBOX_DB,
    bucket: env.INBOX_BUCKET,
    ...(env.INBOX_PREFIX === undefined ? {} : { prefix: env.INBOX_PREFIX }),
  }
}

/**
 * The email channel, resolved once at boot.
 *
 * The `authserv-id` names the edge in front of the whole worker rather than
 * one domain, so several `Email()` channels share one — which `validate`
 * enforces, leaving nothing here to disambiguate.
 */
function emailChannelOf(config: ResolvedConfig): EmailChannel {
  const channel = config.channels.find((c) => c.id === CHANNEL)
  if (channel === undefined) {
    throw new Error('inbox-worker: no Email() channel is configured.')
  }
  return channel
}
