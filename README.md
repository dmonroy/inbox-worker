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

