/**
 * The two caps the parser enforces itself.
 *
 * Separate from `caps.test.ts` because they behave the opposite way: everything
 * in `applyCaps` truncates and records, while these **throw**. That is not an
 * inconsistency. They are the only caps that act before decoding, and a
 * message too deep or too header-heavy to parse has no truncated form to keep
 * — the handler dead-letters it with the raw bytes intact (§7.4).
 */

import { describe, expect, test } from 'vitest'
import { DEFAULT_CAPS } from '../src/caps'
import { parseEmail } from '../src/mime'

const enc = new TextEncoder()
const RECEIVED_AT = new Date('2025-01-14T10:00:00Z')

const parse = (raw: Uint8Array) =>
  parseEmail(raw, { target: 'sales@example.org', receivedAt: RECEIVED_AT })

/** A message nested `n` levels deep in `multipart/mixed`. */
function nested(n: number): Uint8Array {
  let body = 'Content-Type: text/plain\r\n\r\ndeep\r\n'
  for (let i = n; i >= 1; i--) {
    body =
      `Content-Type: multipart/mixed; boundary="b${i}"\r\n\r\n` +
      `--b${i}\r\n${body}--b${i}--\r\n`
  }
  return enc.encode(`From: ada@example.com\r\nSubject: deep\r\n${body}`)
}

describe('MIME nesting depth', () => {
  test('a message within the depth cap parses', async () => {
    const msg = await parse(nested(DEFAULT_CAPS.depth - 2))
    expect(msg.text?.trim()).toBe('deep')
  })

  test('a message past the depth cap throws', async () => {
    // postal-mime's own default is 256 levels, so without setting this the
    // cap does not exist. Recursion is the cost, and the depth is free for a
    // sender to choose.
    await expect(parse(nested(DEFAULT_CAPS.depth + 10))).rejects.toThrow(
      /nesting depth/i,
    )
  })
})

describe('header block size', () => {
  test('a message past the header cap throws', async () => {
    // postal-mime's own default is 2 MB of headers.
    const pad = 'a'.repeat(DEFAULT_CAPS.headerBytes + 1000)
    const raw = enc.encode(
      `From: ada@example.com\r\nX-Pad: ${pad}\r\nSubject: hi\r\n\r\nbody`,
    )
    await expect(parse(raw)).rejects.toThrow(/header size/i)
  })

  test('a long but ordinary header block parses', async () => {
    // A real thread carries a long References chain beside several DKIM
    // signatures. The cap has to clear that comfortably or it fires on
    // legitimate mail.
    const chain = Array.from(
      { length: 200 },
      (_, i) => `<ref-${i}@example.com>`,
    ).join(' ')
    const raw = enc.encode(
      `From: ada@example.com\r\nReferences: ${chain}\r\nSubject: hi\r\n\r\nbody`,
    )
    const msg = await parse(raw)
    expect(msg.subject).toBe('hi')
  })
})
