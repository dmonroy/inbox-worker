/**
 * The whole consumer. This is what using the package looks like.
 *
 * Two lists: who receives (`inboxes`) and how things arrive (`channels`).
 * `inbox()` returns a worker, so exporting it is the deployment.
 *
 * The addresses are `example.*` placeholders — swap them for a zone you own
 * before deploying, and see the README for the two Cloudflare resources this
 * expects to be bound.
 */

import { Email, inbox, Member, Team } from 'inbox-worker'

export default inbox({
  inboxes: {
    // Shared inboxes. `sales@example.com` lands in `sales`, and so does
    // `sales+q3@example.com` — the plus tag is recorded, not routed on.
    sales: Team('Sales'),
    support: Team('Support'),

    // A person. `owner` is the external address that identifies them; it is
    // inert today and must not be on a domain this worker receives, or a
    // future login code would need itself to be readable.
    ada: Member('Ada Lovelace', { owner: 'ada@example.net' }),
  },

  // Phase 1 ships Email only. Aliases share one inbox space, so
  // `support@example.org` reaches the same `support` inbox.
  channels: [Email({ domain: 'example.com', aliases: ['example.org'] })],
})

// Anything addressed to a local part with no inbox — `hello@example.com` —
// goes to the built-in `quarantine` inbox instead of bouncing. Mail for a
// domain no channel declares is refused, because that means a zone is pointed
// here by mistake.
