/**
 * Synthesised messages. **Never real mail** — these live in a public repo, and
 * a real message carries real addresses, subjects, and attachments.
 *
 * Every address here is under `example.com` / `example.org`, which RFC 2606
 * reserves precisely so it can never reach anyone.
 */

const enc = new TextEncoder()

/** Header lines and a body, joined the way a wire message is: CRLF, blank line, body. */
export function mail(headers: string[], body = ''): Uint8Array {
  return enc.encode(`${headers.join('\r\n')}\r\n\r\n${body}`)
}

export const PLAIN_TEXT = mail(
  [
    'From: Ada Lovelace <ada@example.com>',
    'To: sales@example.org',
    'Subject: Quote request',
    'Message-ID: <plain-1@example.com>',
    'Date: Tue, 14 Jan 2025 09:30:00 +0000',
  ],
  'Could you send a quote?\r\n',
)

export const HTML_ONLY = mail(
  [
    'From: ada@example.com',
    'To: sales@example.org',
    'Subject: Styled',
    'Content-Type: text/html; charset=utf-8',
  ],
  '<p>Hello</p>\r\n',
)

export const MULTIPART_ALTERNATIVE = mail(
  [
    'From: ada@example.com',
    'To: sales@example.org',
    'Subject: Both forms',
    'Content-Type: multipart/alternative; boundary="b1"',
  ],
  [
    '--b1',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Plain version',
    '--b1',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>HTML version</p>',
    '--b1--',
    '',
  ].join('\r\n'),
)

/** An inline image referenced by `cid:`, plus a real attachment beside it. */
export const INLINE_AND_ATTACHMENT = mail(
  [
    'From: ada@example.com',
    'To: sales@example.org',
    'Subject: Logo and terms',
    'Content-Type: multipart/mixed; boundary="outer"',
  ],
  [
    '--outer',
    'Content-Type: multipart/related; boundary="inner"',
    '',
    '--inner',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p><img src="cid:logo@example.com"></p>',
    '--inner',
    'Content-Type: image/png',
    'Content-ID: <logo@example.com>',
    'Content-Transfer-Encoding: base64',
    '',
    // A 1x1 transparent PNG. Small, valid, and carries no information.
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk',
    'YPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    '--inner--',
    '--outer',
    'Content-Type: application/pdf',
    'Content-Disposition: attachment; filename="terms.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    'JVBERi0xLjQK',
    '--outer--',
    '',
  ].join('\r\n'),
)

/**
 * A UTF-8 RFC 2047 base64 encoded-word. `btoa` alone only takes latin1, and
 * several of the names below are deliberately non-latin1.
 */
function word(name: string): string {
  let latin1 = ''
  for (const byte of enc.encode(name)) latin1 += String.fromCharCode(byte)
  return `=?utf-8?B?${btoa(latin1)}?=`
}

/**
 * Filenames built to escape the place they are written. Positional — the tests
 * destructure by index, so **append, never insert**.
 *
 * In order: path traversal, an absolute path, a Windows path, a CRLF header
 * injection, a name that is nothing but dots, one far past any filesystem's
 * length limit, then three that hide a path separator behind a character a
 * JS `.` does not match, one that closes a `Content-Disposition` parameter,
 * one that disguises its extension with a bidi override, and one whose
 * truncation point lands inside a surrogate pair.
 *
 * They are RFC 2047 encoded-words rather than quoted strings, because a
 * quoted string cannot carry a raw CRLF and treats backslash as an escape.
 * Encoded-words decode to arbitrary bytes, which is what makes them the real
 * vector — the hostile name only exists *after* the parser has decoded it.
 */
const hostile = [
  '=?utf-8?B?Li4vLi4vLi4vZXRjL3Bhc3N3ZA==?=',
  '=?utf-8?B?L2V0Yy9zaGFkb3c=?=',
  '=?utf-8?B?Li5cLi5cd2luZG93c1xzeXN0ZW0zMlxjbWQuZXhl?=',
  '=?utf-8?B?cmVwb3J0LnBkZg0KWC1JbmplY3RlZDogeWVz?=',
  '=?utf-8?B?Li4=?=',
  `=?utf-8?B?${btoa(`${'a'.repeat(400)}.pdf`)}?=`,
  word('report.pdf\r\n/../../etc/passwd'),
  word('x\n/etc/shadow'),
  // U+2028 is a line terminator to a JS regex but not a C0 control, so it is
  // invisible to both the basename strip and the control-character pass.
  word('x\u2028/../../etc/passwd'),
  word('a"; filename="evil.exe'),
  // U+202E right-to-left override: renders as `invoicexe.png`.
  word('invoice\u202egnp.exe'),
  // 254 ASCII then astral characters, so a 255-code-unit cut lands between the
  // surrogates of the first emoji.
  word(`${'a'.repeat(254)}${'\u{1f600}'.repeat(3)}`),
]

export const HOSTILE_FILENAMES = mail(
  [
    'From: ada@example.com',
    'To: sales@example.org',
    'Subject: Attachments',
    'Content-Type: multipart/mixed; boundary="b"',
  ],
  `${hostile
    .map((name, i) =>
      [
        '--b',
        'Content-Type: text/plain',
        `Content-Disposition: attachment; filename="${name}"`,
        '',
        `part ${i}`,
      ].join('\r\n'),
    )
    .join('\r\n')}\r\n--b--\r\n`,
)

/** A reply, with the chain a well-behaved client sends. */
export const REPLY_WITH_REFERENCES = mail(
  [
    'From: Grace Hopper <grace@example.com>',
    'To: sales@example.org',
    'Cc: Ada Lovelace <ada@example.com>, bob@example.com',
    'Subject: Re: Quote request',
    'Message-ID: <reply-3@example.com>',
    'In-Reply-To: <plain-2@example.com>',
    'References: <plain-1@example.com> <plain-2@example.com>',
  ],
  'Sending it over.\r\n',
)

/**
 * A body well past the 512 KB inline limit, so it has to spill to R2 (§5).
 *
 * Generated rather than written out. Committing 600 KB of filler to a public
 * repo to assert one boolean is not a trade worth making, and a fixture whose
 * size is the whole point should state that size in code where it cannot drift
 * away from the limit it is testing.
 */
export const OVERSIZED_BODY = mail(
  [
    'From: ada@example.com',
    'To: sales@example.org',
    'Subject: Log dump',
    'Message-ID: <oversized-1@example.com>',
  ],
  `${'Lorem ipsum dolor sit amet. '.repeat(24_000)}\r\n`,
)

/**
 * No `From` header at all. The sender cannot be determined, and inventing a
 * placeholder contact would collect every such message under one identity.
 */
export const NO_FROM = mail(
  [
    'To: sales@example.org',
    'Subject: Anonymous sender',
    'Message-ID: <no-from-1@example.com>',
  ],
  'Who sent this?\r\n',
)

export const NO_MESSAGE_ID = mail(
  ['From: ada@example.com', 'To: sales@example.org', 'Subject: Anonymous'],
  'No id here.\r\n',
)
