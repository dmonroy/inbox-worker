import { describe, expect, test } from 'vitest'
import {
  CLOUDFLARE_AUTHSERV_ID,
  Email,
  Member,
  QUARANTINE,
  resolveConfig,
  Team,
} from '../src/config'

const channels = [Email({ domain: 'mycompany.com' })]

describe('constructors', () => {
  test('Team has no owner', () => {
    const t = Team('Sales')
    expect(t).toEqual({ kind: 'team', name: 'Sales' })

    // A team is not a person, so there is nobody to send a login code to.
    // This is the payoff of separate constructors over one options type.
    // @ts-expect-error Team takes no options
    Team('Sales', { owner: 'darwin@gmail.com' })

    // @ts-expect-error a team has no owner to read
    t.owner
  })

  test('Member carries an owner when given one', () => {
    expect(Member('Darwin Monroy', { owner: 'darwin@gmail.com' })).toEqual({
      kind: 'member',
      name: 'Darwin Monroy',
      owner: 'darwin@gmail.com',
    })
  })

  test('Member omits the key entirely when there is no owner', () => {
    // Not `owner: undefined`. With exactOptionalPropertyTypes those differ,
    // and an absent key is what "no owner" should serialise as.
    const m = Member('John Doe')
    expect('owner' in m).toBe(false)
  })

  test('Email lowercases and trims domains', () => {
    expect(
      Email({ domain: '  MyCompany.COM ', aliases: ['MyCompanyService.com'] }),
    ).toEqual({
      id: 'email',
      domain: 'mycompany.com',
      aliases: ['mycompanyservice.com'],
      authservId: CLOUDFLARE_AUTHSERV_ID,
    })
  })

  test('Email defaults to no aliases', () => {
    expect(Email({ domain: 'mycompany.com' }).aliases).toEqual([])
  })

  test('Email carries an authserv-id, defaulted rather than optional', () => {
    // The DMARC gate has to name whose `Authentication-Results` it believes
    // (§8), and `undefined` would mean "believe anyone". A default that is
    // wrong for a deployment fails *closed* — threads split — so a default is
    // safe in a way that an absent value is not.
    expect(Email({ domain: 'mycompany.com' }).authservId).toBe(
      CLOUDFLARE_AUTHSERV_ID,
    )
    expect(
      Email({ domain: 'mycompany.com', authservId: '  MX.Example.NET ' })
        .authservId,
    ).toBe('mx.example.net')
  })
})

describe('resolveConfig()', () => {
  test('resolves declared inboxes', () => {
    const config = resolveConfig({
      inboxes: { sales: Team('Sales'), darwin: Member('Darwin') },
      channels,
    })

    expect(config.inboxes.get('sales')).toEqual({ kind: 'team', name: 'Sales' })
    expect(config.inboxes.get('darwin')?.kind).toBe('member')
  })

  test('adds the built-in quarantine inbox', () => {
    const config = resolveConfig({
      inboxes: { sales: Team('Sales') },
      channels,
    })

    expect(config.inboxes.get(QUARANTINE)).toEqual({
      kind: 'team',
      name: 'Quarantine',
      system: true,
    })
  })

  test('quarantine is marked system so it is unreachable by address', () => {
    const config = resolveConfig({
      inboxes: { sales: Team('Sales') },
      channels,
    })
    expect(config.inboxes.get(QUARANTINE)?.system).toBe(true)
    expect(config.inboxes.get('sales')?.system).toBeUndefined()
  })

  test('throws on a broken config, listing every problem at once', () => {
    // A broken config is a developer error at deploy time, so failing loudly
    // is right — unlike a malformed message, which is a routing decision.
    // Reporting all of them beats fixing one typo per deploy.
    expect(() =>
      resolveConfig({
        inboxes: { Sales: Team('Sales'), 'bad key': Team('Bad') },
        channels,
      }),
    ).toThrow(/Sales[\s\S]*bad key/)
  })

  test('returns warnings instead of logging them', () => {
    const config = resolveConfig({
      inboxes: { darwin: Member('Darwin', { owner: 'darwin@mycompany.com' }) },
      channels,
    })

    // Legal, so it must not throw — but almost certainly a mistake.
    expect(config.warnings).toHaveLength(1)
    expect(config.warnings[0]).toContain('darwin')
  })

  test('a clean config produces no warnings', () => {
    const config = resolveConfig({
      inboxes: { darwin: Member('Darwin', { owner: 'darwin@gmail.com' }) },
      channels,
    })
    expect(config.warnings).toEqual([])
  })
})
