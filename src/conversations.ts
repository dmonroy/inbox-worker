/**
 * Which conversation does this message belong to? (§8)
 *
 * Email carries no conversation id, so one is inferred from the reference
 * graph: `In-Reply-To` and `References` name ids, and `conversation_index`
 * maps every id we have ever seen — including ids only referenced, never
 * received — to a conversation, scoped to one inbox.
 *
 * Runs **before** `storeInbound`, which takes the answer as an input and
 * deliberately refuses to guess it. It also writes the `conversations` row,
 * because `messages.conversation_id` and `conversation_index.conversation_id`
 * are both foreign keys and D1 enforces them (§9.0) — the parent has to exist
 * before storage runs.
 *
 * Three rules make the whole thing safe under a hostile, unordered network:
 *
 * - **Never merge.** A message referencing two conversations joins the
 *   lexicographically smallest and leaves the other alone. `References` is
 *   unauthenticated, so merging is a primitive for splicing one customer's
 *   thread into another's.
 * - **Never seed unauthenticated.** Only a DMARC-passing message may create an
 *   index row for an id nobody has received, or `References: <id-I-expect>` is
 *   a way to claim someone else's future mail.
 * - **Never scale with the thread.** Every step is a fixed, small number of
 *   statements, whatever the size of the conversation being joined.
 */

import { sha256Hex } from './identity.js'
import type { Inbound } from './inbound.js'

const enc = new TextEncoder()

/**
 * How many `References` entries are consulted — the **last** 20 (§8).
 *
 * Its own constant rather than `IngestCaps.references`, which a consumer can
 * raise. That cap is about what the message is allowed to carry; this one is
 * about how many placeholders go into one `IN` list, and the promise that no
 * step here scales with the size of a thread is not a consumer's to revoke.
 */
const REFERENCE_CANDIDATES = 20

export interface ConversationRequest {
  message: Inbound
  inboxKey: string
  /** DMARC passed, for email. Gates index writes for ids never received. */
  verified?: boolean
}

export interface ConversationResult {
  conversationId: string
  /** True when this message started a conversation rather than joining one. */
  created: boolean
}

export async function resolveConversation(
  db: D1Database,
  request: ConversationRequest,
): Promise<ConversationResult> {
  const { message, inboxKey } = request

  // The message's own `Message-ID` is a candidate alongside the ids it points
  // at, which §8 step 2 does not say — but §8 and §9 both promise that seeding
  // an id we have not received lets "a late-arriving parent join instead of
  // forking", and a parent has no references of its own. Without this the
  // literal candidate set is empty for exactly the message the seeding exists
  // to catch, and the seeded row is never read by anything.
  const own = isId(message.externalId) ? message.externalId : undefined
  const referenced = referencedIds(message)
  const candidates = [...new Set([own, ...referenced].filter(isId))]

  const joined = await lookup(db, inboxKey, candidates)
  const conversationId = joined ?? (await newConversationId(request, own))

  const statements: D1PreparedStatement[] = [
    joined === null
      ? insertConversation(db, request, conversationId)
      : touchConversation(db, request, conversationId),
  ]

  // Parent before children: this batch writes a `conversations` row and then
  // `conversation_index` rows that reference it, and D1 evaluates foreign keys
  // statement by statement, failing the *whole* batch on the first violation.
  const claim = statements.length
  if (own !== undefined) {
    statements.push(insertOwnIndex(db, own, inboxKey, conversationId))
  }
  // Ids we have not received are seeded only by an authenticated sender (§8).
  if (request.verified === true) {
    for (const externalId of referenced) {
      if (externalId === own) continue
      statements.push(insertIndex(db, externalId, inboxKey, conversationId))
    }
  }

  // Who won? Between the lookup above and this batch, another isolate may have
  // claimed our own id — there is no lock and no Durable Object (§8), which
  // would impose a binding on every consumer. §8 says to re-read; the `claim`
  // statement's `RETURNING` says the same thing without a second round trip,
  // because on the conflict path it reports the row that was already there
  // rather than the one we tried to write. Measured against local D1.
  const results = await db.batch<{ conversation_id: string }>(statements)
  const settled =
    (own === undefined ? undefined : results[claim]?.results[0])
      ?.conversation_id ?? conversationId

  return {
    conversationId: settled,
    created: joined === null && settled === conversationId,
  }
}

/**
 * `In-Reply-To` ∪ `References` (§8) — the ids this message points *at*.
 *
 * Both are already normalised at parse time — brackets stripped, case
 * preserved — so the form looked up here is the form that was stored.
 *
 * Read defensively rather than cast-and-trust: `meta` is the channel escape
 * hatch, and a custom channel (§3.5) can put anything in it. Ingest never
 * throws, so a malformed entry is skipped, not fatal.
 */
function referencedIds(message: Inbound): string[] {
  const meta = message.meta as { inReplyTo?: unknown; references?: unknown }
  const refs = Array.isArray(meta.references) ? meta.references : []
  const tail = refs.slice(-REFERENCE_CANDIDATES)
  return [...new Set([meta.inReplyTo, ...tail].filter(isId))]
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

/**
 * The lexicographically smallest conversation any candidate reaches, or null.
 *
 * **Smallest, not oldest, and never a merge** (§8). One statement, whatever
 * the candidate count: nothing here may scale with the size of the
 * conversation being joined.
 */
async function lookup(
  db: D1Database,
  inboxKey: string,
  candidates: string[],
): Promise<string | null> {
  if (candidates.length === 0) return null

  const holes = candidates.map(() => '?').join(', ')
  const row = await db
    .prepare(
      `SELECT min(conversation_id) AS id FROM conversation_index
       WHERE inbox_key = ? AND external_id IN (${holes})`,
    )
    .bind(inboxKey, ...candidates)
    .first<{ id: string | null }>()

  return row?.id ?? null
}

/**
 * The id of a conversation this message starts.
 *
 * **Derived, not random**, so that the same message resolving twice — a
 * redelivery, a retry, two isolates racing on the same bytes — proposes the
 * same id and `INSERT OR IGNORE` collapses them into one row instead of
 * leaving an orphan behind. Scoped to the inbox because a conversation belongs
 * to exactly one (§8).
 *
 * With no `Message-ID` there is nothing stable to derive from, so a random one
 * is hashed in instead. A constant would be worse than random: every id-less
 * message in the inbox would land in one shared conversation, which is exactly
 * the "silently grouping strangers' mail" that killed subject fallback. The
 * cost is that redelivering such a message leaves an unreferenced
 * `conversations` row — the same harmless garbage §8 already accepts from a
 * concurrent create.
 */
function newConversationId(
  request: ConversationRequest,
  own: string | undefined,
): Promise<string> {
  const anchor = own ?? crypto.randomUUID()
  return sha256Hex(
    enc.encode(`${request.inboxKey}:${request.message.channel}:${anchor}`),
  )
}

/**
 * `provider_key` is NULL: it belongs to channels that are handed a conversation
 * key by their provider (§8), and inventing one for email would collide with
 * `idx_conv_provider`.
 */
function insertConversation(
  db: D1Database,
  request: ConversationRequest,
  conversationId: string,
): D1PreparedStatement {
  const { message } = request
  const at = message.receivedAt.getTime()

  return db
    .prepare(
      `INSERT OR IGNORE INTO conversations
         (id, inbox_key, channel, provider_key, title, title_norm,
          first_message_at, last_message_at, message_count)
       VALUES (?, ?, ?, NULL, ?, NULL, ?, ?, 0)`,
    )
    .bind(
      conversationId,
      request.inboxKey,
      message.channel,
      message.subject ?? null,
      at,
      at,
    )
}

/**
 * Widen the span of a conversation this message joined.
 *
 * `min`/`max`, never assignment: replay exists, so a message older than
 * everything already in the conversation can arrive after all of it, and
 * `first_message_at = ?` would walk forwards in time.
 *
 * `title` is left alone. It is the opening subject, and letting every reply
 * rewrite it renames the thread to whatever the last client's "Re: Fwd:"
 * mangling happened to produce.
 *
 * `message_count` is not touched either, and cannot be from here: this step
 * does not know whether the `messages` row that follows is new or an ignored
 * redelivery, so incrementing would over-count every retry.
 */
function touchConversation(
  db: D1Database,
  request: ConversationRequest,
  conversationId: string,
): D1PreparedStatement {
  const at = request.message.receivedAt.getTime()

  return db
    .prepare(
      `UPDATE conversations
          SET first_message_at = min(first_message_at, ?),
              last_message_at  = max(last_message_at, ?)
        WHERE id = ?`,
    )
    .bind(at, at, conversationId)
}

/**
 * `INSERT OR IGNORE`, so an id already pointing somewhere keeps pointing there
 * (§8). This is the statement that would merge conversations if it overwrote.
 */
function insertIndex(
  db: D1Database,
  externalId: string,
  inboxKey: string,
  conversationId: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO conversation_index
         (external_id, inbox_key, conversation_id, received)
       VALUES (?, ?, ?, 0)`,
    )
    .bind(externalId, inboxKey, conversationId)
}

/**
 * The message's own id: the row is claimed if free, and otherwise only flipped
 * to `received`.
 *
 * `conversation_id` is deliberately absent from the `DO UPDATE`. This is the
 * one statement in the module that could merge two conversations, and the
 * difference between marking a row and repointing it is the difference between
 * recording what we hold and rewriting somebody else's thread (§8).
 */
function insertOwnIndex(
  db: D1Database,
  externalId: string,
  inboxKey: string,
  conversationId: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO conversation_index
         (external_id, inbox_key, conversation_id, received)
       VALUES (?, ?, ?, 1)
       ON CONFLICT(external_id, inbox_key) DO UPDATE SET received = 1
       RETURNING conversation_id`,
    )
    .bind(externalId, inboxKey, conversationId)
}
