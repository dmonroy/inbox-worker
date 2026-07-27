/**
 * `Inbound` -> R2 objects and D1 rows.
 *
 * **R2 first, D1 last** (§4). The D1 row is the commit marker: a row pointing
 * at a missing object is a broken inbox, while an object with no row is a
 * message awaiting replay, which `failed_ingest` accounts for. Getting the
 * order backwards trades a recoverable state for an unrecoverable one.
 *
 * Everything is idempotent, because nothing here gets to assume it runs once.
 * Fan-out invokes the worker twice with identical content (§4); Cloudflare
 * retries; an operator replays a dead letter. R2 keys are content hashes, so a
 * rewrite writes the same bytes to the same key; the D1 ids are derived, so
 * every insert is `INSERT OR IGNORE` against one.
 *
 * Conversations are **not** resolved here. A conversation is chosen per inbox
 * by the step that owns threading (§8), and `conversationId` arrives already
 * decided. The one conversation column this module does own is
 * `message_count`, because it is the only place that knows whether a
 * `messages` row was really inserted — see `countMessage`.
 */

import type { Overflow } from './caps.js'
import {
  contentId as deriveContentId,
  messageId,
  sha256Hex,
} from './identity.js'
import type { Attachment, Inbound, Participant } from './inbound.js'
import { stripTraceHeaders } from './trace.js'

const enc = new TextEncoder()

export interface StoreEnv {
  db: D1Database
  bucket: R2Bucket
  /**
   * Prepended to every key, so one bucket can hold more than one deployment.
   * Included in no hash: it addresses the object, it does not identify it.
   */
  prefix?: string
}

export interface StoreRequest {
  /** Already through `applyCaps` (§5). Nothing here bounds row counts. */
  message: Inbound
  inboxKey: string
  /** Resolved by the conversation step (§8), which runs before this one. */
  conversationId: string
  /** Plus-address tag, from `resolveTarget`. */
  tag?: string
  /** Channel authentication passed — DMARC for email. Recorded, not enforced. */
  verified?: boolean
  /** From `applyCaps`. Kept in `contents.meta` so a truncated message says so. */
  overflows?: readonly Overflow[]
  /**
   * The already-stored raw object, when the caller wrote it earlier.
   *
   * The ingest handler has to: the never-throw rule only starts once the bytes
   * are in R2, so the put happens *before* the parse that might crash (§7.4).
   * Passing the result back avoids a second, identical put — the key is a
   * content hash, so it would be a wasted subrequest rather than a conflict.
   *
   * Absent, this writes it itself, which is what the storage tests do.
   */
  raw?: StoredRaw
}

/** Where the raw bytes went, and what they hash to. */
export interface StoredRaw {
  key: string
  sha256: string
}

/** Just enough of an `Inbound` to address the raw object — available pre-parse. */
export interface RawObject {
  bytes: Uint8Array
  contentType: string
  channel: string
  receivedAt: Date
}

/**
 * Put the raw bytes in R2 and say where they went.
 *
 * Split out of `storeInbound` because the ingest path cannot wait for it.
 * Everything after this write is recoverable — the object is the message, and
 * a `failed_ingest` row can always be added later — while a crash before it
 * loses the mail outright. So it runs first, alone, and the rest of ingest
 * runs inside a `try` (§4, §7.4).
 *
 * Idempotent: the key is the hash of the bytes, so a replay writes the same
 * bytes to the same key.
 */
export async function putRaw(
  env: StoreEnv,
  raw: RawObject,
): Promise<StoredRaw> {
  const sha256 = await sha256Hex(raw.bytes)
  const key = `${env.prefix ?? ''}${rawObjectKey(raw, sha256)}`

  // The byte array is handed over as-is. A parser's `Uint8Array` is often a
  // view onto a larger buffer, and R2 honours the view's bounds rather than
  // storing the whole backing buffer — measured, because getting it wrong the
  // other way means copying every attachment a second time on a 128 MB budget
  // that §4.1 already puts at a 60–90 MB peak.
  await env.bucket.put(key, raw.bytes, {
    httpMetadata: { contentType: raw.contentType },
  })

  return { key, sha256 }
}

export interface StoreResult {
  contentId: string
  messageId: string
  rawSha256: string
  rawKey: string
  /** Set only when the body spilled to R2 (§5). */
  bodyKey?: string
  /** Part order, aligned with `message.attachments`. */
  attachmentKeys: string[]
}

/** First ~2 KB of text, always in D1 (§5). Characters, not bytes — see `previewOf`. */
const PREVIEW_CHARS = 2048

/**
 * `len(text) + len(html)` at or under this stays inline in D1 (§5).
 *
 * 512 KB rather than D1's ~2 MB row ceiling, and the gap is the point: list
 * queries read `contents` rows, so the limit is about keeping them cheap to
 * scan rather than about what the platform will accept. Local D1 takes a
 * 600 KB column without complaint — measured.
 */
const BODY_INLINE_LIMIT = 512 * 1024

export async function storeInbound(
  env: StoreEnv,
  request: StoreRequest,
): Promise<StoreResult> {
  const { message } = request
  const prefix = env.prefix ?? ''

  const stored =
    request.raw ??
    (await putRaw(env, {
      ...message.raw,
      channel: message.channel,
      receivedAt: message.receivedAt,
    }))
  const { key: rawKey, sha256: rawSha256 } = stored

  const contentId = await deriveContentId(
    message.channel,
    stripTraceHeaders(message.raw.bytes),
  )
  const arrivalId = await messageId(contentId, request.inboxKey)

  const body = splitBody(message)
  const bodyKey =
    body.spilled === undefined ? undefined : `${prefix}body/${contentId}.json`

  const attachments = await Promise.all(
    message.attachments.map((part, index) =>
      describeAttachment(prefix, contentId, part, index),
    ),
  )

  // R2 before D1, and everything in parallel: these are independent objects at
  // distinct content-addressed keys, so there is no ordering between them.
  // The raw object is already up — `putRaw`, above or in the caller.
  //
  // The byte arrays are handed over as-is, for the reason `putRaw` records.
  await Promise.all([
    ...(bodyKey === undefined
      ? []
      : [
          env.bucket.put(bodyKey, JSON.stringify(body.spilled), {
            httpMetadata: { contentType: 'application/json' },
          }),
        ]),
    ...attachments.map((a) =>
      env.bucket.put(a.key, a.part.bytes, {
        httpMetadata: { contentType: a.part.mimeType },
      }),
    ),
  ])

  const contactId =
    message.contact === undefined
      ? undefined
      : await deriveContactId(message.channel, message.contact.externalId)

  // One batch, parents before children. D1 enforces foreign keys inside a
  // batch and evaluates them statement by statement, so a `messages` row
  // written before its `contents` row fails the whole batch — measured, and
  // not something a mock would have told me.
  const statements: D1PreparedStatement[] = []
  if (contactId !== undefined) {
    statements.push(upsertContact(env.db, request, contactId))
  }
  statements.push(
    insertContent(env.db, request, {
      contentId,
      contactId,
      rawSha256,
      rawKey,
      bodyKey,
      body,
    }),
    // Before the insert, and that is the whole trick — see `countMessage`.
    countMessage(env.db, request, arrivalId),
    insertMessage(env.db, request, arrivalId, contentId),
  )
  for (const participant of message.participants) {
    statements.push(insertParticipant(env.db, contentId, participant))
  }
  for (const attachment of attachments) {
    statements.push(insertAttachment(env.db, contentId, attachment))
  }

  await env.db.batch(statements)

  return {
    contentId,
    messageId: arrivalId,
    rawSha256,
    rawKey,
    attachmentKeys: attachments.map((a) => a.key),
    ...(bodyKey === undefined ? {} : { bodyKey }),
  }
}

/**
 * `raw/{channel}/{yyyy}/{mm}/{sha256}` (§9).
 *
 * Dated by `receivedAt`, never by the `Date` header: the header is
 * sender-supplied and a lie puts the object in a partition nobody sweeping by
 * month will look in. No extension — `raw_content_type` in D1 says whether the
 * bytes are RFC822 or JSON, and a key that also claimed it could disagree.
 */
function rawObjectKey(raw: RawObject, sha256: string): string {
  const at = raw.receivedAt
  const yyyy = at.getUTCFullYear()
  const mm = String(at.getUTCMonth() + 1).padStart(2, '0')
  return `raw/${raw.channel}/${yyyy}/${mm}/${sha256}`
}

interface DescribedAttachment {
  id: string
  key: string
  sha256: string
  part: Attachment
}

/**
 * `att/{content_id}/{sha256(bytes)}` (§9) — **no filename anywhere in it**.
 * Names arrive from the sender and decode to arbitrary bytes; keeping them out
 * of the key space removes path traversal and header injection from the
 * storage layer entirely rather than relying on a sanitiser. The name is in
 * D1, where it is data.
 */
async function describeAttachment(
  prefix: string,
  contentId: string,
  part: Attachment,
  index: number,
): Promise<DescribedAttachment> {
  const sha256 = await sha256Hex(part.bytes)
  return {
    // Part index, not the byte hash: the same file attached twice is two
    // attachments, and hashing the bytes would silently collapse them (§9.1).
    id: await sha256Hex(enc.encode(`${contentId}:${index}`)),
    key: `${prefix}att/${contentId}/${sha256}`,
    sha256,
    part,
  }
}

/**
 * `sha256(channel + ':' + external_id)`.
 *
 * Channel-qualified because an address, an E.164 number and a social handle
 * only mean anything inside their own channel — and because an unqualified
 * `From` is exactly the unauthenticated key the identity rule forbids.
 */
function deriveContactId(channel: string, externalId: string): Promise<string> {
  return sha256Hex(enc.encode(`${channel}:${externalId}`))
}

interface SplitBody {
  preview: string | null
  text: string | null
  html: string | null
  /** Present when the body was too big for D1 and went to R2 instead. */
  spilled?: { text?: string; html?: string }
}

/**
 * Decide where the body lives (§5).
 *
 * `body_preview` is written either way, so a list view never has to reach into
 * R2 for something to show.
 */
function splitBody(message: Inbound): SplitBody {
  const preview = previewOf(message.text)

  if (bodyBytes(message) <= BODY_INLINE_LIMIT) {
    return {
      preview,
      text: message.text ?? null,
      html: message.html ?? null,
    }
  }

  return {
    preview,
    text: null,
    html: null,
    spilled: {
      ...(message.text === undefined ? {} : { text: message.text }),
      ...(message.html === undefined ? {} : { html: message.html }),
    },
  }
}

/**
 * UTF-8 byte length of the two body parts.
 *
 * Measured in two stages so an enormous body is rejected without being copied.
 * A JS string's `length` counts UTF-16 code units, and every code point costs
 * at least as many UTF-8 bytes as it does code units, so `length` is a valid
 * lower bound: if that alone is over the limit, encoding is pointless.
 */
function bodyBytes(message: Inbound): number {
  const units = (message.text?.length ?? 0) + (message.html?.length ?? 0)
  if (units > BODY_INLINE_LIMIT) return Number.POSITIVE_INFINITY

  return (
    (message.text === undefined ? 0 : enc.encode(message.text).length) +
    (message.html === undefined ? 0 : enc.encode(message.html).length)
  )
}

/**
 * Sliced by characters rather than bytes, and only ever shrunk by one: a slice
 * that lands between a surrogate pair would store a lone surrogate, which is
 * not valid text and survives a round trip through D1 to surprise whoever
 * renders it.
 *
 * No preview is derived from HTML. Stripping tags to make one is a rendering
 * decision, and guessing at it here would bake it into the archive.
 */
function previewOf(text: string | undefined): string | null {
  if (text === undefined) return null
  if (text.length <= PREVIEW_CHARS) return text

  const cut = text.slice(0, PREVIEW_CHARS)
  const last = cut.charCodeAt(cut.length - 1)
  const orphan = last >= 0xd800 && last <= 0xdbff
  return orphan ? cut.slice(0, -1) : cut
}

/**
 * `first_seen` is the minimum and `last_seen` the maximum, rather than "leave
 * one, overwrite the other". Replay exists (`inbox-worker replay`), so a
 * message older than everything we hold will arrive after it, and a plain
 * assignment would move `first_seen` forwards in time.
 *
 * `display_name` is last-non-null-wins: people rename themselves, and a
 * message that carries no name should not blank the one we have.
 */
function upsertContact(
  db: D1Database,
  request: StoreRequest,
  contactId: string,
): D1PreparedStatement {
  const contact = request.message.contact
  const at = request.message.receivedAt.getTime()

  return db
    .prepare(
      `INSERT INTO contacts
         (id, channel, external_id, display_name, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel, external_id) DO UPDATE SET
         display_name = coalesce(excluded.display_name, display_name),
         first_seen   = min(first_seen, excluded.first_seen),
         last_seen    = max(last_seen, excluded.last_seen)`,
    )
    .bind(
      contactId,
      request.message.channel,
      contact?.externalId ?? null,
      contact?.name ?? null,
      at,
      at,
    )
}

interface ContentFields {
  contentId: string
  contactId: string | undefined
  rawSha256: string
  rawKey: string
  bodyKey: string | undefined
  body: SplitBody
}

/**
 * `subject_norm` is left NULL deliberately. The column exists for a
 * normalisation nothing has specified, and §8 turned off the one feature that
 * would read it. Inventing a rule now would apply it silently to the whole
 * archive; it is a backfillable column, so the cost of waiting is nothing.
 */
function insertContent(
  db: D1Database,
  request: StoreRequest,
  fields: ContentFields,
): D1PreparedStatement {
  const { message } = request

  return db
    .prepare(
      `INSERT OR IGNORE INTO contents
         (id, channel, external_id, raw_sha256, contact_id, subject,
          subject_norm, body_preview, text_body, html_body, body_r2_key,
          raw_r2_key, raw_content_type, verified, sent_at, size_bytes,
          has_attachments, meta)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      fields.contentId,
      message.channel,
      message.externalId ?? null,
      fields.rawSha256,
      fields.contactId ?? null,
      message.subject ?? null,
      fields.body.preview,
      fields.body.text,
      fields.body.html,
      fields.bodyKey ?? null,
      fields.rawKey,
      message.raw.contentType,
      request.verified === true ? 1 : 0,
      message.sentAt?.getTime() ?? null,
      message.raw.bytes.length,
      message.attachments.length > 0 ? 1 : 0,
      metaJson(request),
    )
}

/**
 * Timestamps are epoch **milliseconds** everywhere. `Date.getTime()` is the
 * unit that reaches this layer, and rounding to seconds would collapse the
 * ordering of a burst delivered inside the same second — which is precisely
 * what `idx_messages_inbox` sorts on.
 */
function insertMessage(
  db: D1Database,
  request: StoreRequest,
  arrivalId: string,
  contentId: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO messages
         (id, content_id, inbox_key, conversation_id, direction, target, tag,
          matched_rule, received_at)
       VALUES (?, ?, ?, ?, 'in', ?, ?, NULL, ?)`,
    )
    .bind(
      arrivalId,
      contentId,
      request.inboxKey,
      request.conversationId,
      request.message.target,
      request.tag ?? null,
      request.message.receivedAt.getTime(),
    )
}

/**
 * `conversations.message_count`, the one conversation column storage owns.
 *
 * Nothing else can own it correctly. `resolveConversation` runs first and
 * cannot tell a new arrival from a redelivery it is about to ignore, so
 * incrementing there over-counts every retry and every replay. The handler
 * could ask afterwards whether the row was inserted, but only from outside the
 * batch — leaving a window where the count and the rows disagree, and a second
 * statement that can fail on its own after the message is already committed.
 *
 * Here it is exact by construction. `INSERT OR IGNORE INTO messages` is the
 * next statement, so `NOT EXISTS` still sees the state *before* it: true only
 * when the insert is really going to add a row. Both are in one batch and D1
 * runs a batch as a transaction — measured — so there is no interleaving that
 * can separate them. Ordering is load-bearing; swapping the two makes this a
 * no-op that quietly leaves every count at zero.
 *
 * `messages.id` is the primary key, so the check is a point lookup: this does
 * not scale with the size of the conversation, which is §8's standing promise.
 */
function countMessage(
  db: D1Database,
  request: StoreRequest,
  arrivalId: string,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE conversations
          SET message_count = message_count + 1
        WHERE id = ?
          AND NOT EXISTS (SELECT 1 FROM messages WHERE id = ?)`,
    )
    .bind(request.conversationId, arrivalId)
}

function insertParticipant(
  db: D1Database,
  contentId: string,
  participant: Participant,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO participants (content_id, role, identifier, name)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(
      contentId,
      participant.role,
      participant.identifier,
      participant.name ?? null,
    )
}

function insertAttachment(
  db: D1Database,
  contentId: string,
  attachment: DescribedAttachment,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO attachments
         (id, content_id, filename, mime_type, size_bytes, r2_key, cid,
          is_inline, sha256)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      attachment.id,
      contentId,
      attachment.part.filename ?? null,
      attachment.part.mimeType,
      attachment.part.bytes.length,
      attachment.key,
      attachment.part.cid ?? null,
      attachment.part.inline ? 1 : 0,
      attachment.sha256,
    )
}

/**
 * The channel's own `meta`, plus whatever the caps discarded. Overflows belong
 * with the content rather than in a log, because "this message is missing 12
 * attachments" is something a reader has to be able to see.
 */
function metaJson(request: StoreRequest): string | null {
  const overflows = request.overflows ?? []
  const meta = {
    ...request.message.meta,
    ...(overflows.length === 0 ? {} : { overflows }),
  }
  return Object.keys(meta).length === 0 ? null : JSON.stringify(meta)
}
