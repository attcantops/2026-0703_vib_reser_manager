#!/usr/bin/env bash
#
# 진동시험기 예약 (PocketBase) — 업데이트 스크립트
#
# 설치 이후에는 담당자를 부를 필요 없이, SSH 로 접속해서 이것만 실행하면 된다.
#
#   ssh <계정>@<서버IP>
#   sudo /opt/vibres/update.sh
#
# 반드시 /opt/vibres/update.sh (저장소 바깥)를 실행한다. 저장소 안의 사본을
# 직접 실행하면 --rollback 시 스크립트가 스스로 지워질 수 있다.
#
# 하는 일: 최신 소스 pull -> 서비스 재시작 -> 정상 기동 확인
# 예약 데이터(/opt/vibres/pb_data)는 건드리지 않는다.
#
# 옵션
#   --pb           PocketBase 실행파일을 검증된 고정 버전으로 갱신
#                  (다른 버전으로 올리려면 PB_VERSION=0.40.0 처럼 명시)
#   --rollback     소스를 직전 커밋으로 되돌리고 재시작
#   --rollback-pb  PocketBase 실행파일을 --pb 직전 버전으로 되돌리고 재시작

set -euo pipefail

APP_DIR="/opt/vibres"
SRC_DIR="$APP_DIR/repo/E-PocketBase"
SERVICE="vibres"
PORT="${PORT:-8090}"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m[오류] %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "root 권한이 필요합니다.  sudo $0 로 실행하세요."
[ -d "$APP_DIR/repo/.git" ] || die "설치본을 찾을 수 없습니다. install.sh 를 먼저 실행하세요."

# PocketBase 기본 버전은 install.sh 와 같은 "검증된 값"으로 고정한다.
# 여기만 latest 를 받아오면 --pb 경로로 핀이 무력화된다.
PB_PIN="0.39.9"

DO_PB=""; DO_ROLLBACK=""; DO_ROLLBACK_PB=""
for a in "$@"; do
  case "$a" in
    --pb) DO_PB=1 ;;
    --rollback) DO_ROLLBACK=1 ;;
    --rollback-pb) DO_ROLLBACK_PB=1 ;;
    *) die "알 수 없는 옵션: $a" ;;
  esac
done

# ── 실행파일 롤백 ────────────────────────────────────────────
# --pb 는 바이너리를 덮어쓰므로, 이전 파일을 남겨두지 않으면 되돌릴 수단이 없다.
if [ -n "$DO_ROLLBACK_PB" ]; then
  [ -f "$APP_DIR/pocketbase.prev" ] \
    || die "되돌릴 이전 실행파일이 없습니다 ($APP_DIR/pocketbase.prev). --pb 를 실행한 적이 없습니다."
  log "PocketBase 실행파일을 이전 버전으로 되돌리기"
  cp -a "$APP_DIR/pocketbase" "$APP_DIR/pocketbase.failed"
  mv -f "$APP_DIR/pocketbase.prev" "$APP_DIR/pocketbase"
  chmod 755 "$APP_DIR/pocketbase"
  echo "  $("$APP_DIR/pocketbase" --version)"
  systemctl restart "$SERVICE"
  sleep 3
  systemctl is-active --quiet "$SERVICE" \
    && printf '\n\033[1;32m실행파일 롤백 완료\033[0m\n\n' \
    || die "롤백 후에도 서비스가 뜨지 않습니다. journalctl -u $SERVICE -n 40 확인하세요."
  exit 0
fi

BEFORE="$(git -C "$APP_DIR/repo" rev-parse --short HEAD)"

if [ -n "$DO_ROLLBACK" ]; then
  log "직전 커밋으로 롤백"
  # 얕은 복제(shallow clone)면 HEAD~1 이 없을 수 있으므로 이력을 먼저 확보한다.
  if ! git -C "$APP_DIR/repo" rev-parse --verify -q HEAD~1 >/dev/null; then
    echo "  이력이 부족해 추가로 받는 중..."
    git -C "$APP_DIR/repo" fetch --deepen 10 origin main 2>/dev/null \
      || git -C "$APP_DIR/repo" fetch --unshallow origin main 2>/dev/null || true
  fi
  git -C "$APP_DIR/repo" rev-parse --verify -q HEAD~1 >/dev/null \
    || die "되돌릴 이전 커밋이 없습니다 (현재가 최초 커밋)."
  git -C "$APP_DIR/repo" reset --hard HEAD~1
else
  log "최신 소스 받기"
  # depth 1 로 받으면 이력이 잘려 나중에 롤백이 불가능해진다.
  git -C "$APP_DIR/repo" fetch --depth 20 origin main
  git -C "$APP_DIR/repo" reset --hard origin/main
fi

AFTER="$(git -C "$APP_DIR/repo" rev-parse --short HEAD)"

# ── 화면에 배포 버전 찍기 ────────────────────────────────────
# 화면이 안 바뀔 때 원인이 두 가지다. 서버에 안 올라갔거나, 브라우저가 예전 화면을
# 캐시에서 꺼내 쓰거나. 눈으로 구분이 안 되면 엉뚱한 곳을 파게 된다(실제로 그랬다).
# index.html 의 자리표시자를 커밋 번호로 바꿔 화면 좌측 하단에 찍는다.
# 이 수정으로 저장소가 더러워지지만, 다음 실행의 reset --hard 가 되돌린 뒤 다시 찍는다.
INDEX="$SRC_DIR/pb_public/index.html"
if [ -f "$INDEX" ]; then
  STAMP="$AFTER ($(date '+%m-%d %H:%M'))"
  sed -i "s/__BUILD__/$STAMP/" "$INDEX" && echo "  화면 버전 표시: $STAMP"
fi

if [ "$BEFORE" = "$AFTER" ]; then
  echo "  변경 없음 ($AFTER)"
else
  echo "  $BEFORE -> $AFTER"
  git -C "$APP_DIR/repo" log --oneline -3
fi

# ── PocketBase 실행파일 갱신 (--pb 옵션) ─────────────────────
if [ -n "$DO_PB" ]; then
  log "PocketBase 실행파일 갱신"
  case "$(uname -m)" in
    aarch64|arm64) PB_ARCH="arm64" ;;
    armv7l|armv6l) PB_ARCH="armv7" ;;
    x86_64|amd64)  PB_ARCH="amd64" ;;
    *) die "지원하지 않는 아키텍처: $(uname -m)" ;;
  esac
  # 기본값은 검증된 고정 버전. 최신을 원하면 PB_VERSION=latest 로 명시한다.
  V="${PB_VERSION:-$PB_PIN}"
  if [ "$V" = "latest" ]; then
    echo "  주의: 검증되지 않은 최신 버전을 받습니다."
    V="$(curl -fsSL https://api.github.com/repos/pocketbase/pocketbase/releases/latest \
        | grep -o '"tag_name": *"v[^"]*"' | head -1 | sed 's/.*"v\([^"]*\)".*/\1/')"
  fi
  [ -n "$V" ] || die "버전 조회 실패"
  echo "  대상 버전: v$V (현재: $("$APP_DIR/pocketbase" --version 2>/dev/null))"

  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  curl -fsSL -o "$tmp/pb.zip" \
    "https://github.com/pocketbase/pocketbase/releases/download/v${V}/pocketbase_${V}_linux_${PB_ARCH}.zip" \
    || die "다운로드 실패"
  unzip -oq "$tmp/pb.zip" -d "$tmp"

  # 업그레이드 직전 백업.
  # 예전에는 여기서 data.db 를 raw cp 했으나, 서비스가 돌아가는 중의 복사라
  # -wal 파일이 빠져 최근 예약이 누락되거나 깨진 사본이 될 수 있었다.
  # backup.sh 는 sqlite3 .backup 으로 일관된 스냅샷을 만들고 무결성까지 확인한다.
  if [ -x "$APP_DIR/backup.sh" ]; then
    log "업그레이드 전 백업"
    "$APP_DIR/backup.sh" || die "업그레이드 전 백업에 실패했습니다. 업그레이드를 중단합니다."
  else
    die "backup.sh 가 없습니다. 백업 없이 업그레이드하지 않습니다."
  fi

  # 되돌릴 수 있도록 현재 실행파일을 보관한다 (--rollback-pb 가 이걸 쓴다).
  cp -a "$APP_DIR/pocketbase" "$APP_DIR/pocketbase.prev"
  install -m 755 "$tmp/pocketbase" "$APP_DIR/pocketbase"
  echo "  갱신됨: $("$APP_DIR/pocketbase" --version)"
  echo "  문제가 생기면: sudo $APP_DIR/update.sh --rollback-pb"
fi

# ── 자기 자신 갱신 ───────────────────────────────────────────
# 이 스크립트는 /opt/vibres/update.sh (저장소 바깥)에서 실행된다.
# 저장소 쪽에 새 버전이 있으면 가져다 둔다. 실행 중인 파일을 직접 덮으면
# bash 가 나머지를 잘못 읽을 수 있으므로, 임시파일에 쓴 뒤 mv 로 교체한다.
for S in update.sh backup.sh; do
  if [ -f "$SRC_DIR/$S" ] && ! cmp -s "$SRC_DIR/$S" "$APP_DIR/$S"; then
    cp "$SRC_DIR/$S" "$APP_DIR/$S.new"
    chmod 755 "$APP_DIR/$S.new"
    mv -f "$APP_DIR/$S.new" "$APP_DIR/$S"
    echo "  $S 갱신됨"
  fi
done

# ── 재시작 ───────────────────────────────────────────────────
log "서비스 재시작"
systemctl restart "$SERVICE"

ok=""
for i in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done

if [ -z "$ok" ]; then
  journalctl -u "$SERVICE" -n 40 --no-pager || true
  die "재시작 후 서버가 응답하지 않습니다. 위 로그 확인 후  sudo $0 --rollback  으로 되돌릴 수 있습니다."
fi

# 인터페이스가 여러 개일 때 hostname -I 의 첫 값은 접근 불가능한 주소일 수 있다.
# 기본 경로의 출발지 IP를 우선 사용한다. (install.sh 와 동일한 로직)
IP="$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
[ -n "$IP" ] || IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
printf '\n\033[1;32m업데이트 완료\033[0m  ->  http://%s:%s/\n\n' "${IP:-<서버IP>}" "$PORT"
