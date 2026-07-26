# 진동시험기 예약 (PocketBase) — 시놀로지/QNAP NAS 및 Docker 환경용
#
# 라즈베리파이는 install.sh(systemd) 쪽이 더 간단하다. 이 Dockerfile 은
# Container Manager(시놀로지) / Container Station(QNAP) 처럼 Docker 로만
# 앱을 올릴 수 있는 NAS를 위한 것이다.
#
# arm64 / amd64 모두 지원 (buildx 의 TARGETARCH 로 자동 판별)

FROM alpine:3.20 AS build

# 재현 가능하도록 버전을 고정한다. 올릴 때는 이 값만 바꾸면 된다.
ARG PB_VERSION=0.39.9
ARG TARGETARCH

RUN apk add --no-cache curl unzip \
 && case "$TARGETARCH" in \
      arm64) PB_ARCH=arm64 ;; \
      arm)   PB_ARCH=armv7 ;; \
      amd64) PB_ARCH=amd64 ;; \
      *) echo "지원하지 않는 아키텍처: $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && curl -fsSL -o /tmp/pb.zip \
      "https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_${PB_ARCH}.zip" \
 && unzip -q /tmp/pb.zip -d /tmp/pb \
 && install -m 755 /tmp/pb/pocketbase /pocketbase


FROM alpine:3.20

RUN apk add --no-cache ca-certificates curl tzdata \
 && cp /usr/share/zoneinfo/Asia/Seoul /etc/localtime \
 && echo "Asia/Seoul" > /etc/timezone

COPY --from=build /pocketbase /app/pocketbase
COPY pb_public     /app/pb_public
COPY pb_migrations /app/pb_migrations

# 예약 데이터는 볼륨으로 빼서 컨테이너를 갈아끼워도 보존되게 한다.
VOLUME /app/pb_data

EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8090/api/health || exit 1

WORKDIR /app
CMD ["/app/pocketbase", "serve", \
     "--http=0.0.0.0:8090", \
     "--dir=/app/pb_data", \
     "--publicDir=/app/pb_public", \
     "--migrationsDir=/app/pb_migrations"]
