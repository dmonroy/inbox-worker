import { describe, expect, test } from 'vitest'
import type { EmailMeta } from '../src/inbound'
import { parseEmail } from '../src/mime'
import {
  HOSTILE_FILENAMES,
  HTML_ONLY,
  INLINE_AND_ATTACHMENT,
  MULTIPART_ALTERNATIVE,
  mail,
  NO_MESSAGE_ID,
  PLAIN_TEXT,
  REPLY_WITH_REFERENCES,
} from './fixtures/email'

const RECEIVED_AT = new Date('2025-01-14T10:00:00Z')

const parse = (raw: Uint8Array, target = 'sales@example.org') =>
  parseEmail(raw, { target, receivedAt: RECEIVED_AT })

describe('the ordinary case', () => {
  test('maps a plain text message', async () => {
    const msg = await parse(PLAIN_TEXT)

    expect(msg.channel).toBe('email')
    expect(msg.subject).toBe('Quote request')
    expect(msg.text?.trim()).toBe('Could you send a quote?')
    expect(msg.html).toBeUndefined()
    expect(msg.attachments).toEqual([])
    expect(msg.contact).toEqual({
      externalId: 'ada@example.com',
      name: 'Ada Lovelace',
    })
  })

  test('keeps both bodies of a multipart/alternative', async () => {
    // Storing only one loses either the formatting or the searchable text.
    const msg = await parse(MULTIPART_ALTERNATIVE)
    expect(msg.text?.trim()).toBe('Plain version')
    expect(msg.html?.trim()).toBe('<p>HTML version</p>')
  })

  test('an HTML-only message has no text body invented for it', async () => {
    // A text body derived from HTML would be indistinguishable from one the
    // sender actually wrote, and stored as though it were.
    const msg = await parse(HTML_ONLY)
    expect(msg.html?.trim()).toBe('<p>Hello</p>')
    expect(msg.text).toBeUndefined()
  })

  test('carries the raw bytes through untouched', async () => {
    // Everything downstream hashes these (§4). A re-encode would change the id.
    const msg = await parse(PLAIN_TEXT)
    expect(msg.raw.bytes).toEqual(PLAIN_TEXT)
    expect(msg.raw.contentType).toBe('message/rfc822')
  })

  test('receivedAt is the one we were given, not the clock', async () => {
    const msg = await parse(PLAIN_TEXT)
    expect(msg.receivedAt).toEqual(RECEIVED_AT)
  })
})

describe('the target is the envelope, never the headers', () => {
  test('uses the envelope recipient even when To says otherwise', async () => {
    // The envelope decides delivery; the To header is sender-supplied text and
    // routinely disagrees (bcc, forwards, mailing lists). Routing already runs
    // off the envelope, so parsing must not quietly substitute a header — that
    // would send a bcc'd message to whichever inbox the sender named.
    const msg = await parse(PLAIN_TEXT, 'billing+q3@example.org')
    expect(msg.target).toBe('billing+q3@example.org')
  })

  test('the header recipient is still recorded as a participant', async () => {
    const msg = await parse(PLAIN_TEXT, 'billing@example.org')
    expect(msg.participants).toContainEqual({
      role: 'to',
      identifier: 'sales@example.org',
    })
  })
})

describe('contact and participants', () => {
  test('cc addresses keep their role, with names when given', async () => {
    const msg = await parse(REPLY_WITH_REFERENCES)
    expect(msg.contact).toEqual({
      externalId: 'grace@example.com',
      name: 'Grace Hopper',
    })
    expect(msg.participants).toEqual([
      { role: 'to', identifier: 'sales@example.org' },
      { role: 'cc', identifier: 'ada@example.com', name: 'Ada Lovelace' },
      { role: 'cc', identifier: 'bob@example.com' },
    ])
  })

  test('identifiers are normalised the same way as everywhere else', async () => {
    // Same rule as PR #1: lowercase, drop the plus-tag. Anything else and
    // participants never join against contacts.
    const msg = await parse(
      mail(['From: Ada@Example.COM', 'To: Sales+Q3@Example.ORG', 'Subject: x']),
    )
    expect(msg.contact?.externalId).toBe('ada@example.com')
    expect(msg.participants[0]?.identifier).toBe('sales@example.org')
  })

  test('a message with no From parses, with no contact', async () => {
    // Optional rather than invented. A placeholder like `unknown@invalid`
    // would gather every malformed sender under one contact, and merge their
    // history in the reader.
    const msg = await parse(mail(['To: sales@example.org', 'Subject: x']))
    expect(msg.contact).toBeUndefined()
    expect(msg.subject).toBe('x')
  })

  test('an unparseable From yields no contact rather than a junk one', async () => {
    const msg = await parse(
      mail(['From: not an address', 'To: sales@example.org', 'Subject: x']),
    )
    expect(msg.contact).toBeUndefined()
  })

  test('unparseable participants are dropped, not stored raw', async () => {
    // `participants.identifier` is a join key. A value that cannot normalise
    // is not a key, and storing it pollutes the index for every real lookup.
    // Nothing is lost that is not recoverable: raw is always in R2.
    const msg = await parse(
      mail([
        'From: ada@example.com',
        'To: sales@example.org, garbage, bob@example.com',
        'Subject: x',
      ]),
    )
    expect(msg.participants.map((p) => p.identifier)).toEqual([
      'sales@example.org',
      'bob@example.com',
    ])
  })

  test('an address group is flattened to its members', async () => {
    const msg = await parse(
      mail([
        'From: ada@example.com',
        'To: Team: bob@example.com, carol@example.com;',
        'Subject: x',
      ]),
    )
    expect(msg.participants.map((p) => p.identifier)).toEqual([
      'bob@example.com',
      'carol@example.com',
    ])
  })

  test('an empty group leaves no participants and does not throw', async () => {
    // `undisclosed-recipients:;` is ordinary in bcc-only mail.
    const msg = await parse(
      mail([
        'From: ada@example.com',
        'To: undisclosed-recipients:;',
        'Subject: x',
      ]),
    )
    expect(msg.participants).toEqual([])
  })
})

describe('threading inputs', () => {
  test('Message-ID loses its angle brackets', async () => {
    // The stored form has to match the form we look up, or every join misses.
    const msg = await parse(PLAIN_TEXT)
    expect(msg.externalId).toBe('plain-1@example.com')
  })

  test('Message-ID case is preserved', async () => {
    // Opaque token, matched by exact string. Lowercasing would collide two
    // genuinely distinct ids from a sender that varies case.
    const msg = await parse(
      mail(['From: ada@example.com', 'Message-ID: <AbC-1@Example.COM>']),
    )
    expect(msg.externalId).toBe('AbC-1@Example.COM')
  })

  test('no Message-ID leaves externalId absent, not empty', async () => {
    // An empty string is a value, and every id-less message would share it —
    // collapsing unrelated mail into one conversation via the index.
    const msg = await parse(NO_MESSAGE_ID)
    expect(msg.externalId).toBeUndefined()
  })

  test('references are split, stripped, and kept in order', async () => {
    const msg = await parse(REPLY_WITH_REFERENCES)
    const meta = msg.meta as EmailMeta
    expect(meta.inReplyTo).toBe('plain-2@example.com')
    expect(meta.references).toEqual([
      'plain-1@example.com',
      'plain-2@example.com',
    ])
  })

  test('repeated references are de-duplicated, first position kept', async () => {
    // §8 takes the last 20 candidates. Duplicates would spend that budget on
    // one id and push real ancestors out of the window.
    const msg = await parse(
      mail([
        'From: ada@example.com',
        'References: <a@x.com> <b@x.com> <a@x.com>',
      ]),
    )
    expect((msg.meta as EmailMeta).references).toEqual(['a@x.com', 'b@x.com'])
  })

  test('a folded References header is read as one list', async () => {
    // Long chains are folded by every real client. Reading only the first line
    // silently truncates the ancestry.
    const msg = await parse(
      mail([
        'From: ada@example.com',
        'References: <a@x.com>\r\n <b@x.com>\r\n\t<c@x.com>',
      ]),
    )
    expect((msg.meta as EmailMeta).references).toEqual([
      'a@x.com',
      'b@x.com',
      'c@x.com',
    ])
  })

  test('no References gives an empty list, not undefined', async () => {
    expect(((await parse(PLAIN_TEXT)).meta as EmailMeta).references).toEqual([])
  })
})

describe('dates', () => {
  test('a valid Date header becomes sentAt', async () => {
    const msg = await parse(PLAIN_TEXT)
    expect(msg.sentAt).toEqual(new Date('2025-01-14T09:30:00Z'))
  })

  test('an unparseable Date is dropped rather than stored as Invalid Date', async () => {
    // `new Date('yesterday')` is a Date whose getTime() is NaN. Written to D1
    // that becomes a NaN timestamp, and every ordering query built on it goes
    // wrong in a way that is very hard to trace back to one bad header.
    const msg = await parse(
      mail(['From: ada@example.com', 'Date: yesterday afternoon']),
    )
    expect(msg.sentAt).toBeUndefined()
  })
})

describe('subject', () => {
  test('an empty subject is absent, not an empty string', async () => {
    // `subject IS NULL` has to find these. An empty string is a value.
    const msg = await parse(mail(['From: ada@example.com', 'Subject: ']))
    expect(msg.subject).toBeUndefined()
  })

  test('an encoded-word subject is decoded', async () => {
    const msg = await parse(
      mail(['From: ada@example.com', 'Subject: =?utf-8?B?w6lsw6lnYW50?=']),
    )
    expect(msg.subject).toBe('élégant')
  })
})

describe('attachments', () => {
  test('separates an inline image from a real attachment', async () => {
    // Getting this wrong shows the sender's logo as a download beside their
    // PDF, on every message they send.
    const msg = await parse(INLINE_AND_ATTACHMENT)

    const inline = msg.attachments.filter((a) => a.inline)
    const files = msg.attachments.filter((a) => !a.inline)

    expect(inline).toHaveLength(1)
    expect(inline[0]?.mimeType).toBe('image/png')
    expect(inline[0]?.cid).toBe('logo@example.com')

    expect(files).toHaveLength(1)
    expect(files[0]?.filename).toBe('terms.pdf')
    expect(files[0]?.mimeType).toBe('application/pdf')
  })

  test('attachment content is bytes, not a base64 string', async () => {
    // These get hashed into an R2 key. Hashing the base64 text instead of the
    // decoded bytes gives a key that changes with the transfer encoding.
    const msg = await parse(INLINE_AND_ATTACHMENT)
    const pdf = msg.attachments.find((a) => !a.inline)

    expect(pdf?.bytes).toBeInstanceOf(Uint8Array)
    // '%PDF-1.4\n' — the decoded bytes of `JVBERi0xLjQK`.
    expect(pdf?.bytes.slice(0, 5)).toEqual(
      new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
    )
  })

  test('an attachment with no filename has none invented', async () => {
    const msg = await parse(
      mail(
        [
          'From: ada@example.com',
          'Content-Type: multipart/mixed; boundary="b"',
        ],
        '--b\r\nContent-Type: text/plain\r\n\r\nbody\r\n' +
          '--b\r\nContent-Type: application/octet-stream\r\n' +
          'Content-Disposition: attachment\r\n\r\nx\r\n--b--\r\n',
      ),
    )
    const att = msg.attachments[0]
    expect(att).toBeDefined()
    expect(att?.filename).toBeUndefined()
  })
})

describe('hostile filenames', () => {
  // Filenames never reach a storage key — R2 keys are content hashes (§4) — so
  // this is not protecting us. It is protecting whoever serves a download and
  // reaches for `filename` to build a Content-Disposition or a path.
  const filenames = async () =>
    (await parse(HOSTILE_FILENAMES)).attachments.map((a) => a.filename)

  test('path traversal is reduced to a basename', async () => {
    const [traversal, absolute, windows] = await filenames()
    expect(traversal).toBe('passwd')
    expect(absolute).toBe('shadow')
    expect(windows).toBe('cmd.exe')
  })

  test('control characters are removed, so a name cannot inject a header', async () => {
    const [, , , injected] = await filenames()
    expect(injected).toBe('report.pdfX-Injected: yes')
    expect(injected).not.toMatch(/[\r\n]/)
  })

  test('a name that is only dots is dropped', async () => {
    const [, , , , dots] = await filenames()
    expect(dots).toBeUndefined()
  })

  test('an overlong name is truncated', async () => {
    const [, , , , , long] = await filenames()
    expect(long?.length).toBe(255)
  })

  test('a line terminator before a separator does not smuggle the path through', async () => {
    // The basename strip used to be a `^.*[/\\]` replace. `.` never matches a
    // line terminator and there is no `m` flag, so any of these names made the
    // pattern fail to match at all — and the control-character pass then
    // removed the evidence. This fails if someone reintroduces a `.`-based
    // basename, or reorders so that stripping runs after the basename.
    const [, , , , , , crlf, lf, lineSep] = await filenames()
    expect(crlf).toBe('passwd')
    expect(lf).toBe('shadow')
    expect(lineSep).toBe('passwd')
  })

  test('a name cannot close a Content-Disposition parameter', async () => {
    // The doc comment on `filename` promises it protects whoever builds that
    // header. Leaving `"` and `;` in makes the promise false: this name ends
    // the parameter and starts a new `filename=` of the sender's choosing.
    const [, , , , , , , , , quoted] = await filenames()
    expect(quoted).not.toMatch(/[";]/)
    expect(quoted).toBe('a filename=evil.exe')
  })

  test('bidi controls are removed, so an extension cannot be disguised', async () => {
    // `invoice<U+202E>gnp.exe` renders right-to-left from the override as
    // `invoicexe.png`, so a reader clicks what looks like an image.
    const [, , , , , , , , , , bidi] = await filenames()
    expect(bidi).toBe('invoicegnp.exe')
  })

  test('truncation never splits a surrogate pair', async () => {
    // A lone surrogate is not valid UTF-8. It reaches D1 and JSON and breaks
    // whatever encodes it, far from here. Same rule `previewOf` applies to
    // `body_preview`: shrink the cut by one rather than store half a pair.
    const names = await filenames()
    const astral = names[11]
    expect(astral?.length).toBe(254)
    expect(astral).not.toMatch(/[\ud800-\udfff]/)
  })
})

describe('malformed input', () => {
  test('garbage bytes parse to an empty message rather than throwing', async () => {
    // postal-mime is tolerant, so most junk yields a shell rather than an
    // error. Recording that here because it is the reason the never-throw rule
    // (§7.4) cannot rely on the parser signalling trouble — an empty Inbound
    // and a valid empty message are indistinguishable at this layer.
    const msg = await parse(new Uint8Array([0xff, 0x00, 0xfe]))
    expect(msg.contact).toBeUndefined()
    expect(msg.attachments).toEqual([])
    expect(msg.target).toBe('sales@example.org')
  })

  test('headers with no body at all still parse', async () => {
    const msg = await parse(new TextEncoder().encode('Subject: Hi'))
    expect(msg.subject).toBe('Hi')
  })
})
