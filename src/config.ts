/**
 * Configuration: the inboxes that exist, and the channels that feed them.
 *
 * Kinds are expressed as constructors rather than a `kind:` field or a string
 * enum. Adding one is exporting a function — no union to widen, no config
 * schema change — and each constructor takes genuinely different options.
 * `Team` accepting an `owner` is a compile error, which a shared options type
 * could not express.
 */

import {
  type EmailChannel,
  type InboxConfig,
  type InboxDef,
  type MemberInbox,
  QUARANTINE,
  type ResolvedConfig,
  type TeamInbox,
} from './types.js'
import { validate } from './validate.js'

export {
  type Channel,
  type EmailChannel,
  type InboxConfig,
  type InboxDef,
  type MemberInbox,
  QUARANTINE,
  type ResolvedConfig,
  type TeamInbox,
} from './types.js'

/** A shared inbox. Teams have no owner: a team is not a person. */
export function Team(name: string): TeamInbox {
  return { kind: 'team', name }
}

export function Member(name: string, opts?: { owner?: string }): MemberInbox {
  return {
    kind: 'member',
    name,
    ...(opts?.owner === undefined ? {} : { owner: opts.owner }),
  }
}

/**
 * The `authserv-id` Cloudflare Email Routing stamps on its own
 * `Authentication-Results` header.
 *
 * A default rather than a required option because getting it wrong fails
 * **closed**: the DMARC gate declines to believe the header, no unreceived id
 * is seeded, and the worst outcome is a conversation that splits in two (§8).
 * Verify it against a real delivery before relying on threading, and override
 * it if the mail reaches this worker through anything else.
 */
export const CLOUDFLARE_AUTHSERV_ID = 'mx.cloudflare.net'

export function Email(opts: {
  domain: string
  aliases?: readonly string[]
  /** See `CLOUDFLARE_AUTHSERV_ID`. */
  authservId?: string
}): EmailChannel {
  return {
    id: 'email',
    domain: opts.domain.trim().toLowerCase(),
    aliases: (opts.aliases ?? []).map((a) => a.trim().toLowerCase()),
    authservId: (opts.authservId ?? CLOUDFLARE_AUTHSERV_ID)
      .trim()
      .toLowerCase(),
  }
}

/**
 * Validate and resolve the configuration. Called once per isolate, at module
 * scope, so a broken config fails at startup rather than on the first message.
 *
 * This throws, which is the opposite of the ingest rule that a message must
 * never be lost to an exception. The two are consistent: a broken config is a
 * developer error visible at deploy time, and failing loudly is the only way
 * it gets noticed. A malformed message is a routing decision at runtime.
 *
 * Named for what it returns. `inbox()` is the worker entry point (§2.1) and is
 * built on this; a consumer reaches for this one only to hand a `ResolvedConfig`
 * to `resolveTarget` in their own tests.
 */
export function resolveConfig(config: InboxConfig): ResolvedConfig {
  const { errors, warnings } = validate(config)

  if (errors.length > 0) {
    throw new Error(
      `Invalid inbox configuration:\n${errors.map((e) => `  - ${e}`).join('\n')}`,
    )
  }

  const inboxes = new Map<string, InboxDef>(Object.entries(config.inboxes))
  inboxes.set(QUARANTINE, { kind: 'team', name: 'Quarantine', system: true })

  return { inboxes, channels: config.channels, warnings }
}
