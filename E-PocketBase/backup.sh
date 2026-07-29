#!/usr/bin/env bash
#
# 진동시험기 예약 (PocketBase) — 백업 스크립트
#
# PocketBase 내장 자동백업은 pb_data 안에, 즉 "같은 SD카드"에 저장된다.
# 그래서 SD카드 손상·정전 같은 정작 대비하려던 사고에는 무력하다.
# 이 스크립트는 장치 바깥으로 내보내는 것까지를 백업으로 본다.
#
# 사용법
#   sudo /opt/vibres/backup.sh              로컬에만 생성
#   sudo /opt/vibres/backup.sh --push       생성 후 원격으로 복사 (권장)
#
# 원격 대상은 /opt/vibres/backup.conf 에 적는다. 예:
#   REMOTE="사용자@192.168.0.8:/d/backup/vibres"
#   SSH_KEY="/root/.ssh/id_ed25519"
#
# 이 장치에 붙인 별도 디스크(외장 USB 등)에도 사본을 둘 수 있다:
#   ARCHIVE_DIR="/mnt/vibres-backup/vibres"
#   ARCHIVE_KEEP=180
# SD카드와 그 디스크 양쪽에 쓴다. 한쪽에만 두면 그쪽이 새로운 단일 실패점이 된다.
#
# cron 예시 (매일 03:10, PocketBase 내장 백업 03:00 이후):
#   10 3 * * * /opt/vibres/backup.sh --push >> /var/log/vibres-backup.log 2>&1

set -euo pipefail

APP_DIR="/opt/vibres"
DATA_DIR="$APP_DIR/pb_data"
OUT_DIR="$APP_DIR/backups-local"
KEEP=14                     # 로컬 보관 개수
CONF="$APP_DIR/backup.conf"

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
die() { printf '[%s] [오류] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "root 권한이 필요합니다."
[ -d "$DATA_DIR" ] || die "데이터 폴더가 없습니다: $DATA_DIR"

PUSH=""
[ "${1:-}" = "--push" ] && PUSH=1

mkdir -p "$OUT_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ── DB 안전 복사 ─────────────────────────────────────────────
# 서비스가 돌아가는 중에 파일을 그냥 cp/tar 하면 쓰기 도중의 불완전한
# 스냅샷을 뜰 수 있다. sqlite3 .backup 은 잠금을 고려해 일관된 사본을 만든다.
log "DB 스냅샷 생성"
if command -v sqlite3 >/dev/null 2>&1; then
  for DB in data.db auxiliary.db; do
    [ -f "$DATA_DIR/$DB" ] || continue
    sqlite3 "$DATA_DIR/$DB" ".backup '$WORK/$DB'" || die "$DB 스냅샷 실패"
  done
else
  # sqlite3 가 없으면 서비스를 잠깐 멈추고 복사한다 (수 초).
  log "  sqlite3 없음 — 서비스를 잠시 멈추고 복사"
  systemctl stop vibres
  cp -a "$DATA_DIR"/*.db "$WORK/" 2>/dev/null || true
  systemctl start vibres
fi

# 업로드 파일 등 나머지도 함께 담는다.
[ -d "$DATA_DIR/storage" ] && cp -a "$DATA_DIR/storage" "$WORK/" 2>/dev/null || true

ARCHIVE="$OUT_DIR/vibres-$STAMP.tar.gz"
tar czf "$ARCHIVE" -C "$WORK" . || die "압축 실패"
log "생성: $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"

# 무결성 확인 — 압축이 깨졌으면 백업이 아니다.
tar tzf "$ARCHIVE" >/dev/null || die "압축 파일이 손상되었습니다"
log "무결성 확인 OK"

# ── 오래된 로컬 백업 정리 ────────────────────────────────────
ls -1t "$OUT_DIR"/vibres-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r f; do
  rm -f "$f" && log "오래된 백업 삭제: $(basename "$f")"
done

# ── 이 장치에 붙인 별도 디스크로 사본 ────────────────────────
# SD카드가 죽어도 남게 하려는 것이므로, 그 디스크가 실제로 마운트돼 있는지
# 반드시 확인한다. 마운트가 풀린 상태에서 그냥 쓰면 파일은 SD카드의 빈 폴더에
# 쌓이고, 겉보기에는 백업이 되는 것처럼 보인다. 정작 필요할 때 없는 것보다
# 나쁜 상태다.
#
# 마운트가 없어도 스크립트를 실패로 끝내지는 않는다. SD카드 사본과 PC 회수는
# 이미 끝났으므로 백업 자체는 성립했다. 대신 눈에 띄게 경고한다.
CONF_ARCHIVE_DIR=""
if [ -f "$CONF" ]; then
  # shellcheck source=/dev/null
  . "$CONF"
  CONF_ARCHIVE_DIR="${ARCHIVE_DIR:-}"
fi

if [ -n "$CONF_ARCHIVE_DIR" ]; then
  AKEEP="${ARCHIVE_KEEP:-180}"
  # 마운트 지점은 보통 상위 디렉터리다 (/mnt/vibres-backup/vibres -> /mnt/vibres-backup)
  MP="$CONF_ARCHIVE_DIR"
  while [ "$MP" != "/" ] && ! mountpoint -q "$MP" 2>/dev/null; do MP="$(dirname "$MP")"; done

  if [ "$MP" = "/" ]; then
    log "[경고] 사본 디스크가 마운트돼 있지 않습니다: $CONF_ARCHIVE_DIR"
    log "[경고]   이번 백업은 SD카드에만 남습니다. 외장 디스크 연결을 확인하세요."
  else
    mkdir -p "$CONF_ARCHIVE_DIR"
    COPY="$CONF_ARCHIVE_DIR/$(basename "$ARCHIVE")"
    if cp -f "$ARCHIVE" "$COPY" && sync && tar tzf "$COPY" >/dev/null 2>&1; then
      log "사본 생성: $COPY  (마운트: $MP)"
      ls -1t "$CONF_ARCHIVE_DIR"/vibres-*.tar.gz 2>/dev/null | tail -n +$((AKEEP + 1)) | while read -r f; do
        rm -f "$f" && log "오래된 사본 삭제: $(basename "$f")"
      done
    else
      rm -f "$COPY" 2>/dev/null || true
      log "[경고] 사본 생성에 실패했습니다: $CONF_ARCHIVE_DIR (디스크 상태를 확인하세요)"
    fi
  fi
fi

# ── 장치 바깥으로 내보내기 ───────────────────────────────────
if [ -n "$PUSH" ]; then
  [ -f "$CONF" ] || die "원격 설정이 없습니다: $CONF (REMOTE= 항목을 적어주세요)"
  # shellcheck source=/dev/null
  . "$CONF"

  # 외부에서 끌어가는(pull) 방식으로 구성한 경우.
  # 윈도우처럼 SSH 서버가 없는 수신처는 이 장치가 밀어넣을 수 없어서,
  # 상대가 주기적으로 가져가는 구성을 쓴다. 그 경우를 명시적으로 표시해 둔다.
  # 아무 설정도 없는 상태를 조용히 성공으로 넘기지 않기 위해, 반드시 둘 중
  # 하나(REMOTE 또는 EXTERNAL_PULL)를 적어야 한다.
  if [ -z "${REMOTE:-}" ] && [ "${EXTERNAL_PULL:-}" = "1" ]; then
    log "외부 회수(pull) 방식으로 구성됨 — 이 장치에서는 전송하지 않습니다."
    log "  수신처가 실제로 가져가고 있는지는 그쪽에서 확인해야 합니다."
    log "완료"
    exit 0
  fi

  [ -n "${REMOTE:-}" ] || die "$CONF 에 REMOTE 도 EXTERNAL_PULL 도 설정돼 있지 않습니다. 백업이 이 장치에만 남습니다."
  log "원격 전송: $REMOTE"
  SCP_OPTS="-o BatchMode=yes -o ConnectTimeout=15"
  [ -n "${SSH_KEY:-}" ] && SCP_OPTS="$SCP_OPTS -i $SSH_KEY"
  # shellcheck disable=SC2086
  scp $SCP_OPTS "$ARCHIVE" "$REMOTE/" || die "원격 전송 실패 — 백업이 이 장치에만 있습니다"
  log "원격 전송 완료"
else
  log "주의: --push 없이 실행되어 백업이 이 장치(SD카드)에만 있습니다."
fi

log "완료"
