/**
 * Configuration validation.
 *
 * Pure and total: it never throws and never logs. It reports what is wrong and
 * lets the caller decide. That keeps every rule testable without catching
 * exceptions or capturing console output.
 *
 * Errors are things that would misroute or lose mail. Warnings are things that
 * are legal but almost certainly a mistake.
 */

import { parseAddress } from './address'
import { type Channel, type InboxConfig, QUARANTINE } from './types'

export interface ValidationResult {
  errors: string[]
  warnings: string[]
}

/** Lowercase, starts alphanumeric. Keys are written to every stored row. */
const INBOX_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** Two or more labels, no leading or trailing hyphen, 253 chars max. */
const DOMAIN =
  /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/

export function validate(config: InboxConfig): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  const keys = Object.keys(config.inboxes)

  if (keys.length === 0) {
    errors.push('No inboxes declared.')
  }

  for (const key of keys) {
    if (key === QUARANTINE) {
      errors.push(`Inbox "${QUARANTINE}" is built in and cannot be declared.`)
      continue
    }
    if (!INBOX_KEY.test(key)) {
      errors.push(
        `Inbox key "${key}" is invalid. Use lowercase letters, digits, ` +
          `hyphen or underscore, starting with a letter or digit.`,
      )
    }
  }

  // Owner addresses. Nothing reads them yet, but a malformed one recorded now
  // is a bad address to send a login code to later.
  for (const [key, def] of Object.entries(config.inboxes)) {
    if (def.kind !== 'member' || def.owner === undefined) continue

    const owner = parseAddress(def.owner)
    if (owner === null) {
      errors.push(`Inbox "${key}" has an unparseable owner: "${def.owner}".`)
      continue
    }
    if (ownsDomain(config, owner.domain)) {
      // Legal, but a login code mailed here needs the login code to read.
      warnings.push(
        `Inbox "${key}" has owner "${owner.key}" on a domain this worker ` +
          `receives. An external address is almost always intended.`,
      )
    }
  }

  if (config.channels.length === 0) {
    errors.push('No channels declared. Nothing can arrive.')
  }

  const claimed = new Map<string, string>()

  for (const channel of config.channels) {
    const seen = new Set<string>()

    for (const [label, domain] of domainsOf(channel)) {
      if (!DOMAIN.test(domain)) {
        errors.push(
          `Channel "${channel.id}" has an invalid ${label}: "${domain}".`,
        )
        continue
      }
      if (seen.has(domain)) {
        errors.push(`Channel "${channel.id}" lists "${domain}" more than once.`)
        continue
      }
      seen.add(domain)

      const owner = claimed.get(domain)
      if (owner !== undefined) {
        errors.push(
          `Domain "${domain}" is claimed by more than one channel ` +
            `("${owner}" and "${channel.id}").`,
        )
      } else {
        claimed.set(domain, channel.id)
      }
    }
  }

  return { errors, warnings }
}

function* domainsOf(channel: Channel): Generator<[string, string]> {
  yield ['domain', channel.domain]
  for (const alias of channel.aliases) yield ['alias', alias]
}

function ownsDomain(config: InboxConfig, domain: string): boolean {
  return config.channels.some(
    (c) => c.domain === domain || c.aliases.includes(domain),
  )
}
