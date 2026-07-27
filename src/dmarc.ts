/**
 * Did the *receiving edge* say this message passed DMARC? (§8)
 *
 * The answer gates one thing: whether a message may seed a
 * `conversation_index` row for an id nobody has received. Ungated that is a
 * thread-hijacking primitive — mail `support@` with
 * `References: <id-I-expect-you-to-get>` and the real message later joins the
 * attacker's conversation. It is the only place in the system where
 * authentication is enforced rather than merely recorded.
 *
 * Which makes reading it correctly load-bearing, and it is not a substring
 * search. `Authentication-Results` is an ordinary header, so **a sender writes
 * one too**. Cloudflare prepends its own, the message arrives carrying both,
 * and `Headers.get()` joins repeated headers into a single comma-separated
 * string with no way to tell where one ends and the next begins. A test for
 * `dmarc=pass` anywhere in that value matches the *attacker's* header sitting
 * below the edge's genuine `dmarc=fail`, and the gate opens for exactly the
 * messages it exists to stop.
 *
 * So this reads the raw bytes rather than `message.headers`, and takes the
 * **first** `Authentication-Results` in the header block — the edge prepends,
 * so anything a sender wrote is below it — and only believes it if its
 * `authserv-id` is the one this deployment expects.
 *
 * Both halves are needed. Position alone trusts the sender's header on any
 * message no edge stamped; the id alone trusts a forgery that copies the id,
 * which costs an attacker nothing.
 *
 * **Fails closed.** Unreadable, absent, from an unrecognised authserv-id, or
 * simply not a pass, and the answer is `false`. The cost of a false negative
 * is a conversation that splits in two; the cost of a false positive is one
 * customer's thread spliced into another's.
 */

const AUTH_RESULTS = 'authentication-results'

/**
 * `dmarc=pass`, as a methodspec rather than as text.
 *
 * RFC 8601 gives each resinfo a `method=result` first, then space-separated
 * `ptype.property=value` pairs — every one of which is attacker-chosen. Anchored
 * at both ends of a single token so that `reason="dmarc=pass"` and
 * `header.d=dmarc=pass` do not count, and with the optional method version
 * (`dmarc/1=pass`) RFC 8601 allows.
 */
const DMARC_PASS = /^dmarc(?:\/\d+)?=pass$/i

export function dmarcPassed(raw: Uint8Array, authservId: string): boolean {
  const value = firstAuthResults(raw)
  if (value === undefined) return false

  // `authserv-id [CFWS version]` — the version is a bare digit string after
  // the id and is not part of it.
  const [head, ...resinfo] = value.split(';')
  const id = (head ?? '').trim().split(/\s+/)[0] ?? ''

  // Exact, case-insensitive. A prefix or `includes` test would accept
  // `mx.cloudflare.net.mallory.example`, which is a domain anyone can register.
  if (id.toLowerCase() !== authservId.trim().toLowerCase()) return false

  return resinfo.some((entry) => {
    const method = entry.trim().split(/\s+/)[0] ?? ''
    return DMARC_PASS.test(method)
  })
}

const LF = 0x0a
const CR = 0x0d

/**
 * The value of the first `Authentication-Results` header, unfolded.
 *
 * Only the header block is decoded. A body is arbitrary bytes and a body line
 * shaped like a header is not a header — every quoted reply carries the
 * original message's headers, and treating those as ours would let a sender
 * supply the result by quoting it.
 */
function firstAuthResults(raw: Uint8Array): string | undefined {
  const block = new TextDecoder().decode(raw.subarray(0, endOfHeaders(raw)))

  // Unfold before splitting. A folded value is one value across continuation
  // lines, and a verbose edge routinely pushes `dmarc=` onto the second one.
  for (const line of block.replace(/\r?\n(?=[ \t])/g, ' ').split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    if (line.slice(0, colon).trim().toLowerCase() !== AUTH_RESULTS) continue

    return line.slice(colon + 1)
  }

  return undefined
}

/** Offset of the blank line that ends the header block, or the whole message. */
function endOfHeaders(raw: Uint8Array): number {
  let start = 0

  while (start < raw.length) {
    const lf = raw.indexOf(LF, start)
    if (lf === -1) break

    const contentEnd = raw[lf - 1] === CR ? lf - 1 : lf
    if (contentEnd === start) return start

    start = lf + 1
  }

  return raw.length
}
