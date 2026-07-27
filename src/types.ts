/**
 * Shared shapes. Lives apart from `config.ts` so validation can depend on the
 * types without depending on the constructors, which would be a cycle.
 */

/** Built-in inbox for anything that matches nothing. Cannot be declared. */
export const QUARANTINE = 'quarantine'

interface InboxBase {
  readonly name: string
  /**
   * Built-in inboxes are not reachable by address — nothing should be able to
   * post to `quarantine@` directly. Not settable through the constructors.
   */
  readonly system?: true
}

export interface TeamInbox extends InboxBase {
  readonly kind: 'team'
}

export interface MemberInbox extends InboxBase {
  readonly kind: 'member'
  /**
   * External address of the person behind this inbox — external meaning not
   * handled by this worker. Intended for account recovery, notifications and
   * login codes: things sent to a person. Nothing reads it yet.
   */
  readonly owner?: string
}

export type InboxDef = TeamInbox | MemberInbox

/**
 * Channels are internal. Not exported as an extension point: designing one
 * with no external implementation is how you get it wrong, and the shape is
 * still missing pieces a webhook channel needs — returning a challenge
 * response, for one.
 */
export interface EmailChannel {
  readonly id: 'email'
  /** Primary domain, lowercased. */
  readonly domain: string
  /** Alias domains sharing one inbox space, lowercased. */
  readonly aliases: readonly string[]
}

export type Channel = EmailChannel

export interface InboxConfig {
  readonly inboxes: Readonly<Record<string, InboxDef>>
  readonly channels: readonly Channel[]
}

export interface ResolvedConfig {
  /** Declared inboxes plus the built-in quarantine. */
  readonly inboxes: ReadonlyMap<string, InboxDef>
  readonly channels: readonly Channel[]
  /**
   * Legal but probably-wrong configuration. Surfaced rather than logged: a
   * library writing to the console is a nuisance, and the handler can decide
   * once, at startup.
   */
  readonly warnings: readonly string[]
}
