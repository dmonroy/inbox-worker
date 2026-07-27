/**
 * Everything that happens *after* the raw bytes are safe in R2 (§4).
 *
 * ```
 * parse -> caps -> DMARC -> conversation -> store
 * ```
 *
 * Extracted from the email handler because it now has two callers: the handler
 * running it once, live, and `replay` running it again later from the same
 * bytes. Two copies of this sequence would be two schemas' worth of writes to
 * keep in step, and the one that runs rarely is the one that would drift — so
 * there is exactly one, and replay is the same code path or it is nothing.
 *
 * **It never throws.** A failure comes back as a value naming the stage it
 * reached, because both callers have to record that stage rather than
 * propagate it (§7.4).
 */

import { applyCaps, DEFAULT_CAPS } from './caps.js'
import { resolveConversation } from './conversations.js'
import { dmarcPassed } from './dmarc.js'
import { parseEmail } from './mime.js'
import type { Resolution } from './resolve.js'
import { type StoredRaw, type StoreEnv, storeInbound } from './store.js'
import type { EmailChannel } from './types.js'

/**
 * Where ingest got to. Recorded on the dead letter so a replay knows what
 * failed, and so an operator reading `failed_ingest` can tell a broken message
 * apart from a broken deployment.
 *
 * Two of them are reachable only from `replay`, because the live path has
 * already settled both questions before the R2 write:
 *
 * - `fetch` — the raw object did not come back out of R2.
 * - `targets` — the envelope address no longer resolves to any inbox, which
 *   means the config lost the domain between the failure and the drain.
 */
export type Stage =
  | 'fetch'
  | 'targets'
  | 'parse'
  | 'caps'
  | 'conversation'
  | 'store'

/** An inbox to deliver to, and the address that chose it. */
export interface Delivery {
  inboxKey: string
  /** The envelope address as it arrived, tag and all. */
  target: string
  tag?: string
}

export interface PipelineInput {
  /** The whole message. Already in R2 — see `raw`. */
  bytes: Uint8Array
  /** Where those bytes are, from `putRaw` or from a `failed_ingest` row. */
  raw: StoredRaw
  delivery: Delivery
  /**
   * Our clock at the moment the message arrived, and the only trusted ordering
   * field (§3.1). A replay passes the *original* arrival time rather than now,
   * so draining a backlog does not reorder the archive.
   */
  receivedAt: Date
}

export type PipelineOutcome =
  | { ok: true }
  | { ok: false; stage: Stage; error: unknown }

export async function runPipeline(
  store: StoreEnv,
  channel: EmailChannel,
  input: PipelineInput,
): Promise<PipelineOutcome> {
  const { bytes, delivery } = input
  let stage: Stage = 'parse'

  try {
    // The two parser caps have to be set before parsing to mean anything, and
    // they *throw* — which is the case this whole `try` exists for (§5).
    const parsed = await parseEmail(bytes, {
      target: delivery.target,
      receivedAt: input.receivedAt,
      caps: DEFAULT_CAPS,
    })

    stage = 'caps'
    // Nothing else calls this. `storeInbound` takes the overflow list as an
    // input and bounds no row counts of its own, so without this line the
    // post-parse caps do not exist and one crafted message with ten thousand
    // MIME parts is ten thousand R2 puts and ten thousand D1 rows (§5).
    const { message: capped, overflows } = applyCaps(parsed, DEFAULT_CAPS)

    // Read from the raw bytes, not from `message.headers`: a sender writes
    // `Authentication-Results` too, and `Headers.get()` joins the forgery onto
    // the edge's genuine result with no way to tell them apart. See `dmarc.ts`.
    //
    // Reading it from the bytes is also what makes replay give the same answer
    // as the live delivery did. The runtime's parsed headers are long gone by
    // then; the archived object is not.
    const verified = dmarcPassed(bytes, channel.authservId)

    stage = 'conversation'
    // Before storage, and after the caps: `messages.conversation_id` is a
    // foreign key that D1 enforces (§9.0), so the parent row has to exist
    // first — and the candidate ids come from `meta.references`, which the
    // caps have just trimmed to the last 20.
    const { conversationId } = await resolveConversation(store.db, {
      message: capped,
      inboxKey: delivery.inboxKey,
      verified,
    })

    stage = 'store'
    await storeInbound(store, {
      message: capped,
      inboxKey: delivery.inboxKey,
      conversationId,
      verified,
      overflows,
      raw: input.raw,
      ...(delivery.tag === undefined ? {} : { tag: delivery.tag }),
    })

    return { ok: true }
  } catch (error) {
    return { ok: false, stage, error }
  }
}

/**
 * The inbox a resolution chose.
 *
 * Typed to exclude `rejected` rather than returning `undefined` for it: a
 * rejection is refused *before* the R2 write (§7.4), so no caller of this ever
 * holds one, and a nullable return would make both of them handle a case the
 * transport already did.
 */
export function deliveryOf(
  resolution: Exclude<Resolution, { status: 'rejected' }>,
): Delivery {
  return {
    inboxKey: resolution.inboxKey,
    target: resolution.target,
    ...(resolution.status === 'matched' && resolution.tag !== undefined
      ? { tag: resolution.tag }
      : {}),
  }
}

/**
 * Name and message, bounded. No stack: this is a bundled worker, so the frames
 * are noise, and the row is read by an operator rather than a debugger.
 *
 * Bounded because the text can contain whatever the sender sent — a parser
 * quoting a hostile header into its own message is ordinary — and an
 * unbounded attacker-authored string is a row nobody can list.
 */
export function describeError(error: unknown): string {
  const text =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return text.length > 1000 ? `${text.slice(0, 1000)}…` : text
}
