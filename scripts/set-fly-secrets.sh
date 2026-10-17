#!/bin/bash
# Sets the app's secrets on Fly.io, asking for each one. Nothing is written to disk or to your shell history,
# and nothing is shown on screen except the three random secrets we generate for you, once, to save.
#
#   bash scripts/set-fly-secrets.sh [fly-app-name]
set -euo pipefail

APP="${1:-wikitree-social-scheduler}"
command -v fly >/dev/null || { echo "The 'fly' tool isn't installed (brew install flyctl)."; exit 1; }
command -v openssl >/dev/null || { echo "openssl isn't available."; exit 1; }

echo "Setting secrets for the Fly app: $APP"
fly status -a "$APP" >/dev/null 2>&1 || fly apps list 2>/dev/null | grep -q "$APP" || { echo "Can't find the app '$APP'. Check 'fly apps list' and 'fly auth whoami'."; exit 1; }

existing="$(fly secrets list -a "$APP" 2>/dev/null || true)"
has() { echo "$existing" | grep -q "^$1\b\|[[:space:]]$1[[:space:]]\|^ *$1 "; }

ask()  { local v; read -r -p "$1: " v; printf '%s' "$v"; }
asks() { local v; read -r -s -p "$1 (typing is hidden): " v; echo >&2; printf '%s' "$v"; }
need() { [ -n "$2" ] || { echo "$1 can't be empty. Nothing was changed."; exit 1; }; }

CLIENT_ID="$(ask 'Google Client ID')";                 need "Client ID" "$CLIENT_ID"
CLIENT_SECRET="$(asks 'Google Client secret')";        need "Client secret" "$CLIENT_SECRET"
ADMINS="$(ask 'Administrator emails, comma separated (all @wikitree.com)')"; need "Administrator emails" "$ADMINS"
S3_ENDPOINT="$(ask 'R2 address (https://<account-id>.r2.cloudflarestorage.com)')"; need "R2 address" "$S3_ENDPOINT"
S3_BUCKET="$(ask 'R2 backup bucket name')";            need "Bucket name" "$S3_BUCKET"
S3_KEY="$(ask 'R2 Access Key ID')";                    need "Access Key ID" "$S3_KEY"
S3_SECRET="$(asks 'R2 Secret Access Key')";            need "Secret Access Key" "$S3_SECRET"
WEBHOOK="$(ask 'Discord/Slack webhook address for alerts (optional, press Enter to skip)')"

tmp="$(mktemp)"; chmod 600 "$tmp"; trap 'rm -f "$tmp"' EXIT
{
  echo "GOOGLE_CLIENT_ID=$CLIENT_ID"
  echo "GOOGLE_CLIENT_SECRET=$CLIENT_SECRET"
  echo "ADMIN_EMAILS=$ADMINS"
  echo "BACKUP_S3_ENDPOINT=$S3_ENDPOINT"
  echo "BACKUP_S3_BUCKET=$S3_BUCKET"
  echo "BACKUP_S3_ACCESS_KEY_ID=$S3_KEY"
  echo "BACKUP_S3_SECRET_ACCESS_KEY=$S3_SECRET"
  [ -z "$WEBHOOK" ] || echo "ALERT_WEBHOOK_URL=$WEBHOOK"
} > "$tmp"

if has DATA_KEY; then
  echo
  echo "DATA_KEY, BACKUP_PASSPHRASE and BRIEF_TOKEN are already set on Fly, so they are being left alone."
  echo "(Replacing DATA_KEY on a server that already has stored sign-ins would make them unreadable.)"
else
  DATA_KEY="$(openssl rand -base64 32)"
  BACKUP_PASSPHRASE="$(openssl rand -base64 24)"
  BRIEF_TOKEN="$(openssl rand -base64 32 | tr -d '=+/' )"
  {
    echo "DATA_KEY=$DATA_KEY"
    echo "BACKUP_PASSPHRASE=$BACKUP_PASSPHRASE"
    echo "BRIEF_TOKEN=$BRIEF_TOKEN"
  } >> "$tmp"
  echo
  echo "=================================================================="
  echo "SAVE THESE THREE in the team password manager NOW. They are shown once."
  echo
  echo "  DATA_KEY:           $DATA_KEY"
  echo "  BACKUP_PASSPHRASE:  $BACKUP_PASSPHRASE"
  echo "  BRIEF_TOKEN:        $BRIEF_TOKEN"
  echo
  echo "Without BACKUP_PASSPHRASE, backups can't be opened."
  echo "=================================================================="
  read -r -p "Type 'saved' once they are in the password manager: " ok
  [ "$ok" = "saved" ] || { echo "Stopped. Nothing was changed on Fly."; exit 1; }
fi

fly secrets import -a "$APP" < "$tmp"
echo
echo "Done. Secrets set on $APP:"
fly secrets list -a "$APP"
