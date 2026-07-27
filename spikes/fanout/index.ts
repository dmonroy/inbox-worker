/**
 * ┌───────────────────────────────────────────────────────────────────────┐
 * │ SPIKE. This is not part of the package and never will be.             │
 * │                                                                       │
 * │ `spike/fanout` is a branch that never merges. This worker is deployed │
 * │ by hand to a throwaway zone, run once against one test message, read, │
 * │ and thrown away. Nothing in `src/` may ever import it, nothing in     │
 * │ `test/` may ever assert on it, and CI does not know it exists.        │
 * │                                                                       │
 * │ See RUNBOOK.md in this directory.                                     │
 * └───────────────────────────────────────────────────────────────────────┘
 *
 * WHAT IT MEASURES — DESIGN.md §10 experiment 1.
 *
 * Two shipped decisions rest on an assumption nobody has measured:
 *
 *   1. `message.to` is a *single* envelope recipient, so one email addressed
 *      to two of our addresses causes two worker invocations (§4, fan-out).
 *   2. Those two invocations see byte-identical raw messages apart from
 *      per-delivery trace headers — which is what makes `contentId` agree
 *      across them and store one `contents` row instead of two (§4 identity).
 *
 * If either is false, fan-out dedup silently doubles storage, and the strip
 * list in `src/trace.ts` — which says so in its own comment — stays a guess.
 *
 * HOW IT ANSWERS THEM.
 *
 * Per invocation it emits a `summary` JSON line carrying everything scalar,
 * then the verbatim header block as base64 `headers` lines. Two invocations
 * produce two summaries that can be diffed directly; the field that settles
 * the experiment is `contentId`, because that is the literal value production
 * would key `contents` on.
 *
 * It imports `stripTraceHeaders` and `contentId` from `src/` on purpose.
 * Measuring a reimplementation would measure the reimplementation.
 *
 * WHAT IT DELIBERATELY DOES NOT DO.
 *
 * - No `setReject()`. That is a permanent SMTP error (§7.4); a spike must not
 *   bounce the operator's own test mail.
 * - No `forward()` / `reply()`. Returning normally drops the message, which is
 *   what we want — this is a measurement, not a mailbox.
 * - No MIME parse. `postal-mime` is the largest allocation on the real ingest
 *   path, and leaving it out means the memory numbers here are a *floor*, not
 *   the real peak. `BALLAST_MB` exists to stand in for it — see below.
 * - No throwing. Any failure is logged as an `error` line and the handler
 *   returns, for the same reason the real one does.
 */

import process from 'node:process'
import { contentId, sha256Hex } from '../../src/identity.js'
import { stripTraceHeaders } from '../../src/trace.js'

interface Env {
  /**
   * Megabytes of scratch memory to hold alongside the buffered message, as a
   * stand-in for what `postal-mime` would allocate. See `memoryProbe()` — the
   * runtime exposes no usable memory reading, so the only way to measure
   * headroom is to consume a known amount of it and observe whether the
   * invocation survives. Raise it across redeploys until the isolate dies;
   * the last value that logged a summary is the headroom that existed.
   */
  BALLAST_MB?: string

  /**
   * Optional. When bound, every invocation also writes its raw bytes and full
   * record to R2. This is the *authoritative* channel for byte-identity: two
   * objects you can `cmp` are proof, whereas logs are capped at 256 KB and can
   * be sampled away. The worker deploys and works without it.
   */
  SPIKE_BUCKET?: R2Bucket
}

/** One log line per chunk. 16 KiB of base64 is 12 KiB of headers, which keeps
 *  every line an order of magnitude under Cloudflare's 256 KB log cap even
 *  after JSON escaping. */
const CHUNK_CHARS = 16 * 1024

/** 64 chunks is 768 KiB of header block — three times our own 256 KiB header
 *  cap (§5). Past that, stop and say so rather than flooding the tail. */
const MAX_CHUNKS = 64

const LF = 0x0a
const CR = 0x0d
const SPACE = 0x20
const TAB = 0x09
const COLON = 0x3a

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const invocation = crypto.randomUUID()

    try {
      await measure(message, env, invocation)
    } catch (error) {
      emit({
        kind: 'error',
        invocation,
        error: String(error),
        stack: error instanceof Error ? error.stack : undefined,
      })
    }
  },

  /**
   * Not part of the experiment. It exists so the operator can confirm the
   * deploy is live before spending a test message on it.
   */
  fetch(): Response {
    return new Response(
      'inbox-worker fan-out spike. Send mail to two addresses on this zone, ' +
        'then read `wrangler tail`. See spikes/fanout/RUNBOOK.md.\n',
      { headers: { 'content-type': 'text/plain; charset=utf-8' } },
    )
  },
} satisfies ExportedHandler<Env>

async function measure(
  message: ForwardableEmailMessage,
  env: Env,
  invocation: string,
): Promise<void> {
  const startedAt = Date.now()

  // Exactly the shape §4.1 mandates for the real handler: one read, into one
  // buffer, because `message.raw` is single-use and of unknown length.
  const raw = new Uint8Array(await new Response(message.raw).arrayBuffer())

  const ballast = allocateBallast(env.BALLAST_MB)

  const stripped = stripTraceHeaders(raw)
  const headerBlock = raw.subarray(0, headerBlockEnd(raw))
  const headers = await describeHeaders(headerBlock)

  /**
   * `run` groups the two invocations of one message. Taken from the sender's
   * own `X-Spike-Run` (set by `send.sh`) rather than anything Cloudflare
   * stamps, because a per-delivery id would defeat the point of grouping.
   * Falling back to `Message-ID` and then to the raw hash, which only groups
   * the two invocations if the bytes were identical — and *that failing to
   * group is itself the finding*.
   */
  const rawSha256 = await sha256Hex(raw)
  const run =
    headerValue(headers, 'x-spike-run') ??
    headerValue(headers, 'message-id') ??
    `raw:${rawSha256.slice(0, 16)}`

  const summary = {
    kind: 'summary' as const,
    run,
    invocation,

    // Q1: is `to` one recipient, or did Cloudflare hand us a list? The type
    // says `string`; this records what actually arrived, because the whole
    // fan-out model collapses if it is a list.
    to: message.to,
    toType: typeof message.to,
    toIsArray: Array.isArray(message.to),
    from: message.from,

    rawSize: message.rawSize,
    // Two numbers, because they disagreeing is itself a finding: `rawSize` is
    // what the edge reports, `rawBytesRead` is what the stream actually gave.
    rawBytesRead: raw.length,

    // Q2: the three hashes. `contentId` is the one that decides the
    // experiment — it is the literal `contents.id` production would write.
    rawSha256,
    strippedSha256: await sha256Hex(stripped),
    strippedBytes: stripped.length,
    contentId: await contentId('email', stripped),

    // Q3: if `contentId` differs, this is what says *why*. A per-header hash
    // list diffs cleanly, so the operator sees which header names changed
    // without reassembling a byte of base64.
    headerBlockBytes: headerBlock.length,
    headerBlockSha256: await sha256Hex(headerBlock),
    headers: headers.map((h) => ({
      i: h.index,
      name: h.name,
      bytes: h.end - h.start,
      sha: h.sha.slice(0, 16),
    })),

    /**
     * `message.headers` is a `Headers` object, which lowercases names, loses
     * order, and **joins repeats with a comma** — the exact behaviour that
     * makes a substring test for `dmarc=pass` match a *sender-written*
     * `Authentication-Results` sitting below Cloudflare's own (§8). Recorded
     * in full because it is small, and because the handler's DMARC gate has
     * to be written against whatever shape this really is.
     */
    authenticationResultsJoined: message.headers.get('authentication-results'),
    receivedHeaderCount: headers.filter((h) => h.name === 'received').length,

    memory: memoryProbe(),
    ballastMb: ballast.mb,
    // Referenced so the allocation cannot be optimised away before the log.
    ballastWitness: ballast.witness,

    /**
     * Expect 0. Workers freeze the clock between I/O for timing-attack
     * reasons, so this is not a CPU measurement and must not be read as one.
     * It is here only so a *non*-zero value — which would mean I/O happened —
     * is visible rather than assumed away.
     */
    apparentElapsedMs: Date.now() - startedAt,
  }

  emit(summary)
  emitHeaderBlock(run, invocation, headerBlock)

  // Last, so a missing or misconfigured bucket cannot cost us the log lines.
  await archive(env, run, invocation, raw, summary)
}

/* ------------------------------------------------------------------ output */

/**
 * One JSON object per line, keys in a fixed order, so two invocations can be
 * fed straight to `diff`. That diffability is the entire point of the output
 * format — see `report.sh`.
 */
function emit(record: object): void {
  console.log(JSON.stringify({ spike: 'fanout', ...record }))
}

/**
 * The verbatim header block, base64, split across lines.
 *
 * Base64 rather than text because a header block is bytes: it can carry
 * invalid UTF-8, and it certainly carries newlines, and a JSON log line has to
 * survive both without the reassembled copy differing from what arrived.
 * `headerBlockSha256` in the summary is how the operator checks reassembly.
 */
function emitHeaderBlock(
  run: string,
  invocation: string,
  headerBlock: Uint8Array,
): void {
  const b64 = toBase64(headerBlock)
  const total = Math.ceil(b64.length / CHUNK_CHARS)
  const emitted = Math.min(total, MAX_CHUNKS)

  for (let seq = 0; seq < emitted; seq++) {
    emit({
      kind: 'headers',
      run,
      invocation,
      seq,
      of: total,
      truncated: emitted < total,
      b64: b64.slice(seq * CHUNK_CHARS, (seq + 1) * CHUNK_CHARS),
    })
  }
}

async function archive(
  env: Env,
  run: string,
  invocation: string,
  raw: Uint8Array,
  summary: object,
): Promise<void> {
  const bucket = env.SPIKE_BUCKET
  if (!bucket) return

  // Grouped by run so the two invocations of one message land side by side,
  // and named by envelope recipient so which is which needs no lookup.
  const prefix = `spike/${slug(run)}/${invocation}`

  try {
    await bucket.put(`${prefix}.eml`, raw)
    await bucket.put(`${prefix}.json`, JSON.stringify(summary, null, 2))
    emit({ kind: 'archived', run, invocation, prefix })
  } catch (error) {
    emit({ kind: 'archive-failed', run, invocation, error: String(error) })
  }
}

/* ----------------------------------------------------------------- headers */

interface HeaderSpan {
  index: number
  /** Lowercased field name, or `''` for a line with no colon. */
  name: string
  start: number
  end: number
  sha: string
  value: string
}

/**
 * Split the header block into *logical* headers, folded continuation lines
 * included. Parsed out of the raw bytes rather than read from
 * `message.headers` because that API loses order and merges repeats, and
 * order and repeat count are two of the things most likely to differ between
 * two deliveries.
 */
async function describeHeaders(block: Uint8Array): Promise<HeaderSpan[]> {
  const spans: Array<{ start: number; end: number }> = []

  let i = 0
  while (i < block.length) {
    const lineEnd = endOfLine(block, i)
    const folded = block[i] === SPACE || block[i] === TAB
    const previous = spans[spans.length - 1]

    if (folded && previous) previous.end = lineEnd
    else spans.push({ start: i, end: lineEnd })

    i = lineEnd
  }

  const out: HeaderSpan[] = []
  for (const [index, span] of spans.entries()) {
    const bytes = block.subarray(span.start, span.end)
    out.push({
      index,
      name: fieldName(bytes),
      start: span.start,
      end: span.end,
      sha: await sha256Hex(bytes),
      value: decodeLossy(bytes),
    })
  }
  return out
}

function fieldName(header: Uint8Array): string {
  let name = ''
  for (const byte of header) {
    if (byte === COLON) return name.toLowerCase()
    // A field name is printable ASCII. Anything else means this is not a
    // header line, and guessing a name for it would invent structure.
    if (byte < 0x21 || byte > 0x7e) return ''
    name += String.fromCharCode(byte)
  }
  return ''
}

function headerValue(headers: HeaderSpan[], name: string): string | undefined {
  const found = headers.find((h) => h.name === name)
  if (!found) return undefined
  const colon = found.value.indexOf(':')
  return colon === -1 ? undefined : found.value.slice(colon + 1).trim()
}

/** Index of the blank line that ends the header block, or `length` if there
 *  is none. A message with no blank line at all is malformed but does arrive,
 *  and treating it as all-headers matches what `stripTraceHeaders` does. */
function headerBlockEnd(raw: Uint8Array): number {
  let i = 0
  while (i < raw.length) {
    const lineEnd = endOfLine(raw, i)
    let contentEnd = lineEnd
    if (contentEnd > i && raw[contentEnd - 1] === LF) contentEnd--
    if (contentEnd > i && raw[contentEnd - 1] === CR) contentEnd--
    if (contentEnd === i) return i
    i = lineEnd
  }
  return raw.length
}

function endOfLine(raw: Uint8Array, from: number): number {
  for (let i = from; i < raw.length; i++) if (raw[i] === LF) return i + 1
  return raw.length
}

/* ------------------------------------------------------------------ memory */

/**
 * MEASURED, LOCALLY, BEFORE THIS FILE WAS WRITTEN — and the answer is "there
 * isn't one".
 *
 * Against workerd via miniflare with `nodejs_compat` on:
 *
 *   performance.memory                 absent
 *   performance.measureUserAgentSpecificMemory()  absent
 *   process.memoryUsage()              present, every field 0
 *   v8.getHeapStatistics()             present, every field 0
 *
 * They are stubs. So this probe reports the raw values and a verdict rather
 * than a number, and `available: false` is the expected result. If a future
 * runtime fills them in, this starts returning real figures with no change.
 *
 * The measurement that *does* work is `BALLAST_MB` plus the invocation's
 * `outcome` in the tail — see RUNBOOK.md, "the memory question".
 */
function memoryProbe(): Record<string, unknown> {
  const readings: Record<string, unknown> = {}

  const perf = performance as unknown as { memory?: Record<string, number> }
  readings.performanceMemory = perf.memory ?? null

  try {
    readings.processMemoryUsage = process.memoryUsage()
  } catch (error) {
    readings.processMemoryUsage = `threw: ${String(error)}`
  }

  return {
    ...readings,
    available: hasNonZero(readings),
    note: 'all-zero or null means the runtime exposes no memory reading; use BALLAST_MB',
  }
}

function hasNonZero(readings: Record<string, unknown>): boolean {
  return Object.values(readings).some(
    (reading) =>
      typeof reading === 'object' &&
      reading !== null &&
      Object.values(reading as Record<string, unknown>).some(
        (v) => typeof v === 'number' && v > 0,
      ),
  )
}

/**
 * Hold `mb` megabytes and touch every 4 KiB page, because an untouched
 * allocation may never be backed by anything and would measure nothing.
 */
function allocateBallast(setting: string | undefined): {
  mb: number
  witness: number
} {
  const mb = Number(setting ?? '0')
  if (!Number.isFinite(mb) || mb <= 0) return { mb: 0, witness: 0 }

  const block = new Uint8Array(mb * 1024 * 1024)
  for (let i = 0; i < block.length; i += 4096) block[i] = 1
  block[block.length - 1] = 1

  // A witness of 1 in the summary is the proof the block was really written
  // to. Reading it here is also what stops the allocation being elided.
  return { mb, witness: block[block.length - 1] ?? 0 }
}

/* ------------------------------------------------------------------ codecs */

function toBase64(bytes: Uint8Array): string {
  // 8 KiB at a time: `String.fromCharCode(...huge)` overflows the stack, and
  // a spike that dies on a large header block measures nothing.
  let binary = ''
  const step = 0x2000
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step))
  }
  return btoa(binary)
}

/** For display only — never fed back into a hash. Non-fatal by default, which
 *  is what we want: a header block with one bad byte must still be readable. */
function decodeLossy(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'unknown'
}
