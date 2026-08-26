#!/bin/bash
# QAVENO — Database Backup Script
# Usage: ./scripts/backup-db.sh [backup-dir]
# Requires: pg_dump, PGPASSWORD env var

set -euo pipefail

BACKUP_DIR="${1:-./backups}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/qaveno_${TIMESTAMP}.sql.gz"

# Config from env
PGHOST="${POSTGRES_HOST:-localhost}"
PGPORT="${POSTGRES_PORT:-5432}"
PGUSER="${POSTGRES_USER:-qaveno}"
PGDATABASE="${POSTGRES_DB:-qaveno}"

# Create backup directory
mkdir -p "$BACKUP_DIR"

echo "[QAVENO] Starting backup: ${PGDATABASE}@${PGHOST}:${PGPORT}"
echo "[QAVENO] Output: ${BACKUP_FILE}"

# Run pg_dump with compression
pg_dump \
  -h "$PGHOST" \
  -p "$PGPORT" \
  -U "$PGUSER" \
  -d "$PGDATABASE" \
  --no-owner \
  --no-privileges \
  --clean \
  --if-exists \
  -F p \
  2>/dev/null | gzip > "$BACKUP_FILE"

# Verify backup
FILE_SIZE=$(stat -f%z "$BACKUP_FILE" 2>/dev/null || stat -c%s "$BACKUP_FILE" 2>/dev/null || echo "0")
if [ "$FILE_SIZE" -lt 100 ]; then
  echo "[QAVENO] ERROR: Backup file too small (${FILE_SIZE} bytes), may be empty"
  exit 1
fi

echo "[QAVENO] Backup complete: ${BACKUP_FILE} (${FILE_SIZE} bytes)"

# Cleanup: keep last 30 backups
cd "$BACKUP_DIR"
ls -t qaveno_*.sql.gz 2>/dev/null | tail -n +31 | xargs -r rm --
echo "[QAVENO] Cleanup done. Keeping last 30 backups."
