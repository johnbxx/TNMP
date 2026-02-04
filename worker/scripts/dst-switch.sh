#!/usr/bin/env bash
#
# Switch cron triggers between PST and PDT offsets.
# Run this on DST transition dates:
#   - Spring forward (Mar): ./dst-switch.sh pdt
#   - Fall back (Nov):      ./dst-switch.sh pst
#
# 2026 transitions: Mar 8 (→ PDT), Nov 1 (→ PST)
# 2027 transitions: Mar 14 (→ PDT), Nov 7 (→ PST)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TOML="$SCRIPT_DIR/../wrangler.toml"

PST_CRONS='crons = ["* 4-8 * * TUE", "*/5 3-8 * * WED", "0 * * * *"]'
PDT_CRONS='crons = ["* 3-7 * * TUE", "*/5 2-7 * * WED", "0 * * * *"]'

usage() {
    echo "Usage: $0 <pst|pdt>"
    echo "  pst  — Set UTC-8 offsets (November → March)"
    echo "  pdt  — Set UTC-7 offsets (March → November)"
    exit 1
}

[[ $# -eq 1 ]] || usage

case "$1" in
    pst)
        echo "Switching to PST (UTC-8) cron offsets..."
        sed -i '' "s|^crons = .*|${PST_CRONS}|" "$TOML"
        sed -i '' "s|^# Current: .*|# Current: PST. Run worker/scripts/dst-switch.sh to toggle on DST transitions.|" "$TOML"
        ;;
    pdt)
        echo "Switching to PDT (UTC-7) cron offsets..."
        sed -i '' "s|^crons = .*|${PDT_CRONS}|" "$TOML"
        sed -i '' "s|^# Current: .*|# Current: PDT. Run worker/scripts/dst-switch.sh to toggle on DST transitions.|" "$TOML"
        ;;
    *)
        usage
        ;;
esac

echo "Updated $TOML:"
grep -A1 'crons' "$TOML"
echo ""
echo "Now deploy with: cd worker && wrangler deploy"
