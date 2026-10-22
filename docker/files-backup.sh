#!/bin/sh
# Nightly copy of the uploaded files (student photos, birth certificate scans) from MinIO to BACKUP_DIR/files,
# run by the `files-backup` service in docker-compose.yml.
#
#   files-backup.sh        copy now, then every day at BACKUP_TIME (runs forever)
#   files-backup.sh once   copy now and exit
#
# The copy is plain files (one per upload), readable without MinIO. Files are never overwritten in the bucket
# (each upload gets a new name), and files deleted from the bucket are kept in the copy, so every file an
# older database backup refers to is still there when that backup is restored.
set -eu

BACKUP_TIME="${BACKUP_TIME:-02:00}"
TARGET="/backups/files/$S3_BUCKET"
STAMP=/backups/files/.last-success

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*"; }

case "$BACKUP_TIME" in
  [01][0-9]:[0-5][0-9] | 2[0-3]:[0-5][0-9]) ;;
  *) log "BACKUP_TIME must be HH:MM in 24-hour time (got \"$BACKUP_TIME\")"; exit 1 ;;
esac

# Personal data: readable by the owner only
umask 077
mkdir -p "$TARGET"

backup() {
  if mc alias set school "$S3_ENDPOINT" "$S3_ACCESS_KEY" "$S3_SECRET_KEY" > /dev/null \
    && mc mirror --quiet --overwrite school/"$S3_BUCKET" "$TARGET"; then
    date +%s > "$STAMP"
    log "Files backed up to $TARGET ($(du -sh "$TARGET" | cut -f1))"
  else
    log "FILES BACKUP FAILED: see the mc error above"
    return 1
  fi
}

seconds_until_next_run() {
  now=$(date +%s)
  next=$(date -d "$(date +%Y-%m-%d) $BACKUP_TIME" +%s)
  [ "$next" -gt "$now" ] || next=$((next + 86400))
  echo $((next - now))
}

if [ "${1:-}" = once ]; then
  backup
  exit
fi

log "Backing up bucket $S3_BUCKET every day at $BACKUP_TIME ($(date +%Z))"
backup || true
while true; do
  sleep "$(seconds_until_next_run)"
  backup || true
done
