#!/usr/bin/env bash
#
# 진동시험기 예약 (PocketBase) — 최초 1회 설치 스크립트
#
# 담당자가 라즈베리파이/NAS/리눅스 서버에서 딱 한 번만 실행하면 된다.
#
#   curl -fsSL https://raw.githubusercontent.com/attcantops/2026-0703_vib_reser_manager/main/E-PocketBase/install.sh | sudo bash
#
# 이 스크립트가 하는 일
#   1) CPU 아키텍처 자동 판별 후 PocketBase 실행파일 설치
#   2) 이 저장소를 /opt/vibres/repo 로 clone
#   3) 부팅 시 자동 실행되도록 systemd 서비스 등록
#
# 설치 후 업데이트는 update.sh 로 한다. 이 스크립트를 다시 돌릴 필요는 없다.
# 예약 데이터(pb_data)는 저장소 바깥에 두므로 업데이트해도 절대 지워지지 않는다.

set -euo pipefail

APP_DIR="/opt/vibres"
REPO_URL="https://github.com/attcantops/2026-0703_vib_reser_manager.git"
SRC_DIR="$APP_DIR/repo/E-PocketBase"
PORT="${PORT:-8090}"
SERVICE="vibres"
# 특정 버전으로 고정하려면 PB_VERSION=0.39.9 형태로 환경변수를 주면 된다.
PB_VERSION="${PB_VERSION:-}"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m[오류] %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "root 권한이 필요합니다.  sudo bash install.sh 로 실행하세요."

# ── 1. 필수 도구 ─────────────────────────────────────────────
log "필수 패키지 확인 (curl, unzip, git)"
missing=""
for c in curl unzip git; do command -v "$c" >/dev/null 2>&1 || missing="$missing $c"; done
if [ -n "$missing" ]; then
  echo "설치할 패키지:$missing"
  # 이 스크립트는 `curl ... | sudo bash` 로 실행된다. 그 경우 stdin 은 스크립트 본문
  # 자체이므로, stdin 을 읽는 명령(apt-get 등)이 남은 스크립트를 삼켜 설치가 중간에
  # 깨진다. 그래서 apt 계열은 반드시 stdin 을 /dev/null 로 막고 비대화형으로 돌린다.
  export DEBIAN_FRONTEND=noninteractive
  if   command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq </dev/null && apt-get install -y -qq $missing </dev/null
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y $missing </dev/null
  elif command -v opkg >/dev/null 2>&1; then
    opkg update </dev/null && opkg install $missing </dev/null
  else die "패키지 관리자를 찾을 수 없습니다. 다음을 직접 설치하세요:$missing"
  fi
  for c in curl unzip git; do
    command -v "$c" >/dev/null 2>&1 || die "$c 설치에 실패했습니다. 직접 설치 후 다시 실행하세요."
  done
fi

# ── 2. 아키텍처 판별 ─────────────────────────────────────────
log "CPU 아키텍처 확인"
case "$(uname -m)" in
  aarch64|arm64) PB_ARCH="arm64" ;;
  armv7l|armv6l) PB_ARCH="armv7" ;;
  x86_64|amd64)  PB_ARCH="amd64" ;;
  *) die "지원하지 않는 아키텍처입니다: $(uname -m)" ;;
esac
echo "  $(uname -m)  ->  linux_${PB_ARCH}"

# ── 3. PocketBase 실행파일 설치 ──────────────────────────────
if [ -z "$PB_VERSION" ]; then
  log "PocketBase 최신 버전 조회"
  PB_VERSION="$(curl -fsSL https://api.github.com/repos/pocketbase/pocketbase/releases/latest \
                | grep -o '"tag_name": *"v[^"]*"' | head -1 | sed 's/.*"v\([^"]*\)".*/\1/')"
  [ -n "$PB_VERSION" ] || die "버전 조회 실패. 인터넷 연결을 확인하거나 PB_VERSION=0.39.9 처럼 직접 지정하세요."
fi
log "PocketBase v${PB_VERSION} 다운로드"
mkdir -p "$APP_DIR"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
zip="pocketbase_${PB_VERSION}_linux_${PB_ARCH}.zip"
curl -fsSL -o "$tmp/pb.zip" \
  "https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/${zip}" \
  || die "다운로드 실패: $zip"
unzip -oq "$tmp/pb.zip" -d "$tmp"
install -m 755 "$tmp/pocketbase" "$APP_DIR/pocketbase"
echo "  설치됨: $("$APP_DIR/pocketbase" --version)"

# ── 4. 소스 내려받기 ─────────────────────────────────────────
# depth 를 1 이 아니라 넉넉히 받는다. --depth 1 로 받으면 커밋이 1개뿐이라
# update.sh --rollback 의 HEAD~1 이 존재하지 않아 롤백이 불가능해진다.
GIT_DEPTH=20
if [ -d "$APP_DIR/repo/.git" ]; then
  log "기존 소스 발견 — 최신으로 갱신"
  git -C "$APP_DIR/repo" fetch --depth "$GIT_DEPTH" origin main
  git -C "$APP_DIR/repo" reset --hard origin/main
else
  log "소스 clone"
  rm -rf "$APP_DIR/repo"
  git clone --depth "$GIT_DEPTH" "$REPO_URL" "$APP_DIR/repo"
fi
[ -f "$SRC_DIR/pb_public/index.html" ] || die "소스 구조가 예상과 다릅니다: $SRC_DIR"

# 예약 데이터는 저장소 바깥에 둔다 (git pull 로 절대 덮이지 않게)
mkdir -p "$APP_DIR/pb_data"

# update.sh 는 반드시 저장소 "바깥"에 설치한다.
# 저장소 안의 것을 직접 실행하면, --rollback 으로 update.sh 가 없던 시점까지
# 되돌아갔을 때 스크립트가 스스로 사라져 다시 앞으로 갈 수단이 없어진다.
install -m 755 "$SRC_DIR/update.sh" "$APP_DIR/update.sh"

# ── 5. systemd 서비스 등록 ───────────────────────────────────
log "부팅 시 자동 실행 등록 (systemd: ${SERVICE})"
cat > "/etc/systemd/system/${SERVICE}.service" <<EOF
[Unit]
Description=진동시험기 예약 (PocketBase)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
ExecStart=${APP_DIR}/pocketbase serve \\
  --http=0.0.0.0:${PORT} \\
  --dir=${APP_DIR}/pb_data \\
  --publicDir=${SRC_DIR}/pb_public \\
  --migrationsDir=${SRC_DIR}/pb_migrations
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1
systemctl restart "$SERVICE"

# ── 6. 기동 확인 ─────────────────────────────────────────────
log "서버 기동 확인"
ok=""
for i in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
[ -n "$ok" ] || { journalctl -u "$SERVICE" -n 30 --no-pager || true; die "서버가 뜨지 않았습니다. 위 로그를 확인하세요."; }

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "$IP" ] || IP="<서버IP>"

# 색상은 printf 로 낸다. cat 히어독 안에서는 \033 이 글자 그대로 출력된다.
printf '\n\033[1;32m========== 설치 완료 ==========\033[0m\n'

cat <<EOF

  예약 화면    http://${IP}:${PORT}/
  관리자 화면  http://${IP}:${PORT}/_/

다음 할 일 (최초 1회):
  1) 관리자 화면에 접속해 관리자 이메일/비밀번호를 만드세요.
     터미널에서 바로 만들려면:
       sudo ${APP_DIR}/pocketbase --dir=${APP_DIR}/pb_data superuser upsert <이메일> <비밀번호>
     (upsert = 없으면 생성, 있으면 비밀번호 변경. 비밀번호를 잊었을 때도 이 명령을 씁니다)
  2) 예약 화면이 정상적으로 뜨는지 확인하세요.
     (reservations 컬렉션은 자동 생성되므로 따로 만들 필요 없습니다)

상태 확인 / 로그
  sudo systemctl status ${SERVICE}
  sudo journalctl -u ${SERVICE} -f

이후 업데이트 (SSH 접속 후)
  sudo ${APP_DIR}/update.sh

EOF
