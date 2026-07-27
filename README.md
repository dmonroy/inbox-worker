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

