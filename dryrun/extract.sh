#!/bin/bash
set -e

if [ -z "$SAPIOM_API_KEY" ]; then
  echo "Error: SAPIOM_API_KEY environment variable is not set. Run: export SAPIOM_API_KEY=..." >&2
  exit 1
fi

echo "=== /v1/transactions ==="
curl -s -H "Authorization: Bearer $SAPIOM_API_KEY" https://api.sapiom.ai/v1/transactions | head -c 3000
echo

echo "=== /v1/agents ==="
curl -s -H "Authorization: Bearer $SAPIOM_API_KEY" https://api.sapiom.ai/v1/agents | head -c 3000
echo

echo "=== /v1/agents/metrics ==="
curl -s -H "Authorization: Bearer $SAPIOM_API_KEY" https://api.sapiom.ai/v1/agents/metrics | head -c 3000
echo
