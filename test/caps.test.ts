import { describe, expect, test } from 'vitest'
import { applyCaps, DEFAULT_CAPS, type IngestCaps } from '../src/caps'
import type { Attachment, Inbound, Participant } from '../src/inbound'

const RECEIVED_AT = new Date('2025-01-14T10:00:00Z')

function message(over: Partial<Inbound> = {}): Inbound {
  return {
    channel: 'email',
    target: 'sales@example.org',
    receivedAt: RECEIVED_AT,
    participants: [],
    attachments: [],
    raw: { bytes: new Uint8Array(0), contentType: 'message/rfc822' },
    meta: {},
    ...over,
  }
}

const attachments = (count: number, size = 1): Attachment[] =>
  Array.from({ length: count }, (_, i) => ({
    mimeType: 'application/octet-stream',
    bytes: new Uint8Array(size),
    inline: false,
    filename: `f${i}`,
  }))

const participants = (count: number): Participant[] =>
  Array.from({ length: count }, (_, i) => ({
    role: 'to' as const,
    identifier: `p${i}@example.com`,
  }))

const refs = (count: number) =>
  Array.from({ length: count }, (_, i) => `r${i}@example.com`)

/** Small caps make the arithmetic in each test readable. */
const caps = (over: Partial<IngestCaps> = {}): IngestCaps => ({
  ...DEFAULT_CAPS,
  ...over,
})

describe('the defaults match the decided table', () => {
  test('§5 ingest caps', () => {
    // Pinned so a later "let's raise this a bit" is a visible decision rather
    // than a one-character diff. Each of these is a limit somewhere real:
    // D1 rows and queries, R2 puts, D1 bound parameters.
    expect(DEFAULT_CAPS).toEqual({
      attachments: 50,
      attachmentBytes: 20 * 1024 * 1024,
      participants: 200,
      references: 20,
      depth: 20,
      headerBytes: 256 * 1024,
    })
  })
})

describe('nothing to do', () => {
  test('a message inside every cap is unchanged and reports nothing', () => {
    const msg = message({
      attachments: attachments(3),
      participants: participants(3),
      meta: { references: refs(3) },
    })
    const { message: out, overflows } = applyCaps(msg, caps())

    expect(overflows).toEqual([])
    expect(out.attachments).toHaveLength(3)
    expect(out.participants).toHaveLength(3)
    expect(out.meta.references).toEqual(refs(3))
  })

  test('exactly at the limit does not count as overflow', () => {
    // The off-by-one that would otherwise be found by a user with exactly 50
    // attachments wondering why one went missing.
    const msg = message({ attachments: attachments(5) })
    const { overflows, message: out } = applyCaps(msg, caps({ attachments: 5 }))

    expect(overflows).toEqual([])
    expect(out.attachments).toHaveLength(5)
  })

  test('the input is not mutated', () => {
    // The caller still holds the original for the dead-letter record.
    const msg = message({ attachments: attachments(5) })
    applyCaps(msg, caps({ attachments: 2 }))
    expect(msg.attachments).toHaveLength(5)
  })
})

describe('attachment count', () => {
  test('keeps the first n and records what was dropped', () => {
    const msg = message({ attachments: attachments(10) })
    const { message: out, overflows } = applyCaps(msg, caps({ attachments: 4 }))

    expect(out.attachments).toHaveLength(4)
    expect(out.attachments.map((a) => a.filename)).toEqual([
      'f0',
      'f1',
      'f2',
      'f3',
    ])
    expect(overflows).toContainEqual({
      cap: 'attachments',
      limit: 4,
      found: 10,
      dropped: 6,
    })
  })

  test('ten thousand tiny parts do not become ten thousand rows', () => {
    // The reason this cap exists. Past D1's 1,000-queries-per-invocation limit
    // the whole ingest aborts — and since a crafted message fails identically
    // on every retry, it could never be delivered at all.
    const msg = message({ attachments: attachments(10_000) })
    const { message: out } = applyCaps(msg)
    expect(out.attachments).toHaveLength(50)
  })
})

describe('attachment bytes', () => {
  test('stops at the first attachment that does not fit', () => {
    // Deliberately not a greedy best-fit: skipping a large attachment to
    // squeeze in smaller later ones would silently pick survivors by size.
    // A prefix is something you can explain to whoever sees the truncation.
    const msg = message({
      attachments: [
        ...attachments(1, 40),
        ...attachments(1, 40),
        ...attachments(1, 500), // does not fit
        ...attachments(1, 10), // would fit, but comes after
      ],
    })
    const { message: out, overflows } = applyCaps(
      msg,
      caps({ attachmentBytes: 100 }),
    )

    expect(out.attachments).toHaveLength(2)
    expect(overflows).toContainEqual({
      cap: 'attachmentBytes',
      limit: 100,
      found: 590,
      dropped: 2,
    })
  })

  test('a single attachment larger than the whole budget keeps none', () => {
    const msg = message({ attachments: attachments(1, 500) })
    const { message: out, overflows } = applyCaps(
      msg,
      caps({ attachmentBytes: 100 }),
    )

    expect(out.attachments).toEqual([])
    expect(overflows).toContainEqual({
      cap: 'attachmentBytes',
      limit: 100,
      found: 500,
      dropped: 1,
    })
  })

  test('the count cap runs first, so bytes are measured on what survived it', () => {
    // Order matters: measuring bytes across all 10 and then trimming to 2
    // would report a byte overflow that the count cap had already prevented.
    const msg = message({ attachments: attachments(10, 10) })
    const { message: out, overflows } = applyCaps(
      msg,
      caps({ attachments: 2, attachmentBytes: 1000 }),
    )

    expect(out.attachments).toHaveLength(2)
    expect(overflows.map((o) => o.cap)).toEqual(['attachments'])
  })
})

describe('participants', () => {
  test('keeps the first n', () => {
    const msg = message({ participants: participants(300) })
    const { message: out, overflows } = applyCaps(msg)

    expect(out.participants).toHaveLength(200)
    expect(overflows).toContainEqual({
      cap: 'participants',
      limit: 200,
      found: 300,
      dropped: 100,
    })
  })
})

describe('references keep the tail, not the head', () => {
  test('the last n survive', () => {
    // The exception to every other cap here, and the one worth getting right.
    // `References` runs oldest to newest, so the tail is the near ancestry a
    // reply actually threads against. Keeping the head would break threading
    // on precisely the long chains the cap exists for.
    const msg = message({ meta: { references: refs(30) } })
    const { message: out, overflows } = applyCaps(msg, caps({ references: 3 }))

    expect(out.meta.references).toEqual([
      'r27@example.com',
      'r28@example.com',
      'r29@example.com',
    ])
    expect(overflows).toContainEqual({
      cap: 'references',
      limit: 3,
      found: 30,
      dropped: 27,
    })
  })

  test('other meta keys survive the trim', () => {
    const msg = message({
      meta: { references: refs(30), inReplyTo: 'x@example.com' },
    })
    const { message: out } = applyCaps(msg, caps({ references: 2 }))
    expect(out.meta.inReplyTo).toBe('x@example.com')
  })

  test('a channel with no references in meta is untouched', () => {
    // Provider-keyed channels never populate it. Reaching into `meta` must not
    // mean assuming every channel looks like email.
    const msg = message({ meta: { conversationKey: 'wa-123' } })
    const { message: out, overflows } = applyCaps(msg)

    expect(out.meta).toEqual({ conversationKey: 'wa-123' })
    expect(overflows).toEqual([])
  })
})

describe('several caps at once', () => {
  test('each overflow is reported separately', () => {
    // The dead-letter record has to say which limits were hit, not merely that
    // something was truncated.
    const msg = message({
      attachments: attachments(10),
      participants: participants(10),
      meta: { references: refs(10) },
    })
    const { overflows } = applyCaps(
      msg,
      caps({ attachments: 1, participants: 2, references: 3 }),
    )

    expect(overflows.map((o) => o.cap).sort()).toEqual([
      'attachments',
      'participants',
      'references',
    ])
  })
})
