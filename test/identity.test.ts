import { describe, expect, test } from 'vitest'
import { contentId, messageId, sha256Hex } from '../src/identity'
import { stripTraceHeaders } from '../src/trace'

const enc = new TextEncoder()
const bytes = (s: string) => enc.encode(s)

/** How the email channel derives a content id: strip trace, then hash. */
const emailContentId = (raw: string) =>
  contentId('email', stripTraceHeaders(bytes(raw)))

describe('sha256Hex', () => {
  test('returns 64 lowercase hex characters', async () => {
    expect(await sha256Hex(bytes('hello'))).toMatch(/^[0-9a-f]{64}$/)
  })

  test('matches the known digest for a known input', async () => {
    // Pinned against an external value so an accidental change of algorithm
    // or encoding is caught rather than silently self-consistent.
    expect(await sha256Hex(bytes('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  test('differs for different input', async () => {
    expect(await sha256Hex(bytes('a'))).not.toBe(await sha256Hex(bytes('b')))
  })
})

describe('contentId', () => {
  test('is stable for the same channel and bytes', async () => {
    const a = await contentId('email', bytes('same'))
    const b = await contentId('email', bytes('same'))
    expect(a).toBe(b)
  })

  test('separates channels that share an external id', async () => {
    // A provider message id is only unique within its own channel.
    const a = await contentId('email', bytes('same'))
    const b = await contentId('whatsapp', bytes('same'))
    expect(a).not.toBe(b)
  })
})

describe('identity never derives from sender-supplied headers', () => {
  const messageIdHeader = 'Message-ID: <shared@example.com>'

  test('two different messages sharing a Message-ID stay separate', async () => {
    // The failure this prevents: an appliance that emits one Message-ID for
    // every alert would store the first and silently discard the rest, and
    // anyone who knew a Message-ID could overwrite that message's stored
    // bytes. Identity comes from content, so neither is possible.
    const a = await emailContentId(
      `${messageIdHeader}\r\nSubject: Alert 1\r\n\r\nDisk full`,
    )
    const b = await emailContentId(
      `${messageIdHeader}\r\nSubject: Alert 2\r\n\r\nDisk fine`,
    )
    expect(a).not.toBe(b)
  })

  test('the same message delivered twice collapses to one id', async () => {
    const raw = `${messageIdHeader}\r\nSubject: Hi\r\n\r\nBody`
    expect(await emailContentId(raw)).toBe(await emailContentId(raw))
  })

  test('fan-out dedups despite different trace headers', async () => {
    // The two invocations for sales@ and billing@ carry per-delivery trace
    // headers. Stripping them before hashing is what makes one stored copy.
    const sales = await emailContentId(
      'Received: from mx1\r\nDelivered-To: sales@x.com\r\n' +
        'Authentication-Results: mx.cloudflare.com; spf=pass\r\n' +
        `${messageIdHeader}\r\nSubject: Hi\r\n\r\nBody`,
    )
    const billing = await emailContentId(
      'Received: from mx2\r\nDelivered-To: billing@x.com\r\n' +
        'Authentication-Results: mx.cloudflare.com; spf=fail\r\n' +
        `${messageIdHeader}\r\nSubject: Hi\r\n\r\nBody`,
    )
    expect(sales).toBe(billing)
  })

  test('a changed body still breaks the tie, trace headers or not', async () => {
    const a = await emailContentId('Received: x\r\nSubject: Hi\r\n\r\nOne')
    const b = await emailContentId('Received: y\r\nSubject: Hi\r\n\r\nTwo')
    expect(a).not.toBe(b)
  })
})

describe('messageId', () => {
  test('is stable for the same content and inbox', async () => {
    expect(await messageId('abc', 'sales')).toBe(
      await messageId('abc', 'sales'),
    )
  })

  test('differs per inbox, so fan-out produces distinct rows', async () => {
    // One email to sales@ and billing@ is two arrivals of one payload.
    expect(await messageId('abc', 'sales')).not.toBe(
      await messageId('abc', 'billing'),
    )
  })

  test('differs per content, so two messages to one inbox stay separate', async () => {
    expect(await messageId('abc', 'sales')).not.toBe(
      await messageId('def', 'sales'),
    )
  })

  test('the separator cannot be forged across the boundary', async () => {
    // Without a delimiter, ('ab','c') and ('a','bc') would collide. Inbox keys
    // are validated, but content ids should not depend on that holding.
    expect(await messageId('ab', 'c')).not.toBe(await messageId('a', 'bc'))
  })
})
