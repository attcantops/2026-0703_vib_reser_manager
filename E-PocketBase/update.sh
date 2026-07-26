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
#   --pb           PocketBase 실행파일도 최신 버전으로 함께 갱신
#   --rollback     직전 커밋으로 되돌리고 재시작

set -euo pipefail

APP_DIR="/opt/vibres"
SRC_DIR="$APP_DIR/repo/E-PocketBase"
SERVICE="vibres"
PORT="${PORT:-8090}"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m[오류] %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "root 권한이 필요합니다.  sudo $0 로 실행하세요."
[ -d "$APP_DIR/repo/.git" ] || die "설치본을 찾을 수 없습니다. install.sh 를 먼저 실행하세요."

DO_PB=""; DO_ROLLBACK=""
for a in "$@"; do
  case "$a" in
    --pb) DO_PB=1 ;;
    --rollback) DO_ROLLBACK=1 ;;
    *) die "알 수 없는 옵션: $a" ;;
  esac
done

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
  V="${PB_VERSION:-$(curl -fsSL https://api.github.com/repos/pocketbase/pocketbase/releases/latest \
      | grep -o '"tag_name": *"v[^"]*"' | head -1 | sed 's/.*"v\([^"]*\)".*/\1/')}"
  [ -n "$V" ] || die "버전 조회 실패"
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  curl -fsSL -o "$tmp/pb.zip" \
    "https://github.com/pocketbase/pocketbase/releases/download/v${V}/pocketbase_${V}_linux_${PB_ARCH}.zip" \
    || die "다운로드 실패"
  unzip -oq "$tmp/pb.zip" -d "$tmp"
  # 업그레이드 직전 DB 백업 (되돌릴 수 있게)
  cp -a "$APP_DIR/pb_data/data.db" "$APP_DIR/pb_data/data.db.bak-$(date +%Y%m%d%H%M%S)" 2>/dev/null || true
  install -m 755 "$tmp/pocketbase" "$APP_DIR/pocketbase"
  echo "  $("$APP_DIR/pocketbase" --version)"
fi

# ── 자기 자신 갱신 ───────────────────────────────────────────
# 이 스크립트는 /opt/vibres/update.sh (저장소 바깥)에서 실행된다.
# 저장소 쪽에 새 버전이 있으면 가져다 둔다. 실행 중인 파일을 직접 덮으면
# bash 가 나머지를 잘못 읽을 수 있으므로, 임시파일에 쓴 뒤 mv 로 교체한다.
if [ -f "$SRC_DIR/update.sh" ] && ! cmp -s "$SRC_DIR/update.sh" "$APP_DIR/update.sh"; then
  cp "$SRC_DIR/update.sh" "$APP_DIR/update.sh.new"
  chmod 755 "$APP_DIR/update.sh.new"
  mv -f "$APP_DIR/update.sh.new" "$APP_DIR/update.sh"
  echo "  update.sh 자체도 갱신됨 (다음 실행부터 적용)"
fi

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

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
printf '\n\033[1;32m업데이트 완료\033[0m  ->  http://%s:%s/\n\n' "${IP:-<서버IP>}" "$PORT"
