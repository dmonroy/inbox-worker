import { describe, expect, test } from 'vitest'
import { Email, Member, Team } from '../src/config'
import { validate } from '../src/validate'
import type { InboxConfig } from '../src/types'

const ok: InboxConfig = {
  inboxes: { sales: Team('Sales') },
  channels: [Email({ domain: 'mycompany.com' })],
}

const withInboxes = (inboxes: InboxConfig['inboxes']): InboxConfig => ({
  ...ok,
  inboxes,
})

const withChannels = (channels: InboxConfig['channels']): InboxConfig => ({
  ...ok,
  channels,
})

/** Assert exactly one error, matching. Keeps tests from passing by accident. */
const oneError = (config: InboxConfig, match: RegExp) => {
  const { errors } = validate(config)
  expect(errors).toHaveLength(1)
  expect(errors[0]).toMatch(match)
}

test('a valid config is clean', () => {
  expect(validate(ok)).toEqual({ errors: [], warnings: [] })
})

describe('inboxes', () => {
  test('at least one is required', () => {
    oneError(withInboxes({}), /No inboxes/)
  })

  test('quarantine is reserved', () => {
    // It is built in and must stay unreachable by address. Letting it be
    // declared would silently make quarantine@ a real address.
    oneError(withInboxes({ quarantine: Team('Mine') }), /built in/)
  })

  test.each([
    ['uppercase', 'Sales'],
    ['a space', 'my inbox'],
    ['a leading hyphen', '-sales'],
    ['a dot', 'sales.eu'],
    ['an at sign', 'sales@'],
    ['empty', ''],
  ])('rejects a key with %s', (_label, key) => {
    // Keys are written to every stored row and appear in addresses.
    oneError(withInboxes({ [key]: Team('X') }), /invalid/)
  })

  test.each(['sales', 'sales-eu', 'sales_eu', 'a', 'team2'])(
    'accepts %s',
    (key) => {
      expect(validate(withInboxes({ [key]: Team('X') })).errors).toEqual([])
    },
  )
})

describe('owner addresses', () => {
  test('an unparseable owner is an error', () => {
    oneError(
      withInboxes({ darwin: Member('Darwin', { owner: 'not-an-address' }) }),
      /unparseable owner/,
    )
  })

  test('an owner on a domain we receive is a warning, not an error', () => {
    // A login code mailed there needs the login code to read. Legal though,
    // so it must not block a deploy.
    const { errors, warnings } = validate(
      withInboxes({ darwin: Member('Darwin', { owner: 'darwin@mycompany.com' }) }),
    )
    expect(errors).toEqual([])
    expect(warnings).toHaveLength(1)
  })

  test('an alias domain counts as ours', () => {
    const config: InboxConfig = {
      inboxes: { darwin: Member('Darwin', { owner: 'd@alias.com' }) },
      channels: [Email({ domain: 'mycompany.com', aliases: ['alias.com'] })],
    }
    expect(validate(config).warnings).toHaveLength(1)
  })

  test('an external owner is clean', () => {
    expect(
      validate(
        withInboxes({ darwin: Member('Darwin', { owner: 'darwin@gmail.com' }) }),
      ),
    ).toEqual({ errors: [], warnings: [] })
  })

  test('a team never triggers owner checks', () => {
    expect(validate(withInboxes({ sales: Team('Sales') })).errors).toEqual([])
  })
})

describe('channels', () => {
  test('at least one is required', () => {
    oneError(withChannels([]), /No channels/)
  })

  test.each([
    ['no dot', 'localhost'],
    ['a trailing hyphen', 'my-.com'],
    ['a space', 'my company.com'],
    ['an empty label', 'a..com'],
  ])('rejects a domain with %s', (_label, domain) => {
    oneError(withChannels([Email({ domain })]), /invalid domain/)
  })

  test('rejects an invalid alias', () => {
    oneError(
      withChannels([Email({ domain: 'ok.com', aliases: ['nope'] })]),
      /invalid alias/,
    )
  })

  test('an alias repeating the primary domain is rejected', () => {
    // Silently deduping would hide a copy-paste mistake in the one place
    // that decides which mail we accept.
    oneError(
      withChannels([Email({ domain: 'ok.com', aliases: ['ok.com'] })]),
      /more than once/,
    )
  })

  test('a duplicated alias is rejected', () => {
    oneError(
      withChannels([Email({ domain: 'ok.com', aliases: ['a.com', 'a.com'] })]),
      /more than once/,
    )
  })

  test('two channels cannot claim the same domain', () => {
    // Which inbox space a message lands in would depend on array order.
    oneError(
      withChannels([Email({ domain: 'ok.com' }), Email({ domain: 'ok.com' })]),
      /claimed by more than one channel/,
    )
  })

  test('separate domains on separate channels are fine', () => {
    expect(
      validate(
        withChannels([Email({ domain: 'a.com' }), Email({ domain: 'b.com' })]),
      ).errors,
    ).toEqual([])
  })
})

test('every problem is reported, not just the first', () => {
  const { errors } = validate({
    inboxes: { Bad: Team('Bad'), quarantine: Team('Q') },
    channels: [],
  })
  expect(errors).toHaveLength(3)
})
