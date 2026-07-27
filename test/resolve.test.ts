import { describe, expect, test } from 'vitest'
import { Email, Member, QUARANTINE, resolveConfig, Team } from '../src/config'
import { resolveTarget } from '../src/resolve'

const config = resolveConfig({
  inboxes: {
    sales: Team('Sales'),
    support: Team('Support'),
    darwin: Member('Darwin'),
  },
  channels: [
    Email({ domain: 'mycompany.com', aliases: ['mycompanyservice.com'] }),
  ],
})

describe('matching', () => {
  test('a local part reaches the inbox of the same name', () => {
    expect(resolveTarget(config, 'sales@mycompany.com')).toEqual({
      status: 'matched',
      inboxKey: 'sales',
      target: 'sales@mycompany.com',
    })
  })

  test('an alias domain reaches the same inbox space', () => {
    // Aliases share one inbox space, which is why conversations need no
    // canonicalisation before threading.
    expect(resolveTarget(config, 'sales@mycompanyservice.com')).toMatchObject({
      status: 'matched',
      inboxKey: 'sales',
    })
  })

  test('matching is case-insensitive', () => {
    expect(resolveTarget(config, 'Sales@MyCompany.COM')).toMatchObject({
      status: 'matched',
      inboxKey: 'sales',
    })
  })

  test('the envelope address is preserved as received', () => {
    // Stored on the message: it is the only record of which address caused
    // this delivery, and it is frequently absent from To and Cc.
    expect(resolveTarget(config, 'Sales@MyCompany.COM').target).toBe(
      'Sales@MyCompany.COM',
    )
  })

  test('a member inbox resolves like any other', () => {
    expect(resolveTarget(config, 'darwin@mycompany.com')).toMatchObject({
      inboxKey: 'darwin',
    })
  })
})

describe('plus-addressing', () => {
  test('routes to the base inbox and keeps the tag', () => {
    expect(resolveTarget(config, 'support+acme@mycompany.com')).toEqual({
      status: 'matched',
      inboxKey: 'support',
      target: 'support+acme@mycompany.com',
      tag: 'acme',
    })
  })

  test('tag case is preserved while the inbox match is not', () => {
    // The tag may carry an external identifier; the local part is identity.
    expect(
      resolveTarget(config, 'Support+INV-2024@mycompany.com'),
    ).toMatchObject({ inboxKey: 'support', tag: 'INV-2024' })
  })

  test('no tag means no tag key at all', () => {
    const r = resolveTarget(config, 'support@mycompany.com')
    expect('tag' in r).toBe(false)
  })
})

describe('fallback', () => {
  test('an unknown local part goes to quarantine, not a reject', () => {
    // Never lose a message, and do not leak which addresses exist.
    expect(resolveTarget(config, 'nobody@mycompany.com')).toEqual({
      status: 'fallback',
      inboxKey: QUARANTINE,
      target: 'nobody@mycompany.com',
      reason: 'unknown-address',
    })
  })

  test('quarantine is not reachable by address', () => {
    // It is a system inbox. Mail addressed to quarantine@ must land there by
    // falling back, never by matching, or anyone could post to it directly.
    expect(resolveTarget(config, 'quarantine@mycompany.com')).toMatchObject({
      status: 'fallback',
      reason: 'unknown-address',
    })
  })

  test('an unparseable address goes to quarantine rather than being rejected', () => {
    // Rejecting is permanent (§7.4). If we cannot read the recipient we still
    // must not lose the message.
    expect(resolveTarget(config, 'not-an-address')).toMatchObject({
      status: 'fallback',
      inboxKey: QUARANTINE,
      reason: 'unparseable-address',
    })
  })
})

describe('rejection', () => {
  test('an undeclared domain is rejected, not quarantined', () => {
    // Mail for a domain we never declared means Cloudflare is misconfigured.
    // Quarantining it silently would hide that; this is the one legitimate
    // pre-storage rejection.
    expect(resolveTarget(config, 'sales@somewhere-else.com')).toEqual({
      status: 'rejected',
      target: 'sales@somewhere-else.com',
      reason: 'unknown-domain',
    })
  })

  test('an undeclared domain is checked before the local part', () => {
    // Otherwise a misconfigured zone looks like ordinary unknown-address
    // traffic and nobody notices.
    expect(resolveTarget(config, 'nobody@somewhere-else.com')).toMatchObject({
      status: 'rejected',
      reason: 'unknown-domain',
    })
  })
})

describe('multiple channels', () => {
  const multi = resolveConfig({
    inboxes: { sales: Team('Sales') },
    channels: [Email({ domain: 'a.com' }), Email({ domain: 'b.com' })],
  })

  test('a domain on any channel resolves', () => {
    expect(resolveTarget(multi, 'sales@b.com')).toMatchObject({
      status: 'matched',
      inboxKey: 'sales',
    })
  })
})
