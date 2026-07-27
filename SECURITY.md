# Security

> **Early development.** No releases, no versions, and no supported
> deployments. Nothing here is a commitment; it is a description of what the
> code does today and what it is trying to do.

This project stores a company's entire inbound mail archive. If you are
evaluating it for a deployment, the second half of this file — the threat
model — is the part worth your time.

## Reporting a vulnerability

Report privately. Do not open a public issue for anything that could be used
against a running deployment.

Use GitHub's private security advisories:

**https://github.com/dmonroy/inbox-worker/security/advisories/new**

There is no security contact address in this repository, and this file does not
invent one. If the advisory form is unavailable — private vulnerability
reporting has to be enabled per repository, and it may not be yet — open a
public issue that says only that you have a security report and asks for a
private channel. Leave the details out of it.

Useful to include: the affected version or commit, what an attacker can do,
and a message or input that reproduces it. Synthesised, please — see
*Fixtures*, below.

### What to expect

Honestly: not much, yet.

- One maintainer, working on this intermittently.
- No release, no versioning, and therefore no security releases and no
  backports. The fix will be a commit on `main`.
- **No response-time commitment.** Nobody has agreed to an SLA, so this file
  does not state one.
- No bounty.

If a report is valid, the fix gets a failing test before the fix, like every
other bug in this repo.

### Fixtures are synthesised, never real mail

Test fixtures are committed to a public repository. Do not send a real
message — it carries real addresses, subjects, and attachments. Construct a
minimal synthetic reproducer.

---

## Threat model

### The premise

**Every inbound message is attacker-controlled input from an unauthenticated
stranger.** That is the normal case for email, not the exceptional one. Anyone
who can find an address can reach the ingest path, choose every header and
every byte of the body, and repeat as often as they like.

So the interesting question is never "is this input trusted" — it is not — but
"what can it reach". Three answers this design keeps coming back to:

1. **Identity must not be derived from anything the sender writes.** Otherwise
   a stranger picks the storage key.
2. **A crash is data loss, not an error.** Email has no retry, so a message
   that crashes the handler is gone.
3. **Grouping is a disclosure boundary.** Anything that decides two messages
   belong together decides who sees whose mail.

### What is actually implemented

Almost everything below is built; what varies is how far each part has been
exercised. A security document that overstates coverage is worse than none, so
the table says which is which:

| Property | Where | Status |
|---|---|---|
| Envelope-only routing, address normalisation | `src/address.ts`, `src/resolve.ts` | implemented · **run against real mail** |
| Quarantine fallback; system inboxes unaddressable | `src/resolve.ts` | implemented · **run against real mail** |
| Config validation fails loudly at startup | `src/config.ts`, `src/validate.ts` | implemented |
| Content-derived identity; trace-header stripping | `src/identity.ts`, `src/trace.ts` | implemented · **verified in production** (§4.2) |
| Content-addressed R2 keys; D1 writes | `src/store.ts` | implemented · **verified in production** |
| Child-row dedup keys (fan-out and retry safe) | `src/migrations.ts`, `src/store.ts` | implemented |
| Parser caps (nesting depth, header bytes) | `src/mime.ts` | implemented · never triggered live |
| Post-parse caps | `src/caps.ts`, `src/handler.ts` | implemented and **called by the handler** · never triggered live |
| Attachment filename sanitisation | `src/mime.ts` | implemented · run against real filenames |
| Schema, migration runner, `migrate` command | `src/migrations.ts`, `src/cli.ts` | implemented · run against real D1 |
| The email handler | `src/handler.ts` | implemented · **receiving real mail** |
| DMARC gate, read from raw bytes by authserv-id | `src/dmarc.ts` | implemented · **passing on real mail** |
| Conversations: no-merge, DMARC-gated index writes | `src/conversations.ts` | implemented · **threading real replies** |
| **Never-throw ingest and `failed_ingest`** | `src/handler.ts` | implemented, **never exercised in production** — see below |
| **Replay: draining `failed_ingest`** | `src/replay.ts`, `src/ingest.ts` | implemented as a **cron handler, not a CLI command** — see below |
| **Any read side** (API, UI, search, read state) | — | **not implemented** |

**This has received real mail.** A demo deployment on a live zone has taken
messages end to end: routed, quarantined, stored, threaded, attachments
content-addressed in R2. One attachment was pulled back out and its
`sha256` matched its R2 key byte for byte, which is the identity claim in §4
verified rather than argued.

**That is not the same as being safe to deploy**, and three gaps matter more
than the green rows above:

1. **The never-throw path has never run in production.** `failed_ingest` is
   empty because nothing has failed — so the recovery guarantee, the single
   most important property in §7.4, is verified only by tests. Replay now
   exists and closes the second half of that gap, but it too has only ever run
   against miniflare, and against failures a test manufactured.
2. **No cap has ever been hit.** They are wired and unit-tested, but nothing
   real has come close to 50 attachments or 20 MB.
3. **There is no read side.** The archive can only be read with SQL. Nothing
   here has been designed against the threats a reader introduces, and §4.2's
   guidance on serving attachments is advice to a consumer who does not exist
   yet.

An earlier version of this table said the handler did not exist and that
`applyCaps` was called by nothing. Both were true when written and are now
false. A security document that lags the code is worse than none — the reader
cannot tell which rows to trust — so this table is updated with the code, not
after it.

The rest of this section describes each decision, and each one opens by saying
how far it has actually been exercised.

---

### Identity never derives from unauthenticated input

*Implemented (`src/identity.ts`, `src/trace.ts`) and used by the storage path
for every message (`src/store.ts`). **Verified in production**: an attachment
pulled back out of R2 hashed to its own key, byte for byte.*

An earlier design used `sha256(channel + ':' + Message-ID)` as the content id
and as the R2 object key. `Message-ID` is written by the sender. It is also
world-visible: it appears in every quoted reply, every list archive, and every
bounce. Keying storage on it gave two silent failures.

- **Silent loss.** An appliance that emits a constant
  `Message-ID: <alert@nagios>` stores alert #1. Alerts #2 through #500 collide
  on `INSERT OR IGNORE` and the inbox shows rows pointing at the wrong body.
  No error anywhere.
- **Third-party overwrite.** Anyone who knew a `Message-ID` could mail the
  system with that id and, under idempotent-overwrite semantics, replace that
  message's stored `.eml`, body, and attachments while D1 still described the
  original. That is an unauthenticated write into someone else's archive.

Identity is now derived from the bytes:

```
rawHash   = sha256(raw bytes)                      exactly what arrived
contentId = sha256(channel + ':' + normalizedHash) dedup key
messageId = sha256(contentId + ':' + inboxKey)     one arrival
```

`normalizedHash` is the raw bytes with per-delivery trace headers removed —
`Received`, `Received-SPF`, `X-Received`, `Delivered-To`, `Return-Path`,
`Authentication-Results`, `ARC-Seal`, `ARC-Message-Signature`,
`ARC-Authentication-Results`, `X-Forwarded-For`, `X-Forwarded-To`,
`X-Forwarded-Encrypted`. Those are the headers an edge stamps differently per
envelope recipient, so stripping them lets one message delivered to two inboxes
agree on one id, while two genuinely different messages that happen to share a
`Message-ID` stay apart.

The list matches **exact names, never prefixes**, so a family has to be
enumerated member by member — which is how `X-Forwarded-Encrypted` reached
production unstripped and was found by diffing two real deliveries. It stays
provisional, because the fan-out that has actually been observed is
sender-side: Gmail split one compose into two SMTP transactions from two of its
own servers before Cloudflare saw either. True envelope fan-out — one
transaction, two `RCPT TO`, identical bytes — is the case this list exists for
and it has never been measured. Erring wide is the safe direction, since
stripping a header that was identical anyway costs nothing.

**R2 is content-addressed**, and that is the point: different bytes cannot
produce the same key, so the overwrite attack stops existing rather than being
forbidden. There is no `onlyIf` guard to get wrong, no policy to enforce, and
no code path where the check could be skipped. Structural, not procedural.

`Message-ID` survives as the threading key, where being sender-supplied is
inherent to the job and the blast radius is bounded — see *Conversations*.

**Residual risk.** Content addressing means byte-identical messages deduplicate,
which is correct but has a corner: a sender who already holds an exact copy of
a message can submit it first, and the later genuine arrival deduplicates
against theirs. The stored payload is the same bytes either way; what differs
is which raw object the row points at. Requires byte-exact prior knowledge, so
it is narrow, but it is the honest cost of dedup-by-content.

### The target comes from the envelope, never from a header

*Implemented (`src/mime.ts`, `src/resolve.ts`), and **run against real mail**:
routing by local part, the plus tag recorded rather than routed on, and
quarantine fallback are all confirmed on a live zone.*

Which inbox a message lands in is decided by the SMTP envelope recipient, which
is passed into the parser rather than read out of the message. `To` is
sender-supplied text that disagrees with the envelope on every bcc, forward,
and mailing-list delivery. Routing on it would let a sender name the inbox
their message arrives in.

Related, and enforced in `src/resolve.ts`:

- An address that will not parse, or a local part matching no inbox, falls back
  to a built-in `quarantine` inbox. It is never rejected — see the next
  section.
- The `quarantine` inbox is marked `system` and is **not addressable**.
  Mail to `quarantine@` falls back into it, but cannot match it directly, so
  nobody can post into the review queue on purpose.
- The one thing refused before storage is mail for a domain that was never
  declared. That means the zone is pointed here by mistake, and quarantining it
  silently would make a misconfiguration look like ordinary unknown-address
  traffic.

Addresses are normalised once, in one place: lowercase local part and domain,
plus-tag stripped, tag case preserved. Two normalisation rules would mean
`Darwin@Example.com` and `darwin@example.com` becoming two contacts, and every
join against them missing one.

### The ingest path never throws

*Implemented (`src/handler.ts`, `src/ingest.ts`), including the replay that
drains what it records (`src/replay.ts`). Never triggered by real mail.*

An Email Worker has no transient-failure path. An unhandled exception makes
Cloudflare return **521 after DATA — a permanent 5xx**. The sending server
bounces the message to its author and **never retries**. `setReject()` is
likewise a permanent SMTP error.

So in this system a crash is not an error. It is mail loss.

That makes any reachable parser crash a **censorship primitive**: craft a
message that reliably breaks the parser and you can drop a thread, or keep
`support@` bouncing indefinitely, from any address, at no cost. The failure is
deterministic, so it recurs on every retry and the message can never be
delivered at all.

The rule: **once the raw bytes are in R2, the handler always returns success.**
Everything after that write is wrapped; a failure records a `failed_ingest` row
naming the R2 key, the channel, the envelope target, the stage, and the error,
and then returns normally.

**The backlog is drained by a cron trigger, not by a CLI command.** The design
document asks for `inbox-worker replay <key>`, and that command cannot be
written safely. The CLI shells out to `wrangler d1 execute --command`, one
statement at a time, with **no bound parameters** — and replaying a message
means writing a subject, a body, a display name and a filename that a stranger
chose into a dozen rows. Building that SQL by string interpolation from
attacker-controlled bytes is an injection hole into the archive, and it is
precisely why every statement in `src/store.ts` uses `.bind()`. A second
implementation of every write, running rarely, is also the one that drifts from
the schema.

So `scheduled()` does it instead: the same `runPipeline` live ingest uses, in
the worker, with the real D1 and R2 bindings. No public endpoint, no
authentication code, and no API token — an authenticated admin endpoint was
considered and rejected on the same grounds §2.1 rejected an unauthenticated
one, with the extra objection that it would be the first credential-checking
code in a repository that currently has none to get wrong.

What that costs the operator is a `[triggers]` line in `wrangler.toml`. **A
deployment without one is safe but never recovers**: messages are kept and
never delivered.

Three properties of the drain matter for the threat model:

- **Bounded.** Ten rows per run. Draining an unbounded backlog in one
  invocation exceeds D1's per-invocation query limit and fails as a whole,
  every time — a dead letter that can never be drained, which is the same trap
  §8 avoided by refusing to merge conversations. Anyone who can send mail can
  also fill this table, so the bound is not a nicety.
- **Attempt-capped.** A row that fails ten times is *parked*: skipped, and
  never deleted, because it is the only pointer to the raw object. A crafted
  message that fails deterministically therefore cannot occupy a slot in every
  future batch ahead of messages that would succeed.
- **Routing is re-resolved, not restored.** The row records the envelope
  address, and the drain resolves it against the config as it is now. Nothing
  in the row names an inbox, so nothing an attacker wrote can select one.

Two consequences worth stating:

- **Orphaned R2 objects are not garbage.** An object in `raw/` with no D1 row
  is either a message awaiting replay or the only surviving copy of one that
  failed. Do not write a sweeper that deletes them.
- **Migrations never run from the worker.** DDL on the never-throw path, driven
  by an unauthenticated stranger, racing every isolate that started at the same
  time, needing permanent runtime DDL rights — every part of that is wrong.
  Migrations are a local command, run before deploy. The worker only reads the
  schema version, and a version mismatch degrades to raw-in-R2 plus a loud log,
  because refusing the message would destroy it.

### Conversations are never merged

*Implemented (`src/conversations.ts`), DMARC gate included (`src/dmarc.ts`).
**Threading real replies** on a live zone — but only in order. A reply
arriving before its parent, which the seeded index and the no-merge rule both
exist for, has never happened outside a test.*

Email threading is inferred from `In-Reply-To` and `References`. Both are
unauthenticated, sender-written headers.

An earlier design merged two conversations when a message referenced both,
repointing the losers' rows. That is an **attacker-writable merge**: one email
listing message ids harvested from two different customers' threads — ids that
are visible in any quoted reply — merges those threads, and each customer's
messages appear in the other's conversation view. There is no undo and no
record of the pre-merge state. It was also unbounded (a message referencing ids
across four hundred conversations rewrites every row in all of them, inside one
batch, past D1's limits, failing identically on every retry) and
non-convergent under concurrency.

So: a message **joins** the conversation with the lexicographically smallest
matching id, and conversations are **never merged**. Deterministic,
commutative, constant work, safe under any interleaving.

The cost is honest: a thread that should have been one conversation can stay
split in two. In a shared inbox an occasional split is an annoyance; a wrong
merge leaks one customer's mail into another's thread. Not a close call.

**Index writes for not-yet-seen ids are gated on DMARC.** The conversation
index maps every message id seen — including ids only *referenced*, never
received — to a conversation, so that a late-arriving parent joins its thread
instead of forking. Ungated, that is a **thread-hijacking primitive**: mail
`support@` with `References: <id-you-expect-them-to-see>`, and the real message
later joins *your* conversation.

Any message may join through an index row that already exists. Only a
DMARC-passing message may create a row for an id that has not been received.
This is the one place authentication is enforced rather than merely recorded.

The gate is `src/dmarc.ts`, and the thing it has to get right is that
`Authentication-Results` is a header a *sender* can also write. A message may
arrive carrying a forged `Authentication-Results: … dmarc=pass` beneath the one
the receiving edge prepended, and a naive read of the joined header value would
find it. So it reads the first such header out of the raw bytes and believes it
only when the `authserv-id` is the one this deployment expects — the edge's own
result specifically, not any occurrence of the string.

Real mail has exercised the accepting half: every Gmail delivery in the live
run stored `verified = 1`. The refusing half — a forged header, a copied
authserv-id, `dmarc=pass` appearing as a value rather than a method result — is
covered by tests only, and no attacker has tried it here yet.

Subject-based fallback threading is **off**, for the same reason merging is:
silently grouping strangers' mail is worse than occasionally splitting a
thread.

### Ingest caps, and what they actually bound

*Implemented as a pure pass (`src/caps.ts`) plus two parser options
(`src/mime.ts`), and applied to every message by the ingest pipeline
(`src/ingest.ts`), live and replayed alike. **No cap has ever been hit in
production** — nothing real has come close to any of the numbers below.*

| Cap | Default | Enforced | Behaviour |
|---|---|---|---|
| MIME nesting depth | 20 | parser, pre-decode | throws |
| header block bytes | 256 KiB | parser, pre-decode | throws |
| attachments per message | 50 | post-parse | truncates |
| total decoded attachment bytes | 20 MB | post-parse | truncates |
| participants per message | 200 | post-parse | truncates |
| `References` entries carried | 20 (the **last** 20) | post-parse | truncates |

**Be precise about what these protect.** Only `depth` and `headerBytes` run
before decoding, because they are parser options. `postal-mime` decodes every
part before it returns, so **the attachment caps do not bound the parser's own
allocation.** What bounds that is the platform's ~25 MB inbound limit together
with the two parser caps, against a hard 128 MB isolate limit — and the
realistic peak on a 25 MB message is 60–90 MB, because the raw buffer, the
decoded parts, and the per-attachment copies are all resident at once.

What the post-parse caps bound is everything *downstream*: R2 puts, D1 rows,
and the extra copy each one makes. That is the failure that actually bites. Ten
thousand tiny MIME parts is ten thousand R2 puts and ten thousand D1 rows in
one invocation, past both the subrequest limit and the
1,000-queries-per-invocation limit — so the message fails, and because it fails
identically every time, it can never be delivered.

The two kinds behave oppositely on purpose. Parser caps **throw**, because a
message too deep to parse has no truncated form worth keeping; the handler will
dead-letter it with the raw bytes intact. Post-parse caps **truncate and
record** an overflow note, because refusing a message we can mostly read would
lose it permanently.

`References` keeps the **last** n, not the first — it runs oldest to newest, so
the tail is the near ancestry a reply actually threads against.

### Attachment filenames are hostile by default

*Sanitisation implemented (`src/mime.ts`); content-addressed attachment keys
implemented (`src/store.ts`) and **verified in production** — a real PDF pulled
back out of R2 hashed to its own key. The sanitiser itself has only met
ordinary filenames; nothing hostile has arrived.*

An attachment filename is a string a stranger chose. It arrives RFC 2047
encoded, so the hostile version only exists *after* the parser decodes it.

The structural half of the answer: **storage keys are content hashes and never
contain a filename.**

```
att/{contentId}/{sha256(attachment bytes)}
```

Names live in D1 as display data. Hostile filenames are removed from the key
space entirely rather than being escaped out of it.

`src/mime.ts` additionally sanitises the stored name. It strips C0 controls and
DEL, then line separators and bidi marks, then `"` and `;`, and only then takes
the basename — in that order, and the order is the point. It previously ran the
basename strip *first*, using a regex that a line terminator anywhere earlier
in the name caused to not match at all, so `report.pdf<CRLF>/../../etc/passwd`
was stored with its path intact. A step that its own input can silently disable
has to run after that input is cleaned.

**Sanitisation is still not sufficient, and a consumer must not rely on it.**
Known to survive, because each needs the consumer to transform the name before
it becomes dangerous, and defending means guessing which transform:

- `report.pdf:evil.exe` — a Windows drive or alternate-data-stream separator.
- `%2e%2e%2fetc%2fpasswd` — anything that URL-decodes gets the traversal back.
- U+2044 and fullwidth solidus — become `/` under NFKC normalisation.
- Zero-width characters inside an otherwise all-dots name.
- `CON`, `NUL`, `PRN` — Windows reserved device names.

**The sanitiser cannot be finished, only improved.** The correct long-term
answer is to stop sanitising and escape at use: store the decoded name verbatim
and have each consumer encode for its own sink. That needs a consumer to exist
first.

**Anything that serves a download must do its own work.** Treat
`attachments.filename` as untrusted text:

- Never use it as a filesystem path or an object key. Use the content hash.
- Percent-encode it into `Content-Disposition: attachment; filename*=UTF-8''…`
  rather than interpolating it into a quoted parameter.
- **Do not serve attachments with `Content-Type` from `attachments.mime_type`.**
  That column is the sender's `Content-Type` header — the same untrusted string
  this list is about, and echoing it back is the stored-XSS path described
  below rather than a defence against it. An earlier version of this file
  recommended it, which was wrong.

  Serve a type *you* chose: `application/octet-stream` for anything you are not
  deliberately rendering, or a value derived from sniffing the bytes and
  matched against an allowlist. Always with `X-Content-Type-Options: nosniff`,
  and always from an origin that is not your application's — an
  attacker-supplied `text/html` attachment served same-origin is stored XSS
  against your inbox UI, whatever the header says.
- Treat `text_body` and `html_body` the same way. **The HTML body is
  attacker-authored HTML.** Nothing in this project sanitises it; storing it
  verbatim is deliberate, because sanitising on the way in destroys the
  archive's fidelity. Sanitise on the way out, or render in a sandboxed frame.

### What is not defended against

Stated so it is not mistaken for an oversight:

- **Spam, phishing, and malware.** Nothing is scored, filtered, or scanned.
  Everything addressed to a declared domain is stored. Filtering belongs in
  front of the worker.
- **Message content authenticity.** The edge's DMARC verdict is recorded as
  `contents.verified` and enforced for conversation-index writes. SPF and DKIM
  results are not recorded at all — one boolean is read out of the header and
  the rest is left in the raw bytes. Nothing else in the system treats a DMARC
  pass as a reason to trust the content. It is not.
- **Sender-claimed timestamps.** `Date` is unverified and can be anything.
  `received_at` is the only trusted ordering field.
- **Traffic analysis and volume.** There is no rate limiting. Anyone who knows
  an address can fill your R2 bucket at your expense.
- **Address enumeration through timing.** Unknown local parts are quarantined
  rather than rejected, which deliberately does not reveal which addresses
  exist — but no attempt is made to equalise timing.
- **Multi-tenancy.** There is none. Separate companies get separate
  deployments; there is no boundary inside one.
- **The read side.** There is no API, no UI, and no authentication or
  authorisation code in this repository, because there is nothing to
  authenticate against yet. Whoever builds the reader owns that entirely.

---

## What the operator is responsible for

This is **self-hosted**. It runs in your Cloudflare account, against your D1
database and your R2 bucket. There is no service and no third party — which
also means there is nobody else securing it.

- **The D1 database is the archive index.** Read access to it is read access to
  every subject line, every sender, and most message bodies. Scope the binding
  to the worker that needs it.
- **The R2 bucket holds the complete raw messages.** Every `.eml`, every
  attachment, verbatim. It must not be public. Content-addressed keys are not
  secret — they are derived from the bytes, and anyone holding a copy of a
  message can compute its key.
- **Cloudflare account access is the whole system.** Account or API-token
  compromise is total compromise: the mail archive, the routing configuration,
  and the worker code. Use scoped API tokens, and require MFA on the account.
- **Migrations run with your `wrangler` credentials**, from a person's machine
  or from CI, before deploy. That is deliberate — the worker never holds DDL
  rights. Protect whatever holds those credentials accordingly. (The command is
  `inbox-worker migrate --remote`, in `src/cli.ts`, and it shells out to
  `wrangler` so there is no second credential to provision. `migrate()` in
  `src/migrations.ts` is a test-harness affordance and must never be called
  from a handler.)
- **Configuration is code.** Inboxes and domains live in a TypeScript file, so
  changing who receives mail is a deploy. Review it like code.
- **A `Member` inbox's `owner` address should be external.** Configuration
  validation warns when it is on a domain this worker receives, because a login
  code mailed to an inbox you need the login code to read is a lockout.

### Retention is your problem, and it is an open question

**Raw messages are retained indefinitely.** Every message that arrives is
written to R2 in full and stays there. There is no expiry, no lifecycle rule,
and no deletion path — not for a message, not for a contact, not for a sender
who asks to be forgotten. Whether raw mail is kept forever is explicitly open
in the design document and has not been decided.

If you are subject to a retention limit or a data-subject deletion obligation,
this project does not help you meet it today. You would need to implement both
the R2 lifecycle policy and the D1 deletion yourself, and note that deleting a
`contents` row without its R2 objects, or the reverse, leaves the archive
inconsistent in a way nothing currently detects.

The same applies to encryption at rest beyond what Cloudflare provides by
default, to access logging, and to backups. None of them exist here.
