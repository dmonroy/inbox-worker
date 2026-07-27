import { describe, expect, test } from 'vitest'
import { stripTraceHeaders } from '../src/trace'

const enc = new TextEncoder()
const dec = new TextDecoder()

/** Round-trip through bytes, because stripping works on bytes, not strings. */
const strip = (raw: string): string =>
  dec.decode(stripTraceHeaders(enc.encode(raw)))

describe('what gets removed', () => {
  test('a Received header', () => {
    const out = strip('Received: from a\r\nSubject: Hi\r\n\r\nBody\r\n')
    expect(out).toBe('Subject: Hi\r\n\r\nBody\r\n')
  })

  test('every Received header, not just the first', () => {
    // A message collects one per hop, and the count differs per delivery.
    const out = strip(
      'Received: from a\r\nReceived: from b\r\nSubject: Hi\r\n\r\nBody',
    )
    expect(out).toBe('Subject: Hi\r\n\r\nBody')
  })

  test.each([
    'Delivered-To: sales@x.com',
    'Return-Path: <bounce@x.com>',
    'Authentication-Results: mx.cloudflare.com; spf=pass',
    'ARC-Seal: i=1; a=rsa-sha256',
    'ARC-Message-Signature: i=1',
    'ARC-Authentication-Results: i=1; spf=pass',
    'X-Received: by 2002:a05',
    'Received-SPF: pass',
  ])('%s', (header) => {
    expect(strip(`${header}\r\nSubject: Hi\r\n\r\nBody`)).toBe(
      'Subject: Hi\r\n\r\nBody',
    )
  })

  test('the folded continuation lines of a stripped header', () => {
    // Received headers are almost always folded across several lines. Dropping
    // the first line and keeping the rest would corrupt the message.
    const out = strip(
      'Received: from a\r\n\tby b\r\n\tid 123\r\nSubject: Hi\r\n\r\nBody',
    )
    expect(out).toBe('Subject: Hi\r\n\r\nBody')
  })

  test('matching is case-insensitive', () => {
    expect(strip('RECEIVED: from a\r\nSubject: Hi\r\n\r\nB')).toBe(
      'Subject: Hi\r\n\r\nB',
    )
  })
})

describe('what survives', () => {
  test('ordinary headers, in order', () => {
    const raw = 'From: a@x.com\r\nSubject: Hi\r\nTo: b@y.com\r\n\r\nBody'
    expect(strip(raw)).toBe(raw)
  })

  test('the folded continuation lines of a kept header', () => {
    const raw = 'Subject: a very\r\n long subject\r\nFrom: a@x.com\r\n\r\nBody'
    expect(strip(raw)).toBe(raw)
  })

  test('a header whose name merely starts with a trace name', () => {
    // Exact name match. `Received-SPF` is trace and listed explicitly;
    // an unrelated `Receivedish` must not be caught by a prefix test.
    const raw = 'Receivedish: keep me\r\nSubject: Hi\r\n\r\nBody'
    expect(strip(raw)).toBe(raw)
  })

  test('the body, byte for byte, including header-looking lines', () => {
    const raw = 'Subject: Hi\r\n\r\nReceived: this is body text\r\nnot a header'
    expect(strip(raw)).toBe(raw)
  })

  test('non-ASCII bytes in the body', () => {
    // Stripping is byte-level precisely so the body is never re-encoded.
    const raw = enc.encode('Received: x\r\nSubject: Hi\r\n\r\n')
    const body = new Uint8Array([0xff, 0xfe, 0x00, 0x42])
    const input = new Uint8Array(raw.length + body.length)
    input.set(raw)
    input.set(body, raw.length)

    const out = stripTraceHeaders(input)
    expect(out.slice(out.length - body.length)).toEqual(body)
  })
})

describe('line endings and shape', () => {
  test('LF-only messages', () => {
    expect(strip('Received: from a\nSubject: Hi\n\nBody')).toBe(
      'Subject: Hi\n\nBody',
    )
  })

  test('a message with headers but no body', () => {
    expect(strip('Received: from a\r\nSubject: Hi\r\n\r\n')).toBe(
      'Subject: Hi\r\n\r\n',
    )
  })

  test('a message with no blank line at all', () => {
    // Malformed, but it arrives. Treat it all as headers rather than throwing.
    expect(strip('Received: from a\r\nSubject: Hi')).toBe('Subject: Hi')
  })

  test('empty input', () => {
    expect(strip('')).toBe('')
  })

  test('a message that is only trace headers', () => {
    expect(strip('Received: from a\r\n\r\nBody')).toBe('\r\nBody')
  })
})
