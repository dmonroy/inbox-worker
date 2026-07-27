/**
 * Address parsing and normalisation.
 *
 * One rule, applied everywhere an address becomes a key: lowercase it and drop
 * any plus-tag. Without a single rule, `Darwin@Gmail.com` and `darwin@gmail.com`
 * become two contacts, and every join against them misses one.
 */

export interface Address {
  /** As received, minus surrounding whitespace and angle brackets. */
  raw: string
  /** Lowercased local part, plus-tag removed. */
  local: string
  /** Lowercased domain. */
  domain: string
  /** `local@domain`, normalised. The storage key and the comparison key. */
  key: string
  /**
   * Plus-addressing tag, if any. `support+acme@x` -> `acme`.
   *
   * Case is preserved, unlike `local`/`domain`. A tag is opaque payload we
   * never compare — it may encode an external identifier — whereas the local
   * part and domain are identity, and identity has to normalise.
   */
  tag?: string
}

/**
 * Parse a single address. Returns null for anything unusable rather than
 * throwing: bad addresses arrive from the network constantly and are a routing
 * decision, not an exception.
 *
 * Accepts a bare address (`a@b.com`) or an angle-bracketed one (`<a@b.com>`).
 * Display names are not handled here — MIME headers are parsed upstream, and
 * envelope addresses never carry one.
 */
export function parseAddress(input: string): Address | null {
  let raw = input.trim()
  if (raw === '') return null

  // Tolerate `<a@b.com>` and `Name <a@b.com>` by taking the last bracketed run.
  const open = raw.lastIndexOf('<')
  const close = raw.lastIndexOf('>')
  if (open !== -1 && close > open) {
    raw = raw.slice(open + 1, close).trim()
    if (raw === '') return null
  }

  // Split on the LAST '@': a quoted local part may legally contain one,
  // as in `"weird@local"@example.com`.
  const at = raw.lastIndexOf('@')
  if (at <= 0 || at === raw.length - 1) return null

  const localRaw = raw.slice(0, at)
  const domainRaw = raw.slice(at + 1)

  // Reject rather than guess. Whitespace or a stray '<'/'>' means we were
  // handed something that isn't a single address.
  if (/[\s<>,;]/.test(localRaw) || /[\s<>,;@]/.test(domainRaw)) return null

  // A leading '+' is part of the local part, not an empty-mailbox tag.
  let local = localRaw
  let tag: string | undefined
  const plus = localRaw.indexOf('+')
  if (plus > 0) {
    local = localRaw.slice(0, plus)
    // Everything after the FIRST '+' is the tag, inner '+' included.
    const rest = localRaw.slice(plus + 1)
    if (rest !== '') tag = rest
  }

  const localLower = local.toLowerCase()
  const domainLower = domainRaw.toLowerCase()

  return {
    raw,
    local: localLower,
    domain: domainLower,
    key: `${localLower}@${domainLower}`,
    ...(tag === undefined ? {} : { tag }),
  }
}

/** The comparison key for an address, or null if it can't be parsed. */
export function normalizeAddress(input: string): string | null {
  return parseAddress(input)?.key ?? null
}
