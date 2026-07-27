/**
 * Envelope recipient -> inbox.
 *
 * Phase 1 routing is a lookup, not a rule engine: the local part names the
 * inbox. Predicate routing (sender, subject, headers) is additive when it
 * lands and changes nothing here.
 */

import { parseAddress } from './address'
import { QUARANTINE, type ResolvedConfig } from './types'

export type Resolution =
  /** Addressed to a real inbox. */
  | { status: 'matched'; inboxKey: string; target: string; tag?: string }
  /** Nothing matched, so it goes to quarantine rather than being lost. */
  | { status: 'fallback'; inboxKey: string; target: string; reason: string }
  /** Refused before anything is stored. See `unknown-domain` below. */
  | { status: 'rejected'; target: string; reason: string }

export function resolveTarget(
  config: ResolvedConfig,
  envelopeTo: string,
): Resolution {
  const target = envelopeTo.trim()

  const address = parseAddress(target)
  if (address === null) {
    // We cannot read the recipient, but rejecting is permanent and would lose
    // the message. Quarantine keeps it reviewable.
    return {
      status: 'fallback',
      inboxKey: QUARANTINE,
      target,
      reason: 'unparseable-address',
    }
  }

  // Checked before the local part, deliberately. Mail for a domain we never
  // declared means the zone is pointed here by mistake; quarantining it
  // silently would make a misconfiguration look like ordinary unknown-address
  // traffic. This is the only rejection that happens before storage.
  if (!accepts(config, address.domain)) {
    return { status: 'rejected', target, reason: 'unknown-domain' }
  }

  const inbox = config.inboxes.get(address.local)

  // `system` inboxes exist but are not addressable: quarantine@ has to land in
  // quarantine by falling back, never by matching, or anyone could post to it.
  if (inbox === undefined || inbox.system === true) {
    return {
      status: 'fallback',
      inboxKey: QUARANTINE,
      target,
      reason: 'unknown-address',
    }
  }

  return {
    status: 'matched',
    inboxKey: address.local,
    target,
    ...(address.tag === undefined ? {} : { tag: address.tag }),
  }
}

/** Every declared domain and alias shares one inbox space. */
function accepts(config: ResolvedConfig, domain: string): boolean {
  return config.channels.some(
    (c) => c.domain === domain || c.aliases.includes(domain),
  )
}
