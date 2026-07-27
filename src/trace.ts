/**
 * Remove per-delivery trace headers from a raw message.
 *
 * These are added by whatever handled the message on the way in, and differ
 * between two deliveries of the *same* message. Hashing the bytes with them
 * still attached would give one email two identities, so fan-out would store
 * it twice.
 *
 * Works on bytes rather than text. Header names are ASCII, but a body is
 * arbitrary bytes, and decoding it to a string to put it back would corrupt
 * anything that is not valid UTF-8.
 */

/**
 * Provisional. The definitive list is whatever a real fan-out measurement
 * shows actually differing between two invocations — see spike A in PLAN.md.
 * Erring wide is safe: stripping a header that was in fact identical costs
 * nothing, while missing one splits an email into two stored copies.
 */
const TRACE_HEADERS = new Set([
  'received',
  'received-spf',
  'x-received',
  'delivered-to',
  'return-path',
  'authentication-results',
  'arc-seal',
  'arc-message-signature',
  'arc-authentication-results',
  'x-forwarded-for',
  'x-forwarded-to',
])

const LF = 0x0a
const CR = 0x0d
const COLON = 0x3a
const SPACE = 0x20
const TAB = 0x09

export function stripTraceHeaders(raw: Uint8Array): Uint8Array {
  const keep: Array<[number, number]> = []

  let i = 0
  let dropping = false

  while (i < raw.length) {
    const lineEnd = endOfLine(raw, i) // index just past the terminator
    const contentEnd = trimTerminator(raw, i, lineEnd)

    // A blank line ends the header block; everything after it is body and is
    // copied untouched.
    if (contentEnd === i) {
      keep.push([i, raw.length])
      break
    }

    const folded = raw[i] === SPACE || raw[i] === TAB
    if (folded) {
      // Continuation of the previous header, so it shares that header's fate.
      // Dropping a Received line but keeping its folded remainder would leave
      // orphaned text where a header should be.
      if (!dropping) keep.push([i, lineEnd])
    } else {
      dropping = isTrace(raw, i, contentEnd)
      if (!dropping) keep.push([i, lineEnd])
    }

    i = lineEnd
  }

  return concat(raw, keep)
}

function isTrace(raw: Uint8Array, start: number, end: number): boolean {
  const colon = indexOfByte(raw, COLON, start, end)
  if (colon === -1) return false

  // Exact name match, lowercased. A prefix test would catch unrelated headers
  // that merely begin with a trace name.
  let name = ''
  for (let i = start; i < colon; i++) {
    name += String.fromCharCode(raw[i] as number).toLowerCase()
  }
  return TRACE_HEADERS.has(name)
}

function endOfLine(raw: Uint8Array, from: number): number {
  const lf = indexOfByte(raw, LF, from, raw.length)
  return lf === -1 ? raw.length : lf + 1
}

/** The line without its CRLF or LF, so a blank line is detectable. */
function trimTerminator(raw: Uint8Array, start: number, end: number): number {
  let e = end
  if (e > start && raw[e - 1] === LF) e--
  if (e > start && raw[e - 1] === CR) e--
  return e
}

function indexOfByte(
  raw: Uint8Array,
  byte: number,
  from: number,
  to: number,
): number {
  for (let i = from; i < to; i++) if (raw[i] === byte) return i
  return -1
}

function concat(raw: Uint8Array, ranges: Array<[number, number]>): Uint8Array {
  let size = 0
  for (const [start, end] of ranges) size += end - start

  const out = new Uint8Array(size)
  let at = 0
  for (const [start, end] of ranges) {
    out.set(raw.subarray(start, end), at)
    at += end - start
  }
  return out
}
