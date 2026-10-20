#!/bin/sh
# Nightly pg_dump of the school database, run by the `backup` service in docker-compose.yml.
#
#   backup.sh        take a backup now, then one every day at BACKUP_TIME (runs forever)
#   backup.sh once   take one backup now and exit
#
# Connection comes from the standard PGHOST / PGUSER / PGPASSWORD / PGDATABASE variables.
# Each dump is checked with pg_restore --list before it counts; dumps older than BACKUP_KEEP_DAYS
# are deleted only after a good backup, so a failing backup never removes the last good copies.
set -eu

BACKUP_DIR=/backups
BACKUP_TIME="${BACKUP_TIME:-02:00}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*"; }

case "$BACKUP_TIME" in
  [01][0-9]:[0-5][0-9] | 2[0-3]:[0-5][0-9]) ;;
  *) log "BACKUP_TIME must be HH:MM in 24-hour time (got \"$BACKUP_TIME\")"; exit 1 ;;
esac
case "$KEEP_DAYS" in
  '' | *[!0-9]* | 0) log "BACKUP_KEEP_DAYS must be a whole number of at least 1 (got \"$KEEP_DAYS\")"; exit 1 ;;
esac

# Dumps hold students' and staff's personal data: readable by the owner only
umask 077

backup() {
  name="${PGDATABASE}_$(date +%Y-%m-%d_%H%M%S).dump"
  partial="$BACKUP_DIR/.$name.partial"
  if pg_dump --format=custom --file="$partial" && pg_restore --list "$partial" > /dev/null; then
    mv "$partial" "$BACKUP_DIR/$name"
    log "Backup written: $name ($(du -h "$BACKUP_DIR/$name" | cut -f1))"
    # -mtime +N matches files at least N+1 whole days old, leaving KEEP_DAYS daily backups
    find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.dump' -mtime +"$((KEEP_DAYS - 1))" | while read -r old; do
      rm -f "$old" && log "Deleted old backup: $(basename "$old")"
    done
  else
    rm -f "$partial"
    log "BACKUP FAILED: see the pg_dump error above"
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

log "Backing up $PGDATABASE every day at $BACKUP_TIME ($(date +%Z)), keeping $KEEP_DAYS days"
backup || true
while true; do
  sleep "$(seconds_until_next_run)"
  backup || true
done
