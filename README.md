# inbox-worker

> **Early development.** The foundation is being built. No releases yet, and
> the API changes without warning.

A serverless multichannel inbox for Cloudflare Workers.

It receives inbound messages, routes each to a named inbox — a team such as
`sales` or `support`, or an individual — stores the message and its attachments
durably, and groups related messages into conversations.

Email is the foundation channel and the first one to be built. The model is
designed so other inbound channels can be added without reshaping the data.

**Self-hosted.** It runs in your own Cloudflare account, against your own
database and object storage. There is no service and no third party.

## Requirements

- A domain on Cloudflare with Email Routing enabled
- Cloudflare D1 and R2
- A Workers **paid** plan — the free tier's CPU limit is too low to parse
  a large message

## Usage

`inbox()` returns a worker. Declare who receives and how things arrive, and
export it:

```ts
import { Email, inbox, Member, Team } from 'inbox-worker'

export default inbox({
  inboxes: {
    sales: Team('Sales'),
    support: Team('Support'),
    darwin: Member('Darwin Monroy', { owner: 'darwin@gmail.com' }),
  },
  channels: [Email({ domain: 'mycompany.com', aliases: ['mycompany.dev'] })],
})
```

Bind an R2 bucket as `INBOX_BUCKET` and a D1 database as `INBOX_DB`, point an
Email Routing catch-all rule at the worker, and mail to `sales@mycompany.com`
lands in the `sales` inbox. Anything matching no inbox goes to a built-in
`quarantine` inbox rather than bouncing — a permanent SMTP rejection would lose
the message, and an unknown address is not a good enough reason for that. Mail
for a domain no channel declares *is* refused, because that means a zone is
pointed here by mistake.

[`demo/`](demo) is that worker, deployable: three inboxes, one channel, and a
README that goes from an empty account to receiving mail.

If you already export a worker of your own, `handlers(config)` gives you the
same `email` and `scheduled` handlers to mount inside it. Mount both — the
second one is what drains a failed message, and a worker with only `email` is
safe but never recovers. Set `INBOX_PREFIX` to scope R2 keys when two
deployments share one bucket.

### Threading and DMARC

Conversations are inferred from `In-Reply-To` and `References`, which senders
write and can therefore lie about. A message may always *join* a thread already
known, but only a DMARC-passing message may claim an id nobody has received —
otherwise `References: <id-I-expect-you-to-get>` is a way to capture someone
else's future mail.

That check reads the `Authentication-Results` header your receiving edge
stamps, identified by its `authserv-id`, and defaults to Cloudflare Email
Routing's. If mail reaches this worker through anything else, say so:

```ts
Email({ domain: 'mycompany.com', authservId: 'mx.example.net' })
```

Getting it wrong fails closed — nothing is trusted that should not be, and the
symptom is a thread that occasionally splits in two.

## When ingest fails

The email handler never throws. An unhandled exception in an Email Worker makes
Cloudflare return 521 after DATA — a *permanent* error — so the sending server
bounces to its author and never retries. A crash on this path is not an error,
it is mail loss, and since a crafted message can reach the parser it would also
be a way for anyone to drop a thread on purpose.

So the raw bytes go to R2 first, and everything after that is wrapped: a
failure records a `failed_ingest` row naming the object, the envelope
recipient, the stage, and the error, and the handler returns success. Nothing
is lost, but nothing is delivered either until something replays it.

That something is a **cron trigger**. Add one:

```toml
[triggers]
crons = ["*/10 * * * *"]
```

Each run takes up to ten dead letters, re-reads the raw bytes from R2, and puts
them back through the same pipeline live mail uses. A message that stores
successfully has its row deleted; one that fails again has `attempts`
incremented and goes to the back of the queue. After ten attempts a row is
**parked** — skipped, never deleted, because it is the only pointer to the raw
object. Fix the cause, then `UPDATE failed_ingest SET attempts = 0` to let it
back in.

Replay is idempotent, so a row whose message already got through another way
costs nothing: identity is derived from the bytes, and every insert collides
with what is already there. It also replays with the *original* arrival time
and re-resolves routing against your current config — so mail that quarantined
because an inbox did not exist yet lands in that inbox once you add it.

**Without a cron trigger the handler is still safe**, it just never recovers:
the backlog grows and you drain it by hand. Check it with

```sh
npx wrangler d1 execute INBOX_DB --remote --command \
  "SELECT stage, attempts, error, raw_r2_key FROM failed_ingest ORDER BY last_seen DESC"
```

There is no `inbox-worker replay` command and there will not be one. The CLI
shells out to `wrangler d1 execute --command`, which has no bound parameters,
and replaying means writing a subject, a body, and a filename a stranger chose
into a dozen rows — building that SQL by string interpolation is an injection
hole, and a second implementation of every write is a second thing to keep
correct. The cron handler is the same code path as live ingest, with real
bindings and no new credential.

## Migrations

The package owns the schema; no SQL is copied into your repo. Applying it is a
local command, and **never something the worker does at runtime** — migrating
from inside a request would put schema changes on the path that receives your
mail, racing every isolate that started at the same time.

Wire it up once:

```json
{
  "scripts": {
    "db:migrate":       "inbox-worker migrate --remote",
    "db:migrate:local": "inbox-worker migrate --local",
    "deploy":           "npm run db:migrate && wrangler deploy"
  }
}
```

Migrate before you deploy, so the schema is never behind the code that expects
it. The unqualified `db:migrate` is the one that touches production, on purpose
— the safer command should not be the one you have to remember to type.

`inbox-worker migrate` takes no arguments beyond the target. It finds your
database through the `INBOX_DB` binding in your own `wrangler.toml` and runs
through `wrangler`, so it uses the credentials you already have — there is no
API token to create. Pass `--binding NAME` if you named the binding something
else.

Every statement is safe to re-run and the version is recorded last, so a
migration interrupted partway is repaired by running it again.

