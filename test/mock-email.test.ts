/**
 * `mockEmailMessage()` is the harness half that needs no bindings, so it is a
 * unit test. What it has to get right is the two places the real
 * `ForwardableEmailMessage` is surprising — the single-use raw stream (§4.1)
 * and the envelope/header split that fan-out depends on (§4).
 */

import { describe, expect, test } from 'vitest'
import { mockEmailMessage } from '../src/testing'

const decoder = new TextDecoder()

/** Exactly how the ingest path reads it (§4.1), so the test reads it the same. */
const readRaw = async (msg: ForwardableEmailMessage): Promise<string> =>
  decoder.decode(await new Response(msg.raw).arrayBuffer())

describe('the raw stream', () => {
  test('is single-use, like the real one', async () => {
    // The mock hands out one stream instance rather than building a fresh one
    // per access. A mock that allowed two reads would hide the exact bug §4.1
    // exists to prevent: stream to R2 first and the parser gets nothing, so
    // you end up with a perfect .eml beside a row with no subject and no body.
    const msg = mockEmailMessage({ raw: 'hello' })

    expect(await readRaw(msg)).toBe('hello')
    await expect(readRaw(msg)).rejects.toThrow()
  })

  test('carries the bytes it was given, unaltered', async () => {
    // Fixtures are wire bytes with CRLF line endings; a mock that normalised
    // them would quietly make every parser test easier than reality.
    const wire = 'Subject: x\r\n\r\nbody\r\n'
    expect(await readRaw(mockEmailMessage({ raw: wire }))).toBe(wire)
  })

  test('rawSize is the length of those bytes', () => {
    // The input to the ingest caps (§5). If it could be set independently of
    // `raw`, a cap test would be asserting against a number nobody produced.
    const raw = new TextEncoder().encode('12345678')
    expect(mockEmailMessage({ raw }).rawSize).toBe(8)
  })
})

describe('the envelope', () => {
  test('is not read from the message headers', () => {
    // `message.to` is a single *envelope* recipient. One email addressed to
    // sales@ and billing@ arrives as two invocations with identical bytes
    // (§4), and that fan-out is untestable if the mock derives `to` from the
    // `To:` header instead of taking it as its own input.
    const msg = mockEmailMessage({
      to: 'billing@example.org',
      raw: 'To: sales@example.org\r\n\r\nhi\r\n',
    })

    expect(msg.to).toBe('billing@example.org')
  })
})

describe('headers', () => {
  test('come from the raw message', async () => {
    // Otherwise a test could assert on a Message-ID that is nowhere in the
    // bytes the parser sees, and pass while the two disagree.
    const msg = mockEmailMessage({
      raw: 'Message-ID: <a@example.com>\r\nSubject: Quote\r\n\r\nhi\r\n',
    })

    expect(msg.headers.get('message-id')).toBe('<a@example.com>')
    expect(msg.headers.get('Subject')).toBe('Quote')
  })

  test('are unfolded, so a wrapped value reads as one value', () => {
    // Long References chains arrive folded across continuation lines. Reading
    // only the first line is the classic threading bug (§8).
    const msg = mockEmailMessage({
      raw: 'References: <a@example.com>\r\n <b@example.com>\r\n\r\nhi\r\n',
    })

    expect(msg.headers.get('references')).toBe(
      '<a@example.com> <b@example.com>',
    )
  })

  test('stop at the blank line', () => {
    // A body line shaped like a header is not a header. Treating it as one is
    // how a hostile sender injects whatever it likes.
    const msg = mockEmailMessage({
      raw: 'Subject: real\r\n\r\nX-Injected: yes\r\n',
    })

    expect(msg.headers.get('x-injected')).toBeNull()
  })

  test('explicit ones override what the bytes carry', () => {
    // So a test can vary one header without rebuilding a fixture.
    const msg = mockEmailMessage({
      raw: 'Subject: from bytes\r\n\r\nhi\r\n',
      headers: { Subject: 'from opts', 'X-Extra': '1' },
    })

    expect(msg.headers.get('subject')).toBe('from opts')
    expect(msg.headers.get('x-extra')).toBe('1')
  })
})

describe('the reply surface', () => {
  test('is inert rather than throwing', async () => {
    // The ingest path must never throw once the bytes are in R2 (§7.4). A
    // harness whose setReject() blew up would make that rule untestable, and
    // would fail the tests of any consumer who handles a message correctly.
    const msg = mockEmailMessage()

    expect(() => msg.setReject('no')).not.toThrow()
    await expect(msg.forward('someone@example.org')).resolves.toBeDefined()
    await expect(
      msg.reply({ from: 'a@example.org', to: 'b@example.com' }),
    ).resolves.toBeDefined()
  })
})
