/**
 * MIME bytes -> `Inbound`, for the email channel.
 *
 * Mapping only. Nothing here decides routing, identity, or storage — it turns
 * one wire format into the shape everything else already understands.
 *
 * **This may throw**, and is the only step in ingest that is allowed to. A
 * message crafted to break the parser must not be quietly stored as an empty
 * shell; the handler catches, keeps the raw bytes, and writes a
 * `failed_ingest` row (§7.4). Catching here would hide that decision.
 */

import type { Address, Attachment as MimeAttachment } from 'postal-mime'
import PostalMime from 'postal-mime'
import { normalizeAddress } from './address'
import { DEFAULT_CAPS, type IngestCaps } from './caps'
import type {
  Attachment,
  ContactRef,
  EmailMeta,
  Inbound,
  Participant,
} from './inbound'

export interface ParseContext {
  /**
   * The envelope recipient.
   *
   * Passed in rather than read from `To`, and the distinction is load-bearing.
   * The envelope is what actually delivered the message; `To` is sender-
   * supplied text that disagrees with it on every bcc, forward, and mailing
   * list. Trusting the header would route a bcc'd message to whichever inbox
   * the sender chose to name.
   */
  target: string
  receivedAt: Date
  /**
   * Only `depth` and `headerBytes` are read here — they have to be set before
   * parsing to mean anything. The rest are applied by `applyCaps` afterwards,
   * because postal-mime decodes every part before it returns.
   */
  caps?: IngestCaps
}

export async function parseEmail(
  raw: Uint8Array,
  ctx: ParseContext,
): Promise<Inbound> {
  const caps = ctx.caps ?? DEFAULT_CAPS

  const email = await PostalMime.parse(raw, {
    // Decoded bytes, not a base64 string. Attachment R2 keys are a hash of the
    // content (§4), and hashing the encoded form would key the same file
    // differently depending on how the sender encoded it.
    attachmentEncoding: 'arraybuffer',
    // These two throw rather than truncate, which is the only thing they can
    // do: a message too deep or too header-heavy to parse has no truncated
    // form to keep. The handler dead-letters it with the raw bytes intact.
    // Left unset, postal-mime allows 256 levels and 2 MB of headers.
    maxNestingDepth: caps.depth,
    maxHeadersSize: caps.headerBytes,
  })

  const meta: EmailMeta = {
    references: parseReferences(email.references),
    ...optional('inReplyTo', unbracket(email.inReplyTo)),
  }

  return {
    channel: 'email',
    target: ctx.target,
    receivedAt: ctx.receivedAt,
    participants: [
      ...participants('to', email.to),
      ...participants('cc', email.cc),
      ...participants('bcc', email.bcc),
    ],
    attachments: email.attachments.map(attachment),
    raw: { bytes: raw, contentType: 'message/rfc822' },
    meta,
    ...optional('externalId', unbracket(email.messageId)),
    ...optional('contact', contact(email.from)),
    ...optional('subject', text(email.subject)),
    ...optional('text', text(email.text)),
    ...optional('html', text(email.html)),
    ...optional('sentAt', sentAt(email.date)),
  }
}

/**
 * `exactOptionalPropertyTypes` distinguishes "absent" from "present and
 * undefined", so an optional field has to be spread in or left out entirely.
 */
function optional<K extends string, V>(
  key: K,
  value: V | undefined,
): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>)
}

/** Empty and absent mean the same thing; `''` in D1 would not match `IS NULL`. */
function text(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

/**
 * An angle-bracketed token — `Message-ID`, `In-Reply-To`, `Content-ID` — with
 * the brackets removed. The stored form has to match the looked-up form, or
 * every threading join and every `cid:` lookup misses.
 *
 * Case is **preserved**. These are opaque tokens matched by exact string;
 * lowercasing would collide two genuinely distinct ids from any sender whose
 * generator varies case.
 */
function unbracket(value: string | undefined): string | undefined {
  let id = value?.trim()
  if (id === undefined) return undefined
  if (id.startsWith('<') && id.endsWith('>')) id = id.slice(1, -1).trim()
  return id === '' ? undefined : id
}

/**
 * `References` is a whitespace-separated list, folded across lines by every
 * real client once a thread gets long. De-duplicated because §8 considers only
 * the last 20 candidates, and a repeated id would spend that budget without
 * adding an ancestor.
 */
function parseReferences(value: string | undefined): string[] {
  // Tolerates `<a><b>` with no separator, which some clients emit.
  const tokens = value?.match(/<[^>]*>|[^\s<>]+/g) ?? []

  const seen = new Set<string>()
  const out: string[] = []
  for (const token of tokens) {
    const id = unbracket(token)
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * Address lists may contain groups (`Team: a@x, b@x;`), which carry members
 * instead of an address of their own. Flattening keeps a grouped recipient a
 * recipient rather than dropping them.
 */
function* mailboxes(list: readonly Address[] | undefined) {
  for (const entry of list ?? []) {
    yield* entry.group ?? [entry]
  }
}

function participants(
  role: Participant['role'],
  list: readonly Address[] | undefined,
): Participant[] {
  const out: Participant[] = []
  for (const box of mailboxes(list)) {
    // Dropped rather than stored raw. `participants.identifier` is a join key
    // against `contacts.external_id`, and a string that will not normalise is
    // not a key — it only pollutes the index. Nothing is unrecoverable: the
    // raw message is in R2 unconditionally.
    const identifier = normalizeAddress(box.address ?? '')
    if (identifier === null) continue
    out.push({ role, identifier, ...optional('name', text(box.name)) })
  }
  return out
}

function contact(from: Address | undefined): ContactRef | undefined {
  for (const box of mailboxes(from === undefined ? undefined : [from])) {
    const externalId = normalizeAddress(box.address ?? '')
    if (externalId === null) continue
    return { externalId, ...optional('name', text(box.name)) }
  }
  // No placeholder. An invented contact would gather every sender we could not
  // parse under one identity, merging strangers' history in the reader.
  return undefined
}

/**
 * `new Date('yesterday')` is a `Date` whose `getTime()` is `NaN`. Stored, that
 * becomes a NaN timestamp in D1, and every query ordering on it goes wrong in
 * a way that is very hard to trace back to one bad header.
 *
 * No sanity bound on the value itself: senders lie about the time and clocks
 * drift, which is why `receivedAt` is the trusted ordering field.
 */
function sentAt(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

function attachment(part: MimeAttachment): Attachment {
  return {
    mimeType: part.mimeType,
    bytes: bytes(part.content),
    // An inline image usually arrives inside multipart/related with a
    // Content-ID and no explicit disposition. Requiring the disposition would
    // list the sender's signature logo as a download on every message.
    inline: part.disposition === 'inline' || part.related === true,
    ...optional('filename', filename(part.filename)),
    ...optional('cid', unbracket(part.contentId)),
  }
}

function bytes(content: MimeAttachment['content']): Uint8Array {
  if (typeof content === 'string') return new TextEncoder().encode(content)
  return content instanceof Uint8Array ? content : new Uint8Array(content)
}

const MAX_FILENAME = 255

/**
 * Attachment names never reach a storage key — R2 keys are content hashes
 * (§4), which removes hostile filenames from the key space entirely. So this
 * protects whoever *serves* a download later and reaches for `filename` to
 * build a `Content-Disposition` header or a path on disk.
 *
 * Names arrive RFC 2047 encoded, so the hostile version only exists after the
 * parser has decoded it — which is why sanitising happens here and not on the
 * raw header.
 */
function filename(value: string | null): string | undefined {
  if (value === null) return undefined

  let name = value
    // Basename. Covers `../../etc/passwd`, `/etc/shadow`, and Windows paths.
    .replace(/^.*[/\\]/, '')
    // A CR or LF here is a header-injection primitive downstream.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()

  // All-dots is not a name, it is a directory reference.
  if (name === '' || /^\.+$/.test(name)) return undefined

  // Truncation loses the extension, which is acceptable: `mimeType` is stored
  // beside it and is the authoritative type. A name this long is not real.
  if (name.length > MAX_FILENAME) name = name.slice(0, MAX_FILENAME)

  return name
}
