import { describe, expect, test } from 'vitest'
import { normalizeAddress, parseAddress } from '../src/address'

describe('parseAddress', () => {
  test('lowercases the domain', () => {
    // RFC 5321: domains are case-insensitive. Not folding them is how you get
    // two contacts for one person.
    expect(parseAddress('darwin@Example.COM')?.key).toBe('darwin@example.com')
  })

  test('lowercases the local part', () => {
    // Technically case-sensitive per RFC, but no real deployment treats
    // Darwin@ and darwin@ as different people.
    expect(parseAddress('Darwin@example.com')?.key).toBe('darwin@example.com')
  })

  test('keeps the address as received', () => {
    expect(parseAddress('  Darwin@Example.COM  ')?.raw).toBe(
      'Darwin@Example.COM',
    )
  })

  test('extracts a plus-tag and excludes it from the key', () => {
    const a = parseAddress('support+acme@example.com')
    expect(a?.local).toBe('support')
    expect(a?.tag).toBe('acme')
    expect(a?.key).toBe('support@example.com')
  })

  test('preserves tag case while normalising the rest', () => {
    // The tag is opaque payload — it may be an external id we never compare.
    const a = parseAddress('Support+INV-2024@Example.com')
    expect(a?.tag).toBe('INV-2024')
    expect(a?.key).toBe('support@example.com')
  })

  test('treats everything after the first + as the tag', () => {
    expect(parseAddress('a+b+c@example.com')?.tag).toBe('b+c')
  })

  test('a leading + is part of the local part, not a tag', () => {
    const a = parseAddress('+notify@example.com')
    expect(a?.local).toBe('+notify')
    expect(a?.tag).toBeUndefined()
  })

  test('an empty tag is dropped rather than stored as ""', () => {
    const a = parseAddress('support+@example.com')
    expect(a?.local).toBe('support')
    expect(a?.tag).toBeUndefined()
  })

  test('strips angle brackets and a display name', () => {
    expect(parseAddress('Darwin Monroy <darwin@example.com>')?.key).toBe(
      'darwin@example.com',
    )
  })

  test('splits on the last @, so a quoted local part survives', () => {
    const a = parseAddress('"weird@local"@example.com')
    expect(a?.local).toBe('"weird@local"')
    expect(a?.domain).toBe('example.com')
  })

  test('handles subdomains', () => {
    expect(parseAddress('a@mail.corp.example.com')?.domain).toBe(
      'mail.corp.example.com',
    )
  })

  describe('returns null rather than throwing', () => {
    // Malformed addresses arrive from the network constantly. They are a
    // routing decision, not an exception.
    const bad = [
      ['empty', ''],
      ['whitespace only', '   '],
      ['no @', 'darwin'],
      ['empty local part', '@example.com'],
      ['empty domain', 'darwin@'],
      ['space in domain', 'darwin@exa mple.com'],
      ['comma-separated list', 'a@x.com, b@y.com'],
      ['unclosed bracket', '<darwin@example.com'],
    ] as const

    for (const [name, input] of bad) {
      test(name, () => {
        expect(parseAddress(input)).toBeNull()
      })
    }
  })
})

describe('normalizeAddress', () => {
  test('returns the key', () => {
    expect(normalizeAddress('Support+Acme@Example.com')).toBe(
      'support@example.com',
    )
  })

  test('returns null for unparseable input', () => {
    expect(normalizeAddress('nope')).toBeNull()
  })
})
