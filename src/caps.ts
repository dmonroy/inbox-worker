/**
 * Ingest caps.
 *
 * Not hygiene. One crafted message with ten thousand tiny MIME parts is ten
 * thousand R2 puts and ten thousand D1 rows inside a single invocation, which
 * is past both the subrequest limit and the 1,000-queries-per-invocation limit
 * — so the message fails, and because it fails identically on every retry it
 * can never be delivered at all.
 *
 * Overflow is **recorded, never thrown** (§7.4). A message with 51 attachments
 * is stored with 50 and a note; refusing it would lose it permanently.
 */

import type { Inbound } from './inbound'

export interface IngestCaps {
  /** Attachments kept per message. */
  attachments: number
  /** Total decoded attachment bytes kept. */
  attachmentBytes: number
  /** Participants kept per message. Bounded by D1 statements per batch. */
  participants: number
  /**
   * `meta.references` entries carried. The **last** n are kept — see
   * `applyCaps`. Bounded by D1's 100-bound-parameter limit per query.
   */
  references: number
  /**
   * MIME nesting depth. Enforced by the parser *before* decoding, so unlike
   * the others this one throws rather than truncates, and the handler
   * dead-letters the message. postal-mime's own default is 256.
   */
  depth: number
  /**
   * Header block bytes. Also parser-enforced and also throws. postal-mime's
   * own default is 2 MB; 256 KiB still leaves room for a long `References`
   * chain beside several DKIM signatures.
   */
  headerBytes: number
}

export const DEFAULT_CAPS: IngestCaps = {
  attachments: 50,
  attachmentBytes: 20 * 1024 * 1024,
  participants: 200,
  references: 20,
  depth: 20,
  headerBytes: 256 * 1024,
}

export interface Overflow {
  cap: 'attachments' | 'attachmentBytes' | 'participants' | 'references'
  limit: number
  /** What the message actually carried. Bytes for `attachmentBytes`, else a count. */
  found: number
  /** How many items were discarded. Always a count. */
  dropped: number
}

export interface CappedMessage {
  message: Inbound
  /** Empty when nothing was truncated. Destined for `contents.meta`. */
  overflows: Overflow[]
}

/**
 * Trim a message to the caps, reporting what was lost.
 *
 * Pure: the input is never mutated, because the caller may still want the
 * original for the dead-letter record.
 *
 * These run **after** parsing, which is the honest position rather than the
 * intended one. postal-mime decodes every part before returning, so nothing
 * here can stop the parser allocating. What bounds that is the platform's
 * 25 MB inbound limit plus `depth`/`headerBytes`, which the parser applies
 * itself. What these caps do bound is everything downstream — R2 puts, D1
 * rows, and the extra copies each one makes.
 */
export function applyCaps(
  msg: Inbound,
  caps: IngestCaps = DEFAULT_CAPS,
): CappedMessage {
  const overflows: Overflow[] = []

  const attachments = byCount(msg.attachments, caps.attachments)
  record(overflows, 'attachments', caps.attachments, attachments)

  const sized = byBytes(attachments.kept, caps.attachmentBytes)
  record(overflows, 'attachmentBytes', caps.attachmentBytes, sized)

  const participants = byCount(msg.participants, caps.participants)
  record(overflows, 'participants', caps.participants, participants)

  const meta = capReferences(msg.meta, caps.references, overflows)

  return {
    message: {
      ...msg,
      attachments: sized.kept,
      participants: participants.kept,
      meta,
    },
    overflows,
  }
}

interface Trim<T> {
  kept: T[]
  found: number
  dropped: number
}

function record(
  into: Overflow[],
  cap: Overflow['cap'],
  limit: number,
  trim: Trim<unknown>,
): void {
  if (trim.dropped > 0) {
    into.push({ cap, limit, found: trim.found, dropped: trim.dropped })
  }
}

/** Keep the first n. MIME order is arrival order, and the front is the meaningful end. */
function byCount<T>(items: readonly T[], limit: number): Trim<T> {
  return {
    kept: items.length <= limit ? [...items] : items.slice(0, limit),
    found: items.length,
    dropped: Math.max(0, items.length - limit),
  }
}

/**
 * Keep attachments in order until one does not fit, then stop.
 *
 * Deliberately not a greedy best-fit. Skipping an oversized attachment to
 * squeeze in smaller later ones would silently reorder which parts of a
 * message survive by their size, and "we kept a prefix" is something you can
 * explain to whoever is looking at a truncated message.
 */
function byBytes<T extends { bytes: Uint8Array }>(
  items: readonly T[],
  limit: number,
): Trim<T> {
  let total = 0
  let kept = items.length

  for (let i = 0; i < items.length; i++) {
    const size = (items[i] as T).bytes.length
    if (total + size > limit) {
      kept = i
      break
    }
    total += size
  }

  const found = items.reduce((sum, item) => sum + item.bytes.length, 0)
  return {
    kept: items.slice(0, kept),
    found,
    dropped: items.length - kept,
  }
}

/**
 * `meta` is the escape hatch that keeps the schema fixed, and an *unbounded*
 * escape hatch would defeat every cap beside it. `references` is the one field
 * in it known to grow without limit, so the shared pass reaches in by
 * convention rather than making each channel repeat the check.
 *
 * The **last** n are kept, not the first. `References` runs oldest to newest,
 * and the tail is the near ancestry a reply actually threads against — JWZ's
 * rule. Every other cap keeps the front; this one is the exception, and
 * getting it backwards would break threading on exactly the long chains the
 * cap exists for.
 */
function capReferences(
  meta: Record<string, unknown>,
  limit: number,
  overflows: Overflow[],
): Record<string, unknown> {
  const refs = meta.references
  if (!Array.isArray(refs) || refs.length <= limit) return meta

  overflows.push({
    cap: 'references',
    limit,
    found: refs.length,
    dropped: refs.length - limit,
  })
  return { ...meta, references: refs.slice(-limit) }
}
