/**
 * Message identity.
 *
 * The rule: identity never derives from unauthenticated sender-supplied data.
 *
 * An earlier design keyed content on the `Message-ID` header. That header is
 * written by the sender, visible in every quoted reply and list archive, and
 * routinely duplicated by broken senders — which gave two silent failures. An
 * appliance emitting one id for every alert would store the first and discard
 * the rest; and anyone who knew an id could overwrite that message's stored
 * bytes. Hashing content makes both impossible.
 *
 * `Message-ID` survives as the threading key, where being sender-supplied is
 * inherent to the job and the damage is contained.
 */

/** Hex SHA-256. `crypto.subtle` exists in Workers and in Node alike. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)

  let hex = ''
  for (const byte of new Uint8Array(digest)) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}

/**
 * Identity of a payload, however many inboxes receive it.
 *
 * `normalized` is the raw bytes with anything per-delivery removed — for
 * email, the trace headers (see `trace.ts`). That is what lets the two
 * invocations of a fan-out agree on one id while two genuinely different
 * messages sharing a `Message-ID` stay apart.
 *
 * Channel-scoped, because a provider message id is only unique within its own
 * channel.
 */
export function contentId(
  channel: string,
  normalized: Uint8Array,
): Promise<string> {
  return sha256Hex(prefixed(channel, normalized))
}

/**
 * Identity of one arrival: this payload, in this inbox.
 *
 * A redelivery to the same inbox collides and is ignored; fan-out to a second
 * inbox yields a distinct id and adds a row.
 */
export function messageId(
  contentId: string,
  inboxKey: string,
): Promise<string> {
  return sha256Hex(new TextEncoder().encode(`${contentId}:${inboxKey}`))
}

/**
 * `channel` and the payload joined by a byte that cannot occur in a channel
 * id, so no channel name and payload can be rearranged into another pair.
 */
function prefixed(channel: string, bytes: Uint8Array): Uint8Array {
  const head = new TextEncoder().encode(`${channel}:`)
  const out = new Uint8Array(head.length + bytes.length)
  out.set(head)
  out.set(bytes, head.length)
  return out
}
