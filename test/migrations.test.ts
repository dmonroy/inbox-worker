/**
 * The matcher that decides whether a tolerant statement's failure is the one
 * failure we agreed to swallow (§15.1).
 *
 * Pure logic, so it lives in the unit project — but every message asserted
 * here is **verbatim from a spike against local D1**, not invented. That is
 * the whole value of the test: if D1 ever changes the text, this is what says
 * so, rather than a migration quietly tolerating nothing or everything.
 */

import { describe, expect, test } from 'vitest'
import { isDuplicateColumnError } from '../src/migrations'

/** As thrown by `.run()` — D1 prefixes and wraps SQLite's own text. */
const d1Error = (sqlite: string): Error =>
  new Error(`D1_ERROR: ${sqlite}`, { cause: new Error(sqlite) })

describe('recognising the one failure a tolerant statement may swallow', () => {
  test('the duplicate-column failure matches', () => {
    expect(
      isDuplicateColumnError(
        d1Error('duplicate column name: sniffed_type: SQLITE_ERROR'),
      ),
    ).toBe(true)
  })

  test('a missing column does not match', () => {
    // The nearest miss by text, and the reason the phrase has to be the whole
    // `duplicate column name:` rather than anything looser about columns.
    expect(
      isDuplicateColumnError(
        d1Error('no such column: nope at offset 7: SQLITE_ERROR'),
      ),
    ).toBe(false)
  })

  test('a typo in the table name does not match', () => {
    // The failure the closed union exists to keep loud. `{ tolerate: true }`
    // would swallow this and still write the version, leaving a schema that
    // claims to be migrated and is not.
    expect(
      isDuplicateColumnError(
        d1Error('no such table: attachments_typo: SQLITE_ERROR'),
      ),
    ).toBe(false)
  })

  test('a syntax error does not match', () => {
    expect(
      isDuplicateColumnError(
        d1Error('near "ALTAR": syntax error at offset 0: SQLITE_ERROR'),
      ),
    ).toBe(false)
  })

  test('the bare SQLite text matches, without D1 wrapping it', () => {
    // Measured: the binding driver prefixes `D1_ERROR:` and the wrangler
    // driver does not, and both carry SQLite's text unchanged. Matching the
    // text rather than the wrapper is what makes one matcher serve both.
    expect(
      isDuplicateColumnError(
        new Error('duplicate column name: sniffed_type: SQLITE_ERROR'),
      ),
    ).toBe(true)
  })

  test('a non-Error rejection does not match', () => {
    // Nothing measured throws a string, but a matcher that reads `.message`
    // off whatever it is handed must not decide on `undefined`.
    expect(isDuplicateColumnError('duplicate column name: x')).toBe(false)
    expect(isDuplicateColumnError(undefined)).toBe(false)
  })
})
