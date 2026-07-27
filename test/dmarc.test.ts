/**
 * The DMARC gate (§8).
 *
 * This is the one place in the system where authentication is *enforced*
 * rather than recorded: only a passing message may seed a `conversation_index`
 * row for an id nobody has received. Getting it wrong does not fail loudly —
 * it opens thread hijacking to anyone who can send mail — so the tests here
 * are mostly about what must **not** be believed.
 */

import { describe, expect, test } from 'vitest'
import { dmarcPassed } from '../src/dmarc'
import { mail } from './fixtures/email'

const EDGE = 'mx.cloudflare.net'

const edgeResult = (result: string) =>
  `Authentication-Results: ${EDGE}; spf=pass smtp.mailfrom=example.com; dkim=pass header.d=example.com; dmarc=${result} header.from=example.com`

describe('the edge result', () => {
  test('opens the gate when it says pass', () => {
    const raw = mail([
      edgeResult('pass'),
      'From: ada@example.com',
      'To: sales@example.org',
    ])

    expect(dmarcPassed(raw, EDGE)).toBe(true)
  })

  test('keeps the gate shut when it says fail', () => {
    const raw = mail([
      edgeResult('fail'),
      'From: ada@example.com',
      'To: sales@example.org',
    ])

    expect(dmarcPassed(raw, EDGE)).toBe(false)
  })

  test('is read across a folded header, not just its first line', () => {
    // Long `Authentication-Results` values fold, and the interesting result is
    // routinely on a continuation line. Reading one line would silently
    // downgrade every authenticated message from a verbose edge.
    const raw = mail([
      `Authentication-Results: ${EDGE};\r\n\tspf=pass smtp.mailfrom=example.com;\r\n\tdmarc=pass header.from=example.com`,
      'From: ada@example.com',
      'To: sales@example.org',
    ])

    expect(dmarcPassed(raw, EDGE)).toBe(true)
  })
})

describe('a message with nothing to read', () => {
  test('keeps the gate shut when no edge stamped a result', () => {
    // Fail closed. The cost is a thread that splits; the alternative is
    // treating "we do not know" as "authenticated".
    const raw = mail(['From: ada@example.com', 'To: sales@example.org'])

    expect(dmarcPassed(raw, EDGE)).toBe(false)
  })

  test('reads only the header block, never the body', () => {
    // A body line shaped like a header is not a header. If it were, every
    // quoted reply containing an old `Authentication-Results` would count.
    const raw = mail(
      ['From: ada@example.com', 'To: sales@example.org'],
      `Authentication-Results: ${EDGE}; dmarc=pass\r\n`,
    )

    expect(dmarcPassed(raw, EDGE)).toBe(false)
  })
})

describe('a forged Authentication-Results', () => {
  test('does not open the gate by sitting below the edge result', () => {
    // The attack the gate exists for. `Headers.get()` joins repeated headers
    // into one comma-separated string, so a substring test for `dmarc=pass`
    // finds the sender's copy sitting underneath the edge's genuine `fail` —
    // and opens the gate for precisely the messages it is meant to stop.
    const raw = mail([
      edgeResult('fail'),
      'From: mallory@example.com',
      'To: sales@example.org',
      // The sender's own, carrying the edge's authserv-id, because nothing
      // stops them writing it. Only *position* distinguishes the two, and the
      // edge prepends.
      `Authentication-Results: ${EDGE}; dkim=pass header.d=example.com; dmarc=pass header.from=example.com`,
      'Subject: Trust me',
    ])

    expect(dmarcPassed(raw, EDGE)).toBe(false)
  })

  test('does not open the gate when no edge result precedes it', () => {
    // Position alone is not enough either: with no edge header the sender's is
    // first. The authserv-id has to be checked as well, and it has to be the
    // one *this deployment* expects rather than any plausible-looking name.
    const raw = mail([
      'Authentication-Results: mallory.example.net; dmarc=pass header.from=example.com',
      'From: mallory@example.com',
      'To: sales@example.org',
    ])

    expect(dmarcPassed(raw, EDGE)).toBe(false)
  })

  test('does not open the gate from inside a property value', () => {
    // `dmarc=pass` has to be a method result, not any occurrence of the
    // string. Every field here is attacker-chosen text.
    const raw = mail([
      `Authentication-Results: ${EDGE}; dkim=fail reason="dmarc=pass" header.d=dmarc=pass; spf=softfail smtp.helo=dmarc=pass`,
      'From: mallory@example.com',
      'To: sales@example.org',
    ])

    expect(dmarcPassed(raw, EDGE)).toBe(false)
  })

  test('does not open the gate by prefixing the expected authserv-id', () => {
    // `mx.cloudflare.net.mallory.example` starts with the id we expect. A
    // prefix match here is a domain anyone can register.
    const raw = mail([
      `Authentication-Results: ${EDGE}.mallory.example; dmarc=pass header.from=example.com`,
      'From: mallory@example.com',
      'To: sales@example.org',
    ])

    expect(dmarcPassed(raw, EDGE)).toBe(false)
  })
})
