#!/usr/bin/env bash
#
# SPIKE. `spike/fanout` is a branch that never merges. See RUNBOOK.md.
#
# Turn a captured `wrangler tail --format json` stream into a verdict.
#
# The point of this script is that nobody should have to eyeball two 64-hex
# strings and decide whether they are equal. It prints, in order: how many
# invocations one message produced, whether the `contentId` production would
# write agrees across them, and — when it does not — exactly which headers
# differed, which is the list `src/trace.ts` has to grow.
#
#   npx wrangler tail -c spikes/fanout/wrangler.toml --format json | tee /tmp/fanout.ndjson
#   ./spikes/fanout/report.sh /tmp/fanout.ndjson
#
set -euo pipefail

FILE="${1:-}"
[ -n "$FILE" ] && [ -r "$FILE" ] || {
  printf 'Usage: report.sh <captured-tail.ndjson>\n' >&2
  exit 2
}
command -v jq >/dev/null 2>&1 || {
  printf 'report.sh: jq is required\n' >&2
  exit 2
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

# The live strip list, read out of src/trace.ts rather than copied here, so
# this report cannot drift from the thing it is judging. Without it every
# differing header looks like a finding, when most of them are already
# handled and only the leftovers matter.
: > "$TMP/stripped"
TRACE_TS="$SCRIPT_DIR/../../src/trace.ts"
if [ -r "$TRACE_TS" ]; then
  sed -n '/const TRACE_HEADERS = new Set(\[/,/^\])/p' "$TRACE_TS" \
    | grep -oE "'[a-z0-9-]+'" | tr -d "'" | sort -u > "$TMP/stripped" || true
fi

b64d() {
  # macOS ships -D, GNU coreutils ships -d, newer macOS accepts both.
  base64 --decode 2>/dev/null || base64 -D
}

rule() { printf '%s\n' '----------------------------------------------------------------------'; }

# --- extraction --------------------------------------------------------------
#
# Accepts either shape, because both happen in practice: `wrangler tail
# --format json` wraps our lines inside `.logs[].message[]`, while a hand-
# copied line or a Workers Logs export may hold them bare. Pulling every
# string anywhere in the input and keeping the ones that are our JSON handles
# both without asking the operator which they have.
{
  jq -c 'select(.spike? == "fanout")' "$FILE" 2>/dev/null || true
  jq -r '.. | strings' "$FILE" 2>/dev/null \
    | grep -F '"spike":"fanout"' \
    | jq -c '.' 2>/dev/null || true
} | awk '!seen[$0]++' > "$TMP/lines.ndjson"

LINES=$(wc -l < "$TMP/lines.ndjson" | tr -d ' ')
if [ "$LINES" = "0" ]; then
  cat >&2 <<'EOF'
report.sh: no spike lines found.

Nothing arrived, or the tail was not running when it did. Check, in order:

  1. Is the worker actually deployed and wired to the catch-all rule?
       curl https://inbox-fanout-spike.<your-subdomain>.workers.dev/
  2. Was `wrangler tail` connected before the message was sent? It streams
     live and has no backlog. Workers Logs in the dashboard does — use that
     if you sent first and tailed second.
  3. Did the message reach Cloudflare at all? Email Routing keeps a delivery
     log in the dashboard.
EOF
  exit 1
fi

# Outcomes are on the wrangler envelope, not on our lines, and they are the
# only place a memory kill shows up: a dead isolate logs nothing.
if jq -e 'has("outcome")' "$FILE" >/dev/null 2>&1; then
  rule
  printf 'INVOCATION OUTCOMES (from wrangler, not from the worker)\n'
  jq -r 'select(has("outcome")) | .outcome' "$FILE" | sort | uniq -c \
    | sed 's/^/  /'
  printf '\n  "ok" throughout is what you want. "exceededMemory" is the memory\n'
  printf '  answer arriving as a crash; "exceededCpu" means the ballast loop is\n'
  printf '  too slow rather than too big.\n'
fi

# --- per run -----------------------------------------------------------------

jq -r 'select(.kind == "summary") | .run' "$TMP/lines.ndjson" | sort -u \
  > "$TMP/runs"

while IFS= read -r RUN; do
  [ -n "$RUN" ] || continue

  jq -c --arg r "$RUN" 'select(.kind == "summary" and .run == $r)' \
    "$TMP/lines.ndjson" > "$TMP/summaries"
  COUNT=$(wc -l < "$TMP/summaries" | tr -d ' ')

  printf '\n'; rule
  printf 'RUN  %s\n' "$RUN"
  printf 'INVOCATIONS  %s\n' "$COUNT"
  rule

  jq -r '
    "  to                 \(.to)   (typeof \(.toType), array \(.toIsArray))",
    "  from               \(.from)",
    "  rawSize/read       \(.rawSize) / \(.rawBytesRead)",
    "  sha256(raw)        \(.rawSha256)",
    "  sha256(stripped)   \(.strippedSha256)",
    "  contentId          \(.contentId)",
    "  header block       \(.headerBlockBytes) bytes, \(.headers | length) headers, \(.receivedHeaderCount) Received",
    "  ballast            \(.ballastMb) MB (witness \(.ballastWitness))",
    "  auth-results       \(.authenticationResultsJoined // "(none)")",
    "  memory reading     \(if .memory.available then (.memory | del(.note) | tostring) else "none — expected; the runtime has no memory API, use BALLAST_MB" end)",
    ""
  ' "$TMP/summaries"

  # Per-invocation artefacts: the header-name/hash list, and the reassembled
  # verbatim block.
  jq -r '.invocation' "$TMP/summaries" > "$TMP/invocations"
  N=0
  while IFS= read -r INV; do
    N=$((N + 1))
    jq -r --arg i "$INV" '
      select(.kind == "summary" and .invocation == $i)
      | .headers[] | "\(.name)\t\(.bytes)\t\(.sha)"
    ' "$TMP/lines.ndjson" > "$TMP/names.$N"

    jq -r --arg i "$INV" '
      select(.kind == "headers" and .invocation == $i) | "\(.seq)\t\(.b64)"
    ' "$TMP/lines.ndjson" | sort -n | cut -f2- | tr -d '\n' | b64d \
      > "$TMP/block.$N" || : > "$TMP/block.$N"
  done < "$TMP/invocations"

  # --- the verdict -----------------------------------------------------------

  UNIQUE_CONTENT=$(jq -r '.contentId' "$TMP/summaries" | sort -u | wc -l | tr -d ' ')
  UNIQUE_RAW=$(jq -r '.rawSha256' "$TMP/summaries" | sort -u | wc -l | tr -d ' ')
  NON_STRING=$(jq -r 'select(.toType != "string" or .toIsArray) | .to' "$TMP/summaries" | wc -l | tr -d ' ')

  printf 'VERDICT\n'
  PASSED=0

  if [ "$NON_STRING" != "0" ]; then
    cat <<'EOF'
  !! `message.to` is NOT a plain string.

  The whole fan-out model assumes one envelope recipient per invocation.
  Read the OUTCOME "A - fan-out does not happen" section of RUNBOOK.md
  before changing anything: `resolveTarget` is singular and so is the
  `messages` row it produces.
EOF
  elif [ "$COUNT" = "1" ]; then
    cat <<'EOF'
  !! ONE invocation for two recipients. Fan-out did not happen.

  Either the second recipient was silently dropped — which is mail loss and
  the most serious result this experiment can produce — or Cloudflare
  delivered it separately and the tail missed it. Confirm against Email
  Routing's own delivery log in the dashboard before concluding, then read
  OUTCOME A in RUNBOOK.md.
EOF
  elif [ "$COUNT" != "2" ]; then
    printf '  ?? %s invocations for two recipients. Unexpected either way.\n' "$COUNT"
    printf '     Check whether two runs are being conflated: the run id comes\n'
    printf '     from X-Spike-Run, and send.sh regenerates it per send.\n'
  elif [ "$UNIQUE_CONTENT" = "1" ]; then
    PASSED=1
    cat <<'EOF'
  PASS. Two invocations, one contentId.

  Fan-out is real, and stripTraceHeaders removes every byte that differed
  between the two deliveries. This is what §4 assumes and what the fan-out
  fixture in §12 asserts: one `contents` row, two `messages` rows.
EOF
    if [ "$UNIQUE_RAW" = "1" ]; then
      printf '\n  Note: the RAW bytes were identical too, so nothing per-delivery\n'
      printf '  was stamped at all on this route. That makes the pass weaker than\n'
      printf '  it looks — stripTraceHeaders was never actually exercised. See\n'
      printf '  OUTCOME B in RUNBOOK.md for why one more send is worth it.\n'
    fi
  else
    UNIQUE_HEADER_BLOCK=$(jq -r '.headerBlockSha256' "$TMP/summaries" \
      | sort -u | wc -l | tr -d ' ')
    if [ "$UNIQUE_HEADER_BLOCK" = "1" ]; then
      cat <<'EOF'
  FAIL, and NOT in the headers. Two invocations, two contentIds, but the two
  header blocks are byte-identical — so the difference is BELOW the blank
  line, in the body.

  No addition to TRACE_HEADERS can fix this: stripping only ever touches
  headers. Read OUTCOME C.4 in RUNBOOK.md. The honest conclusion is likely
  that fan-out dedup is not achievable and §4 should accept two `contents`
  rows, which it already calls "wasteful, but not wrong".
EOF
    else
      cat <<'EOF'
  FAIL. Two invocations, TWO different contentIds.

  Fan-out would store this email twice. The headers below differed after
  stripping and are the candidates for the TRACE_HEADERS list in
  src/trace.ts. Read OUTCOME C in RUNBOOK.md — there is a test to write
  first, and a judgement call about which of these are genuinely
  per-delivery rather than merely different this once.
EOF
    fi
  fi

  if [ "$COUNT" = "2" ] && [ -s "$TMP/names.1" ] && [ -s "$TMP/names.2" ]; then
    printf '\n'; rule
    printf 'HEADERS THAT DIFFERED BETWEEN THE TWO DELIVERIES\n'
    printf '  name, byte length, hash of the whole folded header\n'
    rule
    if diff -u -L 'delivery-1' -L 'delivery-2' \
         "$TMP/names.1" "$TMP/names.2" > "$TMP/namediff"; then
      printf '  none — the two header blocks are identical, header for header.\n'
      printf '  Nothing per-delivery was stamped on this route at all.\n'
    else
      sed 's/^/  /' "$TMP/namediff"

      sort "$TMP/names.1" > "$TMP/s1"; sort "$TMP/names.2" > "$TMP/s2"
      comm -3 "$TMP/s1" "$TMP/s2" | sed 's/^[[:space:]]*//' | cut -f1 \
        | sort -u | grep -v '^$' > "$TMP/changed" || true

      printf '\n  Against the current TRACE_HEADERS in src/trace.ts:\n'
      while IFS= read -r NAME; do
        [ -n "$NAME" ] || continue
        if grep -qx "$NAME" "$TMP/stripped" 2>/dev/null; then
          printf '    %-32s already stripped\n' "$NAME"
        else
          printf '    %-32s NOT STRIPPED  <-- candidate\n' "$NAME"
        fi
      done < "$TMP/changed"

      if [ "$PASSED" = "1" ]; then
        printf '\n  Every one is already stripped, which is why contentId agreed.\n'
        printf '  Nothing to add. The list is confirmed for THIS route only —\n'
        printf '  see OUTCOME B in RUNBOOK.md on how far that generalises.\n'
      else
        printf '\n  The NOT STRIPPED lines are the finding. Before adding any of\n'
        printf '  them, read OUTCOME C in RUNBOOK.md: a header can differ once\n'
        printf '  for reasons that are not per-delivery, and stripping the wrong\n'
        printf '  one merges two genuinely different messages.\n'
      fi
    fi

    printf '\n'; rule
    printf 'VERBATIM HEADER BLOCK DIFF\n'
    rule
    if diff -u -L 'delivery-1' -L 'delivery-2' \
         "$TMP/block.1" "$TMP/block.2" > "$TMP/blockdiff"; then
      printf '  byte-identical\n'
    else
      sed 's/^/  /' "$TMP/blockdiff"
    fi
  fi

  # Reassembly is only trustworthy if it round-trips, and a truncated capture
  # is exactly the case where it silently would not.
  if jq -e 'select(.kind == "headers" and .truncated == true)' \
       "$TMP/lines.ndjson" >/dev/null 2>&1; then
    printf '\n  !! The header block was truncated at 64 log chunks. The diff above\n'
    printf '     is partial. Bind SPIKE_BUCKET and compare the archived .eml files.\n'
  fi

done < "$TMP/runs"

printf '\n'; rule
printf 'If SPIKE_BUCKET was bound, settle it definitively with bytes:\n'
printf '  npx wrangler r2 object get inbox-fanout-spike/spike/<run>/<inv>.eml --file a.eml --remote\n'
printf '  npx wrangler r2 object get inbox-fanout-spike/spike/<run>/<inv>.eml --file b.eml --remote\n'
printf '  cmp a.eml b.eml && echo "identical"\n'
printf '  diff <(head -c 8192 a.eml) <(head -c 8192 b.eml)\n'
rule
