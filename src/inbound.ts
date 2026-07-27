/**
 * The normalised message — what every channel produces and everything
 * downstream consumes.
 *
 * Shaped by email, because email needs the most (§1: generalise *from* email,
 * not *to* a lowest common denominator). A chat channel populates a subset and
 * leaves the rest undefined; that is the design working, not a gap.
 *
 * Separate from `types.ts`, which is configuration. These are data.
 */

/** Who sent it. */
export interface ContactRef {
  /**
   * Stable identity within the channel: normalised address for email, E.164
   * for WhatsApp, provider id for social. Goes to `contacts.external_id`, so
   * it must already be through this channel's normalisation rule.
   */
  externalId: string
  /** Display name as given by the sender. Cosmetic, never a key. */
  name?: string
}

/** Someone else the message was addressed to. */
export interface Participant {
  /** `member` is for group chats, where there is no to/cc distinction. */
  role: 'to' | 'cc' | 'bcc' | 'member'
  /** Normalised, same rule as `ContactRef.externalId`. */
  identifier: string
  name?: string
}

export interface Attachment {
  /**
   * Sanitised, and absent when the sender gave none or gave only a name that
   * sanitised away. Never part of a storage key — R2 keys are content hashes
   * (§4) — so this is display data.
   */
  filename?: string
  mimeType: string
  bytes: Uint8Array
  /** Rendered inside the body rather than listed as a download. */
  inline: boolean
  /** `Content-ID` without its angle brackets. What inline HTML references. */
  cid?: string
}

export interface Inbound {
  /** `channel.id`. Written to every row, so it is stable for the life of the data. */
  channel: string
  /**
   * The channel's own id for this message — RFC `Message-ID` for email.
   * Threading key only, never identity (§4).
   */
  externalId?: string
  /**
   * Absent when the sender could not be determined. Optional rather than
   * invented: a placeholder contact would collect every malformed sender under
   * one identity, and `contents.contact_id` is nullable for exactly this.
   */
  contact?: ContactRef
  participants: Participant[]
  /** Envelope address, business number, or widget id. Decides routing. */
  target: string

  subject?: string
  text?: string
  html?: string
  attachments: Attachment[]

  /** Sender-claimed send time. Unverified, and absent if unparseable. */
  sentAt?: Date
  /** When we received it. The trusted ordering field. */
  receivedAt: Date

  /**
   * The exact bytes, already buffered.
   *
   * A stream would be wrong here: `message.raw` is single-use and of unknown
   * length, so it is read once into memory before anything else touches it
   * (§4.1). Handing a stream around is how you get a perfect `.eml` in R2
   * beside a row with no subject and no body.
   */
  raw: { bytes: Uint8Array; contentType: string }

  /** Channel-specific extras. The escape hatch that keeps the schema fixed. */
  meta: Record<string, unknown>
}

/**
 * `Inbound.meta` for the email channel.
 *
 * Threading inputs live here rather than on `Inbound` because only channels
 * that infer conversations from a reference graph have them (§3.2), and every
 * other channel would carry two empty fields forever.
 */
export type EmailMeta = {
  /** Brackets stripped, same form as `externalId`. */
  inReplyTo?: string
  /** Brackets stripped, header order, de-duplicated. Uncapped — §8 takes the last 20. */
  references: string[]
}
