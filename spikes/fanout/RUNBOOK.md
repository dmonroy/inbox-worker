# Spike A — fan-out and byte identity

> **This is a spike. `spike/fanout` is a branch that never merges.**
>
> `CLAUDE.md`: *"Spike first to learn what the platform actually does, then
> delete the spike and TDD the real thing against what you learned. A spike
> that becomes the implementation is how unverified assumptions get shipped."*
>
> Everything in `spikes/` is deployed by hand to a throwaway zone, run once,
> read, and thrown away. Nothing in `src/` imports it, nothing in `test/`
> asserts on it, and CI does not know it exists. When the questions below are
> answered, the answers go into `DESIGN.md`, `PLAN.md` and `src/trace.ts`, and
> this directory is deleted along with the branch.

---

## Contents

- [What this settles, and why it is blocking](#what-this-settles-and-why-it-is-blocking)
- [Before you start](#before-you-start)
- [1. Enable Email Routing and point the catch-all at the worker](#1-enable-email-routing-and-point-the-catch-all-at-the-worker)
- [2. Deploy the spike](#2-deploy-the-spike)
- [3. Send one message with two RCPT TO](#3-send-one-message-with-two-rcpt-to)
- [4. Collect the output](#4-collect-the-output)
- [5. Exactly what to compare](#5-exactly-what-to-compare)
- [Worked examples — what each result looks like](#worked-examples--what-each-result-looks-like)
- [The memory question, and why it is a second message](#the-memory-question-and-why-it-is-a-second-message)
- [What each outcome means for the codebase](#what-each-outcome-means-for-the-codebase)
- [Recording the result](#recording-the-result)
- [Tear down](#tear-down)
- [What could not be determined without an account](#what-could-not-be-determined-without-an-account)

---

## What this settles, and why it is blocking

Two shipped decisions rest on an assumption nobody has measured.

**1. Fan-out is real.** `DESIGN.md` §4 says an Email Worker's `message.to` is a
*single* envelope recipient, so one email addressed to `sales@` *and*
`billing@` triggers **two separate invocations**. That claim carries a note in
the design itself: *"Load-bearing. Verify against current Email Routing docs
before implementing."* It is the reason `resolveTarget` is singular, the reason
`contents` and `messages` are two tables (§9), and the reason
`attachments.id` / `participants`' primary key are derived from `content_id`
(§9.1).

**2. The two invocations see byte-identical raw messages, apart from
per-delivery trace headers.** That is what makes `contentId` agree across them
and store one copy instead of two. `DESIGN.md` §4 again flags it: *"Unverified
— this is the first thing experiment 1 (§10) measures."* And `src/trace.ts`
says so in its own comment: the strip list is **provisional** until a real
fan-out is measured.

If either is false, fan-out dedup silently produces two `contents` rows for one
email — or, worse under (1), one of the two recipients never gets the message
at all.

This experiment is blocked on exactly one thing: **a Cloudflare zone with Email
Routing enabled.** Everything else is built. Working through this document
should take about twenty minutes.

---

## Before you start

You need:

- **A Cloudflare account** with a **spare domain on it**, nameservers already
  pointed at Cloudflare. Do not use a domain that receives real mail — the
  catch-all rule below swallows every address on the zone.
- **The Workers Paid plan.** `DESIGN.md` §5: the free plan's 10 ms CPU limit is
  not viable, and this spike SHA-256s the whole message twice. The small run
  may scrape through on free; the 24 MB run will not.
- **`wrangler`, authenticated.** It is already a dev dependency here:
  ```sh
  npx wrangler login
  npx wrangler whoami
  ```
- **`swaks`** — `brew install swaks`, `apt install swaks`. There is a by-hand
  SMTP fallback in step 3 if you cannot install it.
- **`jq`** for `report.sh`.
- **Outbound port 25**, or a submission server you can authenticate to. Home
  ISPs and every major cloud provider block port 25 outbound. Step 3 covers
  both.

Two commands' worth of sanity checking, both offline:

```sh
npx tsc -p spikes/fanout                                  # the spike compiles
npx wrangler deploy --dry-run -c spikes/fanout/wrangler.toml   # and bundles
```

---

## 1. Enable Email Routing and point the catch-all at the worker

**Order matters: deploy the worker first (step 2), then come back and set the
catch-all.** The routing rule can only select a Worker that already exists.

If you have not enabled Email Routing on the zone yet, do that part now — DNS
propagation is the slow step and it can happen while you deploy.

### Enable Email Routing

1. Cloudflare dashboard → **Compute** → **Email Service** → **Email Routing**.
2. **Onboard Domain**, pick the zone, review the records Cloudflare proposes,
   **Done**.

   It adds three things: **MX** records pointing at
   `route1/2/3.mx.cloudflare.net`, an **SPF** TXT record, and a **DKIM** TXT
   record. On a zone using Cloudflare DNS this is usually live in 5–15 minutes.

3. Confirm the MX is actually live before sending anything. This is the single
   most common way to lose half an hour:

   ```sh
   dig +short MX example.com
   # 24 route2.mx.cloudflare.net.
   # 79 route3.mx.cloudflare.net.
   # 20 route1.mx.cloudflare.net.
   ```

   No output means DNS has not propagated and the test message will bounce to
   whatever the old MX was, or nowhere.

### Point the catch-all at the worker

A **catch-all** rather than two individual address rules, because the
experiment needs two arbitrary local parts on one zone and a catch-all gives
you every local part for free.

1. **Email Routing** → **Routing rules** → **Catch-all address**.
2. **Action**: *Send to a Worker*.
3. **Destination**: `inbox-fanout-spike`.
4. **Save**, and make sure the rule is **enabled** — it is created disabled.

A Worker destination needs **no destination-address verification**. That
requirement applies to *forwarding* actions only; nothing here forwards.

<details>
<summary>Doing it over the API instead</summary>

```sh
curl -X PUT \
  "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/email/routing/rules/catch_all" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
        "name": "fan-out spike catch-all",
        "enabled": true,
        "matchers": [{ "type": "all" }],
        "actions":  [{ "type": "worker", "value": ["inbox-fanout-spike"] }]
      }'
```

**Unverified.** The field that names the Worker has changed shape across API
versions — current reference documentation shows an `owner_worker_tag`
alongside the action, while older examples use `actions[].value`. If the call
is rejected, use the dashboard; it is a one-time setup and not worth debugging.

</details>

---

## 2. Deploy the spike

```sh
npx wrangler deploy -c spikes/fanout/wrangler.toml
```

Confirm it is live without spending a test message on it — the worker answers
`fetch` as well as `email`, purely so this check exists:

```sh
curl https://inbox-fanout-spike.<your-subdomain>.workers.dev/
# inbox-worker fan-out spike. Send mail to two addresses on this zone, ...
```

### Strongly recommended: bind an R2 bucket first

Logs are capped at **256 KB per entry** and can be sampled away under load. A
25 MB message cannot go through them, and even a small one is a hash you have
to trust rather than bytes you can compare. With a bucket bound, every
invocation archives its raw message, and byte-identity is settled by `cmp` on
two files.

```sh
npx wrangler r2 bucket create inbox-fanout-spike
# then uncomment the [[r2_buckets]] block in spikes/fanout/wrangler.toml
npx wrangler deploy -c spikes/fanout/wrangler.toml
```

The worker deploys and works without it. It is the difference between *strong*
evidence and *proof*.

---

## 3. Send one message with two RCPT TO

**One message. Two `RCPT TO`. One SMTP transaction. Same zone.**

That is the whole experiment, and it is the part ordinary mail clients cannot
do: they hand the message to a submission server and you lose control of the
envelope. Sending two separate emails tests nothing — two messages produce two
invocations trivially, and their bytes differ for reasons that have nothing to
do with fan-out.

### With `swaks` (use this)

Start the tail **first**, in another terminal — see step 4. `wrangler tail` is
live-only and has no backlog.

```sh
./spikes/fanout/send.sh --zone example.com
```

Defaults to `spike-a@` and `spike-b@` on the zone, generates a dull plain-text
message with a unique `X-Spike-Run` correlation id, and prints the whole SMTP
dialogue with the DATA summarised.

**Read the dialogue.** Two `RCPT TO` lines, each answered `250`, is the first
half of the result: the edge accepted one message for two recipients. A `550`
or `452` on the second one is [outcome A3](#outcome-a--fan-out-does-not-happen).

Options that matter:

| Situation | Flag |
|---|---|
| Port 25 blocked outbound | `--server smtp.example.com:587` (swaks will prompt for auth) |
| Different local parts | `--to alpha,beta` |
| Your `--from` domain publishes SPF | pick a `--from` domain **without** SPF — see below |
| The memory run | `--size 24` |

**On the envelope sender.** Sending direct-to-MX from a host that is not in the
`--from` domain's SPF record produces `spf=fail`, and a failing SPF is the one
thing that can get the message quietly filtered — which looks *identical* to
"fan-out did not happen". Use a from-domain with **no SPF record at all**;
DMARC then reports `none` and nothing filters it. The default,
`spike@<your-zone>`, is fine only if the zone has no SPF record — and Email
Routing adds one when you enable it, so it usually is not. Override it.

### By hand, without `swaks`

`openssl s_client` rather than `nc`, because it sends CRLF (`-crlf`) and
Cloudflare's MX offers STARTTLS. Bare LF line endings are a protocol violation
that some receivers reject.

```sh
openssl s_client -connect route1.mx.cloudflare.net:25 -starttls smtp -crlf -quiet
```

Then type this. The two `RCPT TO` lines are the point; everything else is
scaffolding.

```
EHLO probe.example
MAIL FROM:<spike@nospf.example>
RCPT TO:<spike-a@example.com>
RCPT TO:<spike-b@example.com>
DATA
Message-ID: <fanout-manual-001@example.com>
X-Spike-Run: fanout-manual-001
From: Fan-out spike <spike@nospf.example>
To: spike-a@example.com, spike-b@example.com
Subject: inbox-worker fan-out spike
MIME-Version: 1.0
Content-Type: text/plain; charset=utf-8

manual fan-out spike
.
QUIT
```

The lone `.` on its own line ends DATA. Watch for `250` after each `RCPT TO`
and a single `250` after the `.` — one accept for two recipients.

---

## 4. Collect the output

Two channels. Use both; they fail in different ways.

**`wrangler tail` — live, must be running before you send.**

```sh
npx wrangler tail -c spikes/fanout/wrangler.toml --format json | tee /tmp/fanout.ndjson
```

`--format json` is not optional: `report.sh` reads the structured shape, and
the pretty format mangles long lines. `tee` because the terminal scrollback is
not a record.

**Workers Logs — retained, readable after the fact.** `[observability]` is
enabled in `wrangler.toml`, so if you sent before tailing, the run is still in
the dashboard under the Worker's **Logs** tab. It is the backstop for
"I forgot to start the tail", not the primary channel — there is no clean
export to feed `report.sh`.

**R2, if you bound the bucket.** The authoritative copy:

```sh
npx wrangler r2 object list inbox-fanout-spike --remote --prefix spike/
```

### What the worker emits

One JSON object per line, keys in a fixed order so two invocations diff
cleanly.

| `kind` | What it carries |
|---|---|
| `summary` | Everything scalar: `to`, `from`, `rawSize`, the three hashes, a per-header name/size/hash list, the memory probe, the ballast setting |
| `headers` | The verbatim header block, base64, chunked. `seq`/`of` reassemble it; `headerBlockSha256` in the summary verifies the reassembly |
| `archived` | The R2 prefix, when a bucket is bound |
| `error` | Something went wrong inside the spike. The handler never throws |

---

## 5. Exactly what to compare

```sh
./spikes/fanout/report.sh /tmp/fanout.ndjson
```

It groups by `X-Spike-Run`, prints both invocations side by side, and gives a
verdict. Nobody should have to eyeball two 64-hex strings.

If you would rather do it by hand, these are the four comparisons, in the order
that matters:

1. **How many invocations carry the same `run`?** Two is the expected answer.
   ```sh
   jq -r 'select(.kind=="summary") | "\(.run)\t\(.to)"' /tmp/fanout.ndjson
   ```

2. **Is `to` a plain string, one recipient each?** `toType` must be `string`
   and `toIsArray` must be `false`, with a *different* value per invocation.

3. **Do the two `contentId` values agree?** This is the experiment. It is the
   literal value production would write to `contents.id`; the spike computes it
   by calling the real `contentId()` and the real `stripTraceHeaders()` from
   `src/`, so there is no reimplementation between you and the answer.
   ```sh
   jq -r 'select(.kind=="summary") | .contentId' /tmp/fanout.ndjson | sort -u | wc -l
   # 1 = pass
   ```

4. **If they disagree, which headers differed?** `report.sh` prints this
   annotated against the current `TRACE_HEADERS`, so each differing header is
   marked *already stripped* or *NOT STRIPPED ← candidate*. The candidates are
   the finding.

Also worth a glance, because it is cheap and it feeds a different decision:
`authenticationResultsJoined` shows what `Headers.get()` returns for
`Authentication-Results`. `DESIGN.md` §8 asserts that repeats are joined with a
comma and that a substring test for `dmarc=pass` therefore matches a *forged*
header. This line is that assertion meeting reality.

**And if you bound the bucket, settle it with bytes:**

```sh
npx wrangler r2 object get inbox-fanout-spike/spike/<run>/<inv-1>.eml --file a.eml --remote
npx wrangler r2 object get inbox-fanout-spike/spike/<run>/<inv-2>.eml --file b.eml --remote
cmp a.eml b.eml
diff <(sed -n '1,/^$/p' a.eml) <(sed -n '1,/^$/p' b.eml)   # header blocks only
```

---

## Worked examples — what each result looks like

Abridged `report.sh` output. Hashes are illustrative.

### Pass

```
----------------------------------------------------------------------
RUN  fanout-20260726T120000Z-4821
INVOCATIONS  2
----------------------------------------------------------------------
  to                 spike-a@example.com   (typeof string, array false)
  rawSize/read       412 / 412
  sha256(raw)        30f5cfed…c8c290
  sha256(stripped)   e35658c0…6cffa0f
  contentId          c345cad6…3b9bc136
  header block       380 bytes, 11 headers, 2 Received
  memory reading     none — expected; the runtime has no memory API, use BALLAST_MB

  to                 spike-b@example.com   (typeof string, array false)
  rawSize/read       448 / 448
  sha256(raw)        d08a1c44…8bace17      <- different, as expected
  sha256(stripped)   e35658c0…6cffa0f      <- SAME
  contentId          c345cad6…3b9bc136     <- SAME
  header block       416 bytes, 12 headers, 3 Received

VERDICT
  PASS. Two invocations, one contentId.

  Against the current TRACE_HEADERS in src/trace.ts:
    delivered-to                     already stripped
    received                         already stripped
    authentication-results           already stripped
```

Read it as: two invocations happened, the raw bytes differed, everything that
differed is already stripped, and the id production keys on agrees. Go to
[outcome B](#outcome-b--fan-out-happens-and-the-hashes-match).

### Fan-out did not happen

```
RUN  fanout-20260726T120000Z-4821
INVOCATIONS  1

VERDICT
  !! ONE invocation for two recipients. Fan-out did not happen.
```

Before believing it, check the Email Routing delivery log in the dashboard: a
second delivery that the tail missed looks exactly like this. Then
[outcome A](#outcome-a--fan-out-does-not-happen).

### `message.to` is not a single recipient

```
  to                 spike-a@example.com,spike-b@example.com   (typeof string, array false)
INVOCATIONS  1

VERDICT
  !! `message.to` is NOT a plain string.
```

`toIsArray: true`, or one invocation whose `to` contains a comma. Also
[outcome A](#outcome-a--fan-out-does-not-happen), sub-case A2.

### Hashes differ after stripping

```
VERDICT
  FAIL. Two invocations, TWO different contentIds.

HEADERS THAT DIFFERED BETWEEN THE TWO DELIVERIES
--- delivery-1
+++ delivery-2
@@ -1,6 +1,6 @@
-received	312	55f0499fed211a00
-x-cf-delivery-id	42	7f8761ac98ce0166
+received	318	c731598bee19b6b2
+x-cf-delivery-id	42	9abbe16affe690bd

  Against the current TRACE_HEADERS in src/trace.ts:
    received                         already stripped
    x-cf-delivery-id                 NOT STRIPPED  <-- candidate
```

`x-cf-delivery-id` is the finding. Go to
[outcome C](#outcome-c--the-hashes-differ-after-stripping).

### The difference is in the body, not the headers

```
VERDICT
  FAIL, and NOT in the headers. Two invocations, two contentIds, but the two
  header blocks are byte-identical — so the difference is BELOW the blank
  line, in the body.
```

The nastiest result, and the one no strip list can fix. Outcome
[C.4](#c4-the-difference-is-in-the-body).

---

## The memory question, and why it is a second message

### The runtime exposes no memory reading. This was measured.

Against workerd (via miniflare) with `nodejs_compat` on, before this spike was
written:

| API | Result |
|---|---|
| `performance.memory` | absent |
| `performance.measureUserAgentSpecificMemory()` | absent |
| `process.memoryUsage()` | present, **every field `0`** |
| `v8.getHeapStatistics()` | present, **every field `0`** |

They are stubs. The worker still probes all of them and prints what it finds,
because reporting "no reading available" is the honest form of the answer and
because a future runtime may fill them in — but expect
`memory reading  none — expected`.

### So the measurement is a ballast ladder

`BALLAST_MB` makes the worker hold that many megabytes of touched memory
alongside the buffered message. If the invocation logs its summary, that much
headroom existed. If the isolate dies, it did not — and a dead isolate logs
nothing, so the evidence is the **`outcome`** field on the tail envelope, which
`report.sh` prints at the top:

```
INVOCATION OUTCOMES (from wrangler, not from the worker)
     2 exceededMemory
```

The ladder:

```sh
./spikes/fanout/send.sh --zone example.com --size 24     # BALLAST_MB=0 first

# then, per rung, edit [vars] BALLAST_MB in wrangler.toml and redeploy:
npx wrangler deploy -c spikes/fanout/wrangler.toml
./spikes/fanout/send.sh --zone example.com --size 24
```

Rungs: `0, 8, 16, 24, 32, 48, 64`. Stop at the first `exceededMemory`. The last
rung that logged a summary is the headroom, on top of a working set of roughly
`2 × rawSize` (the buffered raw plus the stripped copy `stripTraceHeaders`
allocates).

### Why a second message, and not the same one

Four reasons, and the first is decisive:

1. **A memory kill destroys the fan-out answer too.** A dead isolate logs
   nothing, so conflating the two questions means one failure costs both
   results.
2. **The two questions want different numbers of runs.** Fan-out is one send.
   The ballast ladder is five or six sends with a redeploy between each.
3. **A 24 MB message maximises everything that can go wrong with collection** —
   log sampling, the 256 KB entry cap, R2 write time — at exactly the moment
   the delicate read is the header diff.
4. **They can still share a message once each is understood.** Send the padded
   message to *both* addresses (`send.sh --size 24` does, by default), and the
   memory run doubles as a confirmation that byte-identity holds at 24 MB as
   well as at 400 bytes. That is a bonus on a question already answered, not
   the way to answer it the first time.

### One honest gap in the numbers

The spike does **not** run `postal-mime`. The real ingest path holds the raw
buffer, the parser's decoded parts, and a copy per R2 put — `DESIGN.md` §4.1
estimates 60–90 MB peak against a hard 128 MB. What the ladder measures is the
headroom above the *identity* path only, so treat the numbers as a **floor**.
`BALLAST_MB` is the stand-in for the parser, which is why the ladder is the
measurement rather than a single run.

---

## What each outcome means for the codebase

The most important section. Each outcome names what changes, and — following
the regression rule in `CLAUDE.md` — which test is written *first*.

---

### OUTCOME A — fan-out does not happen

The result that breaks the most. Three distinguishable sub-cases; the report
tells you which.

#### A1 — one invocation, `to` is one address, the other recipient got nothing

**This is mail loss**, and it is the most serious thing this experiment can
find. Stop and confirm against Email Routing's own delivery log before acting;
a missed tail looks the same.

If confirmed:

- **`DESIGN.md` §4 "Fan-out"** is wrong and must be rewritten, not patched. The
  whole `contents`/`messages` split (§9) exists to serve it.
- **The conflict is real and cannot be resolved in code.** Delivering to the
  second recipient would mean reading the `To`/`Cc` **headers** — and §7.1,
  PR #7, and `SECURITY.md` all say the target comes from the *envelope* and
  never from headers, precisely so a sender cannot name the inbox their message
  lands in. Recovering the second recipient reintroduces exactly that. Escalate
  it to `DESIGN.md` as an open question; do not quietly start reading `To`.
- **Delete the §12 fan-out fixture** (*"one message, two `message.to`"*). It
  asserts behaviour that does not exist, and a fixture that lies is worse than
  no fixture.
- `src/trace.ts` keeps its job — redeliveries and retries still need it — but
  the comment about fan-out becomes wrong and must be rewritten.

#### A2 — one invocation, `message.to` carries a list

`toIsArray: true`, or a `string` containing a comma.

- **`resolveTarget` must become plural.** `src/resolve.ts` takes
  `envelopeTo: string` and returns one `Resolution`; it becomes
  `resolveTargets(config, envelopeTo: string[]): Resolution[]`. §2.1 already
  discusses this shape and explains why it is currently singular — that
  reasoning inverts.
- **`messages` stays one row per inbox** and §9 survives intact. The fan-out
  loop just moves from the transport into the handler.
- **The identity story gets simpler, and `src/trace.ts` gets weaker.** With one
  invocation there is no second delivery to agree with, so `normalizedHash`
  would have no fan-out job left. It still earns its place for redelivery and
  replay, but "this is what lets fan-out dedup" (§4, `identity.ts`,
  `trace.ts`) stops being the reason and the comments must be corrected rather
  than left as a plausible-sounding lie.
- **Test first:** a `resolve.test.ts` case passing two envelope addresses and
  asserting two resolutions, red before the signature changes.

#### A3 — the second `RCPT TO` was refused

Visible in the swaks dialogue: a `450`/`550` on the second recipient.

Cloudflare does not accept multi-recipient transactions at all, so real senders
will split into two transactions. Functionally that still gives two
invocations — so §4's *structure* survives — but the byte-identity assumption
gets much weaker, because two transactions can differ upstream of Cloudflare in
ways one transaction cannot.

Re-run through a real submission server (`--server`) to see what an actual
sender produces, and treat the result as [outcome C](#outcome-c--the-hashes-differ-after-stripping)
if the hashes disagree.

---

### OUTCOME B — fan-out happens and the hashes match

The design is confirmed. Specific things stop being provisional:

1. **`src/trace.ts`, the comment above `TRACE_HEADERS`.** Replace the
   "Provisional… see spike A in PLAN.md" block with the measurement: the date,
   the zone's MX route, and the header names actually observed differing.
   Keep the "erring wide is safe" reasoning — it is still true, and it is why
   the list stays longer than the measurement strictly requires.

2. **`DESIGN.md` §4.** Delete the two hedges:
   - *"> Load-bearing. Verify against current Email Routing docs before
     implementing."*
   - *"> `normalizedHash` assumes the two fan-out invocations differ *only* in
     trace headers. Unverified…"*

   Replace with a one-line **DECIDED** note and the date. §10's experiment 1
   row moves to answered, next to Q2 and Q9.

3. **`PLAN.md`.** Spike A moves out of *Spikes* into *Done*, keeping only what
   is worth remembering — per `CLAUDE.md`, that is the result and any decision
   that would look arbitrary later.

4. **The §12 fan-out fixture becomes writable against a known shape**: one
   `contents` row, two `messages` rows, one raw R2 object.

5. **A test in `test/trace.test.ts`.** Add the observed header names to the
   `test.each` block in *"what gets removed"*. Note that this is a test you can
   only write *after* the measurement — before it, the names were a guess.

   > **Synthesise the fixture.** `CLAUDE.md`: *"Fixtures are synthesised, never
   > real mail. They are committed to a public repo."* A captured header block
   > carries your zone, your IPs, and Cloudflare's internal delivery ids. Take
   > the **names and the shape** from the capture and write the values by hand.

#### The sub-case worth catching: the raw bytes were identical too

`report.sh` says so explicitly. If `sha256(raw)` matched as well, then nothing
per-delivery was stamped on this route at all — so `stripTraceHeaders` was
never exercised, and the pass proves less than it appears to.

Do not narrow the strip list on this evidence. Send once more through a real
submission server, from a different provider, and see whether trace headers
appear. Then record the weaker claim honestly: *fan-out dedup holds; the strip
list remains defensive.*

---

### OUTCOME C — the hashes differ after stripping

Two `contents` rows for one email. `DESIGN.md` already calls this *"wasteful,
but not wrong"* — no message is lost and nothing is misrouted, so this is not
an emergency. It is a correctness gap with a clear repair path.

#### C.1 — decide which differing headers are genuinely per-delivery

`report.sh` prints every differing header marked *already stripped* or *NOT
STRIPPED ← candidate*. Do not add all the candidates reflexively. For each,
look at the two verbatim values in the header block diff and ask:

| Signal in the value | Verdict |
|---|---|
| Contains the envelope recipient (`message.to`) | **Per-delivery.** Strip it. |
| Contains a timestamp, a delivery id, a queue id, an edge hostname or IP | **Per-delivery.** Strip it. |
| Identical value, different **position** in the block | Not a strip-list problem — see C.3 |
| Differs for a reason you cannot explain | **Leave it.** Note it and send again. |

That last row is the one that matters. `trace.ts` is right that erring wide is
cheap — but only for headers that really are per-delivery. Stripping a header
that carries *message* content makes two genuinely different messages hash the
same, which merges one sender's mail into another's stored content. That is the
same class of mistake as the conversation merging §8 rejected, and it is worse:
there is no undo.

#### C.2 — the change, test first

Per the regression rule in `CLAUDE.md`, a failing test comes first, always.

1. Add the new name to the `test.each` list in the *"what gets removed"* block
   of `test/trace.test.ts`, with a **synthesised** value:

   ```ts
   test.each([
     // …existing…
     'X-CF-Delivery-Id: d-0000000000',   // measured differing per delivery, spike A
   ])('%s', (header) => { … })
   ```

2. `npm run test:watch`. **Watch it fail.** The failure should read as
   "expected the header to be gone, it is still there" — an assertion about
   behaviour, not a missing module.

3. Add the lowercased name to `TRACE_HEADERS` in `src/trace.ts`. Green.

4. If the new name is a prefix of, or prefixed by, an existing one, add a
   matching case to *"what survives"*. There is already one for
   `Receivedish`; exact-name matching is a decision worth re-pinning each time
   the list grows.

5. Record **why** in the comment above the list, not just the name. In six
   months "why is `x-cf-delivery-id` here" needs an answer better than "it was
   in a list".

#### C.3 — if the difference is header *order*, not header content

Same headers, same values, different sequence. No strip list fixes this.

Making `normalizedHash` order-insensitive means canonicalising the retained
headers — sorting them before hashing — which is a materially larger change
than a list edit, and it weakens identity: two messages differing *only* in
header order would become the same content. Do not do it as part of this fix.
Escalate to `DESIGN.md` §4 as a new open question with the evidence attached.

#### C.4 — the difference is in the body

`report.sh` calls this one out separately: identical `headerBlockSha256`,
different `strippedSha256`. The difference is below the blank line.

No header strip can reach it. Before concluding, check the R2 copies — this is
exactly why the bucket is worth binding:

```sh
cmp a.eml b.eml                     # prints the first differing byte offset
```

If the bodies genuinely differ per delivery, **fan-out dedup is not
achievable**, and the honest response is to accept it rather than engineer
around it:

- `DESIGN.md` §4 drops the claim that fan-out produces one `contents` row.
- §9's *"What one email produces"* table changes: two recipients means two
  `contents` rows and two `messages` rows.
- The §12 fixture asserting *one* `contents` row must be rewritten before it is
  ever written, not after.
- `src/trace.ts` keeps its narrower job — redelivery and replay idempotency —
  and its comment must stop claiming the fan-out benefit.

---

### OUTCOME D — the memory numbers

Read the last rung that logged a summary on a 24 MB message.

| Last surviving `BALLAST_MB` | What it means for `DESIGN.md` §5 |
|---|---|
| **0 fails** | The identity path alone does not fit. §4.1's 60–90 MB estimate is optimistic and the 25 MB inbound size is itself the problem. Escalate: the caps cannot fix this, only refusing large messages can — and §7.4 says we must not refuse. |
| **< 24** | The caps are **not** adequate. `total decoded attachment bytes` (20 MB) has less headroom than `postal-mime` needs; bring it down and re-derive it from this number rather than from the estimate. |
| **24–48** | The estimate was about right. The caps are load-bearing exactly as §5 says, and the margin is thin enough that the next cap change needs re-measuring. |
| **> 48** | §5 is conservative. Leave the caps alone anyway — they bound R2 puts, D1 rows and subrequests (§5, "two kinds of cap"), not just memory, and those limits do not move. |

In every case, record the measured number in §5 next to the estimate. An
estimate and a measurement disagreeing is worth keeping visible.

Also record, in §5's table or a footnote: **the Workers runtime exposes no
memory API.** That is a platform fact worth writing down once so nobody spends
an afternoon looking for one, and the `wrangler.toml` comment and this runbook
should not be the only places it lives.

---

## Recording the result

The spike is deleted; the knowledge is not. Before tearing anything down:

1. Save the report output somewhere durable — the PR body for whatever change
   follows, or the `PLAN.md` entry.
2. **Scrub it first.** It contains your zone, your addresses, Cloudflare's edge
   IPs and internal ids. `CLAUDE.md`'s fixture rule exists because this repo is
   public.
3. Make the `DESIGN.md` and `PLAN.md` edits named in the outcome above **on a
   normal branch**, not on `spike/fanout`. This branch never merges.

---

## Tear down

In this order. Leaving a catch-all pointed at a deleted worker means every
address on the zone bounces.

```sh
# 1. Dashboard: Email Routing -> Routing rules -> disable/delete the catch-all.
# 2. Then the worker.
npx wrangler delete -c spikes/fanout/wrangler.toml

# 3. The bucket, if you made one.
npx wrangler r2 object delete inbox-fanout-spike/spike/... --remote   # per object
npx wrangler r2 bucket delete inbox-fanout-spike

# 4. Optionally, disable Email Routing on the zone and remove the MX records.
```

Then delete the branch. `CLAUDE.md`: *"Spikes are branches that never merge."*

---

## What could not be determined without an account

Written down because the next person will otherwise re-derive it. Every item
here is an **assumption this spike is designed to survive being wrong about**.

| Unknown | What was assumed, and why |
|---|---|
| **Whether one message with two `RCPT TO` produces two invocations** | Nothing in current Cloudflare documentation states the invocation model for multi-recipient transactions — not the Email Workers page, not the handler reference, not the limits page. Assumed two, because `message.to` is typed and documented as *"Recipient email address (envelope RCPT TO)"*, singular. **This is the experiment.** The report detects every alternative rather than assuming this one. |
| **Whether Cloudflare's MX accepts multiple `RCPT TO` at all** | Assumed yes; it is ordinary SMTP. If not, the swaks dialogue shows it immediately and the runbook covers it as outcome A3. |
| **Which per-delivery headers Cloudflare actually stamps** | Assumed the list in `src/trace.ts`, which was derived from RFC 5321/5322/8617 practice rather than from Cloudflare. See the prediction below. |
| **Whether a Worker catch-all destination needs a verified address** | Assumed **no** — verification is documented for *forwarding* destinations, and nothing here forwards. If the dashboard demands one, verify any address you control; it does not affect the measurement. |
| **The exact catch-all API body** | The reference shows `owner_worker_tag`; older examples use `actions[].value`. Flagged inline as unverified, with the dashboard as the reliable path. |
| **Whether `wrangler tail` reliably delivers both invocations** | Assumed yes at a volume of two. Sampling is documented for high-traffic Workers. R2 archiving exists as the channel that does not depend on this. |
| **Whether the 256 KB log cap applies per `console.log` or per invocation** | Documented as *"a single log has a maximum size limit of 256 KB"*, with a `$cloudflare.truncated` marker. Assumed per entry. The worker chunks at 16 KB regardless — an order of magnitude of margin, and the reassembly is hash-verified so a silent truncation cannot pass as a match. |
| **Whether `process.memoryUsage()` returns real numbers in production** | **Measured locally against workerd: it returns zeros.** Assumed production matches, since it is the same runtime. The worker prints whatever it gets rather than asserting, so if production differs you will see it. |

### A prediction, so it can be wrong on the record

Against RFC practice and how other providers behave, the current strip list
looks close to right, with two likely gaps.

**What it gets right.** `received` is the certain one: every hop prepends
another, and with two deliveries there is no reason the counts or contents
match. `delivered-to` and `return-path` are per-envelope-recipient by
definition. `authentication-results` and the three `arc-*` headers are stamped
by the authenticating hop and, on a receiver that runs authentication once per
delivery, can differ in the `authserv-id`, the timestamp, or the `i=` counter.
`received-spf` and `x-received` are the same class.

**The likely gap: a Cloudflare-specific header.** Most receivers stamp
something proprietary — Google adds `X-Google-Smtp-Source` and
`X-Gm-Message-State`, Microsoft adds a family of `X-MS-Exchange-*` and
`X-Forefront-*` headers. Cloudflare plausibly stamps something like
`X-Cloudflare-*` or a delivery/queue id, and a prefix like that is precisely
what an exact-name match (correctly) will not catch. **If this experiment
finds anything, I predict it is one header of that shape.**

**The second gap: `dkim-signature` is not in the list, and should stay out.**
It is written by the *sender*, not per delivery, so it is genuinely message
content — but if a hop re-signs, it becomes a false difference. Watch for it in
the report; if it appears, it is the hardest judgement call on the list, and
outcome C.1's rule says leave it and send again rather than strip it.

**Least likely to be an issue.** A body difference (C.4) or a header-order
difference (C.3). Nothing about SMTP relaying suggests either, but they are the
two results that would cost the most to discover after the handler shipped,
which is why the report detects them by name rather than lumping them into a
generic failure.

**Overall prediction: outcome B, with `received`, `delivered-to`,
`authentication-results` and `received-spf` observed differing, all already
stripped — and a modest chance of one unlisted `x-*` header turning outcome B
into outcome C.**
