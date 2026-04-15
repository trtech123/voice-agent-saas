#!/bin/bash
set -euo pipefail

if [ "${1:-}" = "" ]; then
  echo "usage: $0 <elevenlabs_agent_id> [patch_json_path]" >&2
  exit 1
fi

AGENT_ID="$1"
PATCH_JSON="${2:-/tmp/el-agent-patch-turn.json}"

if [ ! -f "$PATCH_JSON" ]; then
  echo "patch JSON not found: $PATCH_JSON" >&2
  exit 1
fi

EL="$(grep -E '^ELEVENLABS_API_KEY=' /opt/voiceagent-saas/.env | head -1 | sed 's/^ELEVENLABS_API_KEY=//' | tr -d '\r"')"
curl -sS -w "\nhttp:%{http_code}\n" -X PATCH \
  "https://api.elevenlabs.io/v1/convai/agents/${AGENT_ID}" \
  -H "xi-api-key: ${EL}" \
  -H "Content-Type: application/json" \
  --data-binary @"${PATCH_JSON}"
