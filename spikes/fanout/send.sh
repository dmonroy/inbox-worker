#!/usr/bin/env bash
#
# SPIKE. `spike/fanout` is a branch that never merges. See RUNBOOK.md.
#
# Send ONE message with TWO `RCPT TO` on the same zone, in a single SMTP
# transaction. The single-transaction part IS the experiment: two separate
# sends are two messages and prove nothing about fan-out.
#
# Almost no mail client will do this on demand — they hand the message to a
# submission server and you lose the envelope. `swaks` speaks the transaction
# directly, which is why it is the tool here. RUNBOOK.md has the by-hand
# `openssl s_client` dialogue for when you cannot install it.
#
#   ./spikes/fanout/send.sh --zone example.com
#   ./spikes/fanout/send.sh --zone example.com --size 24
#
set -euo pipefail

ZONE=""
LOCALS="spike-a,spike-b"
FROM=""
SERVER=""
SIZE_MB=0
RUN_ID=""
KEEP=""

die() { printf 'send.sh: %s\n' "$1" >&2; exit 1; }

usage() {
  cat >&2 <<'USAGE'
Usage: send.sh --zone <domain> [options]

  --zone <domain>  Required. The Cloudflare zone with Email Routing enabled.
  --to <a,b>       Local parts, comma separated. Default: spike-a,spike-b
                   TWO of them, on the SAME zone. That is the experiment.
  --from <addr>    Envelope MAIL FROM. Default: spike@<zone>
                   Prefer a domain with NO SPF record: DMARC then reports
                   "none" and nothing filters the message. Publishing SPF and
                   then failing it is the one case that gets a message quietly
                   dropped, which looks identical to "fan-out did not happen".
  --server <host>  SMTP server, "host" or "host:port". Default: the zone's MX,
                   resolved by swaks. Point this at a submission server
                   (smtp.example.com:587) if outbound port 25 is blocked —
                   it is on most home ISPs and nearly every cloud provider.
  --size <MB>      Pad with a base64 attachment to roughly this many MB.
                   Default 0, a small message. Use 24 for the memory run: the
                   inbound limit is 25 MiB and going over gets the message
                   refused at the edge rather than measured.
  --run <id>       Override the X-Spike-Run correlation id.
  --keep           Leave the generated .eml on disk and print its path.
USAGE
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --zone)   ZONE="${2:-}"; shift 2 ;;
    --to)     LOCALS="${2:-}"; shift 2 ;;
    --from)   FROM="${2:-}"; shift 2 ;;
    --server) SERVER="${2:-}"; shift 2 ;;
    --size)   SIZE_MB="${2:-}"; shift 2 ;;
    --run)    RUN_ID="${2:-}"; shift 2 ;;
    --keep)   KEEP=1; shift ;;
    -h|--help) usage ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$ZONE" ] || usage
case "$SIZE_MB" in ''|*[!0-9]*) die "--size takes whole megabytes" ;; esac
[ "$SIZE_MB" -le 24 ] || die "--size above 24 exceeds the 25 MiB inbound limit"

command -v swaks >/dev/null 2>&1 || die \
  "swaks not found (brew install swaks / apt install swaks). RUNBOOK.md has the by-hand SMTP dialogue."

[ -n "$FROM" ] || FROM="spike@${ZONE}"
[ -n "$RUN_ID" ] || RUN_ID="fanout-$(date -u +%Y%m%dT%H%M%SZ)-$$"

# One comma-separated list, so swaks issues both RCPT TO inside a single
# transaction. Splitting this into two swaks calls tests nothing.
RCPTS=""
OLD_IFS="$IFS"; IFS=','
for local_part in $LOCALS; do
  [ -n "$local_part" ] || continue
  RCPTS="${RCPTS:+$RCPTS,}${local_part}@${ZONE}"
done
IFS="$OLD_IFS"

case "$RCPTS" in
  *,*) : ;;
  *) die "need at least two recipients on the same zone; got '$RCPTS'" ;;
esac

EML="$(mktemp -t fanout-spike)"
[ -n "$KEEP" ] || trap 'rm -f "$EML"' EXIT

BOUNDARY="spike-boundary-${RUN_ID}"

# LF only, on purpose: swaks works in terms of "\n" and emits CRLF on the
# wire. Writing CRLF here risks a doubled CR, which would be a difference the
# report attributes to Cloudflare when it came from this script.
#
# The message is deliberately dull. We are comparing two deliveries of the
# SAME bytes, so anything interesting in the message is noise — every
# difference the report finds should be something Cloudflare did.
{
  printf 'Message-ID: <%s@%s>\n' "$RUN_ID" "$ZONE"
  printf 'X-Spike-Run: %s\n' "$RUN_ID"
  printf 'Date: %s\n' "$(date -u '+%a, %d %b %Y %H:%M:%S +0000')"
  printf 'From: Fan-out spike <%s>\n' "$FROM"
  # `To` lists both, matching the envelope. The real handler must never read
  # this — the target comes from the envelope (§7.1) — but a mismatch would
  # make the capture confusing to read back in six months.
  printf 'To: %s\n' "$(printf '%s' "$RCPTS" | sed 's/,/, /g')"
  printf 'Subject: inbox-worker fan-out spike %s\n' "$RUN_ID"
  printf 'MIME-Version: 1.0\n'

  if [ "$SIZE_MB" -gt 0 ]; then
    printf 'Content-Type: multipart/mixed; boundary="%s"\n' "$BOUNDARY"
    printf '\n'
    printf -- '--%s\n' "$BOUNDARY"
    printf 'Content-Type: text/plain; charset=utf-8\n\n'
    printf 'Fan-out spike, padded. See spikes/fanout/RUNBOOK.md.\n'
    printf -- '--%s\n' "$BOUNDARY"
    printf 'Content-Type: application/octet-stream\n'
    printf 'Content-Disposition: attachment; filename="ballast.bin"\n'
    printf 'Content-Transfer-Encoding: base64\n\n'
    # base64 inflates by 4/3, and folding to 76 columns then converting to
    # CRLF on the wire adds another ~2.6%. 7/10 rather than the naive 3/4
    # leaves room for both: overshooting 25 MiB gets the message refused at
    # the edge, which measures nothing and looks like a deploy problem.
    head -c "$(( SIZE_MB * 1024 * 1024 * 7 / 10 ))" /dev/urandom \
      | base64 | tr -d '\n' | fold -w 76
    printf '\n'
    printf -- '--%s--\n' "$BOUNDARY"
  else
    printf 'Content-Type: text/plain; charset=utf-8\n'
    printf '\n'
    printf 'Fan-out spike. See spikes/fanout/RUNBOOK.md.\n'
  fi
} > "$EML"

BYTES=$(wc -c < "$EML" | tr -d ' ')
LINES=$(wc -l < "$EML" | tr -d ' ')
# swaks sends CRLF, so every LF here becomes two bytes on the wire. That
# difference is a third of a megabyte on a padded message and is the reason a
# naive 24 MB file gets refused by a 25 MiB limit.
WIRE=$(( BYTES + LINES ))

printf 'run id      %s\n' "$RUN_ID"
printf 'recipients  %s\n' "$RCPTS"
printf 'envelope    MAIL FROM:<%s>\n' "$FROM"
printf 'message     %s bytes on disk, ~%s on the wire (limit 26214400)\n' \
  "$BYTES" "$WIRE"
if [ -z "$SERVER" ]; then
  printf 'server      (swaks will resolve the MX for %s)\n' "$ZONE"
  printf '            expect route[123].mx.cloudflare.net — check with:\n'
  printf '            dig +short MX %s\n' "$ZONE"
else
  printf 'server      %s\n' "$SERVER"
fi
[ -n "$KEEP" ] && printf 'kept at     %s\n' "$EML"
printf '\n'

# --suppress-data summarises the DATA portion instead of echoing 24 MB of
# base64. Everything else stays visible, because seeing TWO `RCPT TO` lines
# each answered 250 is the first half of the result.
set -- --to "$RCPTS" --from "$FROM" --data "@$EML" --suppress-data --timeout 300
[ -n "$SERVER" ] && set -- "$@" --server "$SERVER"

swaks "$@"

cat <<EOF

Sent. Two "RCPT TO" lines above, both answered 250, means the edge accepted
one message for two recipients. Whether that becomes two invocations is what
the tail now shows.

  npx wrangler tail -c spikes/fanout/wrangler.toml --format json | tee /tmp/fanout.ndjson
  ./spikes/fanout/report.sh /tmp/fanout.ndjson

Run id: $RUN_ID
EOF
