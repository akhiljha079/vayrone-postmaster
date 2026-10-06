#!/bin/sh
# Load test (spec §8): 500 users, 1000 external accounts, IDLE push, SMTP throughput.
# Results: docs/performance-results.json. Sizes: VPM_LOAD_USERS, VPM_LOAD_ACCOUNTS, VPM_LOAD_MSGS.
set -e
cd "$(dirname "$0")/../worker"
ulimit -n 20000 2>/dev/null || ulimit -n 10240 2>/dev/null || true
VPM_LOAD=1 npx vitest run test/load.test.ts --testTimeout=3600000 --hookTimeout=3600000
