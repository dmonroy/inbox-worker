#!/usr/bin/env node
/**
 * `inbox-worker` — the command that applies the schema.
 *
 * Named after the package rather than something shorter: a binary whose name
 * does not appear in `package.json` cannot be traced from an error message
 * back to whatever installed it, and a generic name is a land-grab in a shared
 * global namespace.
 *
 * It shells out to `wrangler d1 execute` rather than talking to the D1 HTTP
 * API, so it inherits the user's existing wrangler auth. No API token to
 * provision and no second credential to leak.
 */

import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import {
  META_STATEMENT,
  MIGRATIONS,
  type Migration,
  versionStatement,
} from './migrations.js'

export type Mode = 'local' | 'remote'

export interface CliOptions {
  command: 'migrate'
  mode: Mode
  /** D1 binding name. Convention (§2.7), overridable for anyone who deviates. */
  binding: string
  /** Passed through to wrangler as `-c`. */
  config?: string
}

export const DEFAULT_BINDING = 'INBOX_DB'

const USAGE = `Usage: inbox-worker migrate (--local | --remote) [--binding NAME] [-c PATH]`

/**
 * Replay is not a subcommand and will not become one.
 *
 * This CLI shells out to `wrangler d1 execute --command`, which takes SQL text
 * and **no bound parameters**. Replaying a message writes a subject, a body, a
 * display name and a filename that a stranger chose into a dozen rows, so a
 * CLI implementation would have to interpolate attacker-controlled bytes into
 * SQL — the thing `src/store.ts` uses `.bind()` everywhere to avoid.
 */
const REPLAY_MOVED =
  `Replay is a cron trigger, not a command. Add one to wrangler.toml:\n\n` +
  `  [triggers]\n` +
  `  crons = ["*/10 * * * *"]\n\n` +
  `The worker drains failed_ingest on its own from there — it needs the D1 ` +
  `and R2 bindings and bound SQL parameters, and this CLI has neither.`

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

export type Exec = (args: string[]) => Promise<ExecResult>

export function parseArgs(argv: readonly string[]): CliOptions {
  const [command, ...rest] = argv
  if (command === undefined) throw new Error(USAGE)
  // Answered by name, because the design document promised this command in
  // three places and whoever types it is holding a dead letter. "Unknown
  // command" would send them hunting for a typo that is not there.
  if (command === 'replay') throw new Error(REPLAY_MOVED)
  if (command !== 'migrate') {
    throw new Error(`Unknown command '${command}'. Expected 'migrate'.`)
  }

  let mode: Mode | undefined
  let binding = DEFAULT_BINDING
  let config: string | undefined

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string

    // A mode already chosen and a different one asked for is ambiguous, and
    // resolving it by precedence would be a coin flip over which database gets
    // migrated.
    const asMode = arg === '--local' || arg === '--remote'
    if (asMode) {
      const next = arg.slice(2) as Mode
      if (mode !== undefined && mode !== next) {
        throw new Error('Cannot use both --local and --remote.')
      }
      mode = next
      continue
    }

    if (arg === '--binding' || arg === '-c' || arg === '--config') {
      const value = rest[++i]
      if (value === undefined) throw new Error(`${arg} needs a value.`)
      if (arg === '--binding') binding = value
      else config = value
      continue
    }

    // Never ignored. A silently dropped `--dry-run` runs the migration for real.
    throw new Error(`Unknown option '${arg}'.\n${USAGE}`)
  }

  if (mode === undefined) {
    throw new Error(`Specify --local or --remote.\n${USAGE}`)
  }

  return {
    command: 'migrate',
    mode,
    binding,
    ...(config === undefined ? {} : { config }),
  }
}

/**
 * An argv, never a command string.
 *
 * Every statement contains quotes and parentheses. Building a shell string
 * would mean quoting them correctly forever, and getting it wrong once turns a
 * migration into whatever the shell decides it is.
 */
export function wranglerArgs(sql: string, opts: CliOptions): string[] {
  return [
    'd1',
    'execute',
    opts.binding,
    '--command',
    sql,
    '--json',
    `--${opts.mode}`,
    ...(opts.config === undefined ? [] : ['-c', opts.config]),
  ]
}

/**
 * The recorded schema version, or 0.
 *
 * Everything that is not a readable version reads as 0 — an empty result, the
 * `{error:{text}}` shape wrangler emits when `_inbox_meta` does not exist yet,
 * and output too noisy to parse (wrangler interleaves update notices with its
 * JSON). That is safe because every statement is idempotent: the worst case is
 * re-running work already done.
 */
export function parseVersion(stdout: string): number {
  const json = extractJson(stdout)
  if (json === undefined) return 0

  const rows = Array.isArray(json) ? json[0]?.results : undefined
  const value = Array.isArray(rows) ? rows[0]?.value : undefined

  const version = Number(value)
  return Number.isInteger(version) && version > 0 ? version : 0
}

// biome-ignore lint/suspicious/noExplicitAny: parsing output we do not control
function extractJson(stdout: string): any {
  const start = stdout.search(/[[{]/)
  if (start === -1) return undefined
  try {
    return JSON.parse(stdout.slice(start))
  } catch {
    return undefined
  }
}

export interface PlannedMigration {
  version: number
  name: string
  statements: string[]
}

/**
 * What to run, in the order to run it.
 *
 * Each migration carries **its own** version write, last. Not one write at the
 * end: a run that dies after migration 2 has to leave the version at 2, so the
 * retry starts at 3 rather than redoing both. That, plus every statement being
 * idempotent, is what stands in for the transaction this path cannot have.
 */
export function plan(
  current: number,
  migrations: readonly Migration[],
): PlannedMigration[] {
  return [...migrations]
    .sort((a, b) => a.version - b.version)
    .filter((m) => m.version > current)
    .map((m) => ({
      version: m.version,
      name: m.name,
      statements: [
        // First, always. It holds the version, so it cannot be inside the
        // thing it versions.
        META_STATEMENT,
        ...m.statements,
        versionStatement(m.version),
      ],
    }))
}

const VERSION_QUERY = `SELECT value FROM _inbox_meta WHERE key = 'schema_version'`

/** Returns a process exit code. */
export async function runMigrate(
  opts: CliOptions,
  exec: Exec,
  log: (line: string) => void = console.log,
): Promise<number> {
  const probe = await exec(wranglerArgs(VERSION_QUERY, opts))
  const current = parseVersion(probe.stdout)

  const pending = plan(current, MIGRATIONS)
  if (pending.length === 0) {
    log(`Schema is at version ${current}. Nothing to apply.`)
    return 0
  }

  for (const migration of pending) {
    log(`Applying ${migration.version} (${migration.name})…`)

    for (const sql of migration.statements) {
      const result = await exec(wranglerArgs(sql, opts))
      if (result.code !== 0) {
        // Stop here rather than pressing on. The version was not written, so
        // re-running repairs it; continuing past a failure would write a
        // version for a schema that was never fully applied.
        log(result.stderr || result.stdout)
        log(
          `Failed applying ${migration.version}. ` +
            `Nothing was recorded — fix the cause and run it again.`,
        )
        return 1
      }
    }
  }

  log(`Schema is at version ${pending.at(-1)?.version}.`)
  return 0
}

const execWrangler: Exec = (args) =>
  new Promise((resolve) => {
    const child = spawn('wrangler', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => {
      stdout += d
    })
    child.stderr.on('data', (d) => {
      stderr += d
    })

    child.on('error', (e) => resolve({ code: 1, stdout, stderr: e.message }))
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })

/**
 * Run only when invoked directly, never when imported by a test.
 *
 * Compares resolved real paths rather than matching on the filename: npm
 * installs a bin as a symlink, so by the time node runs it `argv[1]` is the
 * link's target and any name-based check silently stops firing.
 */
function invokedDirectly(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  try {
    process.exitCode = await runMigrate(
      parseArgs(process.argv.slice(2)),
      execWrangler,
    )
  } catch (e) {
    console.error((e as Error).message)
    process.exitCode = 1
  }
}
