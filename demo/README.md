# inbox-worker demo

The smallest real consumer of the package: three inboxes, one email channel,
one `export default`. All of it is [`src/index.ts`](src/index.ts) — the rest of
this directory is deployment plumbing.

It depends on the package as `file:..`, so it resolves through the published
`exports` map exactly as an outside project would.

## What each step needs

Nothing here needs a domain until step 7, and nothing needs a Cloudflare
account at all until step 3.

| Steps | Needs |
|---|---|
| 1–2, and `npm run db:migrate:local` | Node 22 only. No account, no login. |
| `npx wrangler deploy --dry-run` | Node 22 only. Proves the config compiles. |
| 3–6 | A Cloudflare account on the Workers **paid** plan, and `wrangler login`. |
| 7–8 | A domain on Cloudflare with Email Routing enabled. |

The paid plan is not optional for real traffic: the free tier's 10 ms CPU limit
is below what parsing a multi-megabyte email costs.

## 1. Build the package first

**This is a prerequisite, not a nicety.** `file:..` symlinks the parent
directory, and the parent's `exports` map points at `dist/`, which is generated
and git-ignored. Nothing builds it for you — npm does not run a dependency's
`prepare` script for a symlinked local path.

From the repository root:

```sh
npm install
npm run build
```

If you skip it, you get one of three errors, none of which mentions the build:

| Command | What you see |
|---|---|
| `npm run typecheck` | `Cannot find module 'inbox-worker' or its corresponding type declarations.` |
| `wrangler deploy` | `Could not resolve "inbox-worker"` … `The module "./dist/index.js" was not found` |
| `npm run db:migrate` | `sh: inbox-worker: command not found` |

The third is the nasty one. npm creates the `inbox-worker` bin link only if
`dist/cli.js` exists **at install time**, and it says nothing when it doesn't.
Building afterwards does not repair it — you have to install again:

```sh
cd demo && npm install
```

## 2. Install the demo

```sh
cd demo
npm install
```

Check it resolved:

```sh
npx wrangler deploy --dry-run
```

That bundles the worker and prints the bindings it would get. It reaches
Cloudflare for nothing, so it works logged out — which makes it the cheapest
proof that the config is deployable.

## 3. Create the database and the bucket

```sh
npx wrangler d1 create inbox-worker-demo
npx wrangler r2 bucket create inbox-worker-demo
```

The D1 command prints a `database_id`. Paste it into `wrangler.toml`, replacing
the all-zeros placeholder. The bucket needs nothing pasted anywhere — R2
bindings resolve by name.

The binding names themselves — `INBOX_DB` and `INBOX_BUCKET` — are convention
and are how the package finds them. Rename either and the worker cannot find
it. (`inbox-worker migrate --binding NAME` exists for the D1 one; the R2 one
has no override.)

## 4. Point it at a domain you own

In `src/index.ts`, replace `example.com` and the `example.org` alias. Aliases
share one inbox space, so `support@` at either domain reaches `support`.

Leave `ada`'s `owner` on a domain this worker does **not** receive. If you put
it on your own domain the package warns at boot, because an address that only
this inbox can read is a lockout waiting for the day something mails a login
code to it.

## 5. Apply the schema

```sh
npm run db:migrate:local   # the miniflare database under .wrangler/
npm run db:migrate         # the real one. No --remote to remember; this is it.
```

The package owns the schema and no SQL is copied here. `inbox-worker migrate`
reads `wrangler.toml` for the `INBOX_DB` binding and shells out to
`wrangler d1 execute`, so it uses the login you already have.

Every statement is safe to re-run and the version is written last, so a
migration interrupted partway is repaired by running it again.

## 6. Deploy

```sh
npm run deploy
```

That is `db:migrate && wrangler deploy`, in that order on purpose: the schema
is briefly ahead of the code, which is harmless, rather than briefly behind it,
which is not.

## 7. Route mail to it

Dashboard only — there is no wrangler command for this.

1. Your zone → **Email** → **Email Routing** → enable, and add the MX records
   it asks for. Wait for them to verify.
2. **Routing rules** → **Catch-all address** → action **Send to a Worker** →
   pick `inbox-worker-demo` → save.

A catch-all is right rather than one rule per address: the worker already
decides which inbox an address belongs to, and unknown local parts go to the
built-in `quarantine` inbox instead of bouncing.

One rule per zone. An alias domain is a second zone and needs its own.

## 8. Send something, then look

```sh
npx wrangler d1 execute INBOX_DB --remote --command \
  "SELECT m.inbox_key, m.target, c.subject
     FROM messages m JOIN contents c ON c.id = m.content_id
    ORDER BY m.received_at DESC LIMIT 10"
```

If a message arrived but no row did, ingest failed after the raw bytes were
already safe in R2 — by design, the handler never throws on the mail path:

```sh
npx wrangler d1 execute INBOX_DB --remote --command \
  "SELECT stage, error, raw_r2_key FROM failed_ingest ORDER BY last_seen DESC"
```

The raw `.eml` is in R2 under `demo/raw/email/…` — the `demo/` comes from
`INBOX_PREFIX` in `wrangler.toml`, which exists so several deployments can
share one bucket.

## Tearing it down

```sh
npx wrangler delete
npx wrangler r2 bucket delete inbox-worker-demo
npx wrangler d1 delete inbox-worker-demo
```

Remove the Email Routing catch-all rule too, or mail keeps arriving at a worker
that is no longer there.
