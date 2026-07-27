import { describe, expect, test } from 'vitest'
import {
  DEFAULT_BINDING,
  type Exec,
  parseArgs,
  parseVersion,
  plan,
  runMigrate,
  wranglerArgs,
} from '../src/cli'
import {
  CODE_SCHEMA_VERSION,
  META_STATEMENT,
  type Migration,
  versionStatement,
} from '../src/migrations'

const opts = (over = {}) => ({
  command: 'migrate' as const,
  mode: 'local' as const,
  binding: DEFAULT_BINDING,
  ...over,
})

describe('argument parsing', () => {
  test('the target must be named explicitly', () => {
    // No default. Defaulting to local makes a production migration silently do
    // nothing; defaulting to remote makes a careless run touch production.
    // Neither is a mistake worth being convenient about, and the npm scripts
    // supply the flag anyway.
    expect(() => parseArgs(['migrate'])).toThrow(/--local|--remote/)
  })

  test('local and remote together is an error, not a precedence rule', () => {
    // A precedence rule here would be a coin flip over which database gets
    // migrated. Asserting the message, not merely that something threw — a
    // bare `.toThrow()` is satisfied by any stub.
    expect(() => parseArgs(['migrate', '--local', '--remote'])).toThrow(/both/i)
  })

  test.each(['local', 'remote'] as const)('--%s', (mode) => {
    expect(parseArgs(['migrate', `--${mode}`]).mode).toBe(mode)
  })

  test('the binding defaults to the convention', () => {
    // §2.7: bindings are resolved by name. wrangler looks the name up in the
    // consumer's own config, so the CLI never parses wrangler.toml itself.
    expect(parseArgs(['migrate', '--local']).binding).toBe('INBOX_DB')
  })

  test('the binding can be overridden', () => {
    const o = parseArgs(['migrate', '--local', '--binding', 'MY_DB'])
    expect(o.binding).toBe('MY_DB')
  })

  test('a flag expecting a value rejects a missing one', () => {
    expect(() => parseArgs(['migrate', '--local', '--binding'])).toThrow(
      /--binding/,
    )
  })

  test('an unknown command names what is available', () => {
    // The error a typo produces should be the one that fixes the typo.
    expect(() => parseArgs(['migrant', '--local'])).toThrow(/migrate/)
  })

  test('an unknown flag is rejected rather than ignored', () => {
    // Silently ignoring `--dry-run` would run the migration for real.
    expect(() => parseArgs(['migrate', '--local', '--dry-run'])).toThrow(
      /--dry-run/,
    )
  })

  test('no command at all prints usage', () => {
    expect(() => parseArgs([])).toThrow(/usage/i)
  })
})

describe('the wrangler invocation', () => {
  test('passes SQL as one argument, never as shell text', () => {
    // The whole reason this spawns an argv rather than building a command
    // string: every statement contains quotes and parentheses, and a message
    // could not be trusted to stay inside them.
    const sql = `INSERT INTO t (k) VALUES ('it''s')`
    const args = wranglerArgs(sql, opts())

    expect(args).toContain(sql)
    // Exactly one element is the SQL — nothing split it.
    expect(args.filter((a) => a === sql)).toHaveLength(1)
  })

  test('names the binding and the mode', () => {
    expect(wranglerArgs('SELECT 1', opts({ binding: 'MY_DB' }))).toEqual([
      'd1',
      'execute',
      'MY_DB',
      '--command',
      'SELECT 1',
      '--json',
      '--local',
    ])
  })

  test('remote is passed through as --remote', () => {
    expect(wranglerArgs('SELECT 1', opts({ mode: 'remote' }))).toContain(
      '--remote',
    )
  })

  test('a config path is passed through', () => {
    const args = wranglerArgs('SELECT 1', opts({ config: './w.toml' }))
    expect(args.slice(args.indexOf('-c'))).toEqual(['-c', './w.toml'])
  })
})

describe('reading the current version', () => {
  test('parses a version out of a successful result', () => {
    // Measured shape, not guessed: wrangler --json wraps results in an array.
    const stdout = JSON.stringify([
      { results: [{ value: '3' }], success: true, meta: { duration: 0 } },
    ])
    expect(parseVersion(stdout)).toBe(3)
  })

  test('an empty result set is version 0', () => {
    const stdout = JSON.stringify([
      { results: [], success: true, meta: { duration: 0 } },
    ])
    expect(parseVersion(stdout)).toBe(0)
  })

  test('a missing table is version 0, not a crash', () => {
    // The shape wrangler emits on failure is an object, not an array — and
    // this is the ordinary state of a database nobody has migrated yet.
    const stdout = JSON.stringify({
      error: { text: 'no such table: _inbox_meta: SQLITE_ERROR' },
    })
    expect(parseVersion(stdout)).toBe(0)
  })

  test('unparseable output is version 0 rather than an exception', () => {
    // wrangler prints update notices and warnings around its JSON. Treating
    // noise as "unmigrated" is safe: every statement is idempotent, so the
    // worst case is re-running work that was already done.
    expect(parseVersion('Update available 4.0.0 -> 4.1.0')).toBe(0)
  })
})

describe('planning what to run', () => {
  const m = (version: number): Migration => ({
    version,
    name: `m${version}`,
    statements: [`CREATE TABLE IF NOT EXISTS t${version} (x TEXT)`],
  })

  test('the meta table is created before anything else', () => {
    // It holds the version, so it cannot be inside the thing it versions.
    const [first] = plan(0, [m(1)])
    expect(first?.statements[0]).toBe(META_STATEMENT)
  })

  test('the version write is last', () => {
    // The property that makes a half-applied migration repairable: the CLI has
    // no transaction across statements, so if it dies partway the version was
    // never recorded and re-running finishes the job.
    const [first] = plan(0, [m(1)])
    expect(first?.statements.at(-1)).toBe(versionStatement(1))
  })

  test('already-applied migrations are skipped', () => {
    expect(plan(2, [m(1), m(2), m(3)]).map((p) => p.version)).toEqual([3])
  })

  test('nothing pending plans nothing', () => {
    expect(plan(3, [m(1), m(2), m(3)])).toEqual([])
  })

  test('migrations are ordered by version, not array position', () => {
    expect(plan(0, [m(3), m(1), m(2)]).map((p) => p.version)).toEqual([1, 2, 3])
  })

  test('every planned migration carries its own version write', () => {
    // Not one write at the end. A run that dies after migration 2 must leave
    // the version at 2, so the retry starts from 3 rather than redoing both.
    const planned = plan(0, [m(1), m(2)])
    expect(planned[0]?.statements.at(-1)).toBe(versionStatement(1))
    expect(planned[1]?.statements.at(-1)).toBe(versionStatement(2))
  })
})

describe('running the migration', () => {
  /**
   * A fake wrangler. Records every SQL statement it was asked to run, answers
   * the version probe with `version`, and fails on whichever statement matches
   * `failOn`.
   */
  function fakeWrangler({
    version = 0,
    failOn,
  }: {
    version?: number
    failOn?: RegExp
  } = {}) {
    const ran: string[] = []
    const exec: Exec = async (args) => {
      const sql = args[args.indexOf('--command') + 1] as string

      if (sql.includes('SELECT value FROM _inbox_meta')) {
        return {
          code: 0,
          stderr: '',
          stdout: JSON.stringify([
            {
              results: version > 0 ? [{ value: String(version) }] : [],
              success: true,
            },
          ]),
        }
      }

      ran.push(sql)
      return failOn?.test(sql)
        ? { code: 1, stdout: '', stderr: 'D1_ERROR: boom' }
        : { code: 0, stdout: '[]', stderr: '' }
    }
    return { exec, ran }
  }

  const opts = {
    command: 'migrate' as const,
    mode: 'local' as const,
    binding: DEFAULT_BINDING,
  }
  const quiet = () => {}

  test('applies everything and reports success', async () => {
    const { exec, ran } = fakeWrangler()
    const code = await runMigrate(opts, exec, quiet)

    expect(code).toBe(0)
    expect(ran[0]).toBe(META_STATEMENT)
    expect(ran.at(-1)).toBe(versionStatement(CODE_SCHEMA_VERSION))
  })

  test('does nothing when the schema is already current', async () => {
    const { exec, ran } = fakeWrangler({ version: CODE_SCHEMA_VERSION })
    const code = await runMigrate(opts, exec, quiet)

    expect(code).toBe(0)
    expect(ran).toEqual([])
  })

  test('a failure stops immediately and never records the version', async () => {
    // The decision that makes a half-applied migration recoverable. Pressing
    // on would write a version for a schema that was never fully applied, and
    // the next run would skip the missing tables entirely.
    const { exec, ran } = fakeWrangler({
      failOn: /CREATE TABLE IF NOT EXISTS contents/,
    })
    const code = await runMigrate(opts, exec, quiet)

    expect(code).toBe(1)
    expect(ran.some((s) => s.includes('INSERT INTO _inbox_meta'))).toBe(false)
    expect(ran.at(-1)).toMatch(/CREATE TABLE IF NOT EXISTS contents/)
  })

  test('the failure message says re-running is the repair', async () => {
    // Whoever sees this needs to know the database is not wedged.
    const lines: string[] = []
    const { exec } = fakeWrangler({ failOn: /contents/ })
    await runMigrate(opts, exec, (l) => lines.push(l))

    expect(lines.join('\n')).toMatch(/run it again/i)
  })
})
