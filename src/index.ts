/**
 * The package entry point.
 *
 * Deliberately narrow: only what a consumer can actually use today. §2.1
 * sketches a wider surface — `handlers()`, the worker `inbox()` returns —
 * and each piece is added here as it lands, rather than re-exported early
 * against a shape that is still moving.
 *
 * The test harness is **not** here. It lives at `inbox-worker/testing` so that
 * nothing which resets a database is one autocomplete away from production
 * code.
 */

export {
  type Channel,
  Email,
  type EmailChannel,
  type InboxConfig,
  type InboxDef,
  inbox,
  Member,
  type MemberInbox,
  QUARANTINE,
  type ResolvedConfig,
  Team,
  type TeamInbox,
} from './config.js'
// Pure, and exported for the consumer's own tests (§2.1): routing is the one
// decision they will want to assert on without standing up a worker.
export { type Resolution, resolveTarget } from './resolve.js'
