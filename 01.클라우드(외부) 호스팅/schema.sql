-- 진동시험기 예약 DB 스키마 (Cloudflare D1 / SQLite)
-- 예약 1건 = 1시간 = 1행

CREATE TABLE IF NOT EXISTS reservations (
  id         TEXT PRIMARY KEY,   -- 8자리 짧은 ID
  machine    TEXT NOT NULL,      -- 장비명
  date       TEXT NOT NULL,      -- 'YYYY-MM-DD'
  hour       INTEGER NOT NULL,   -- 예약 시각(0~23), 그 시각부터 1시간
  name       TEXT NOT NULL,      -- 예약자
  dept       TEXT,               -- 부서/연락처
  memo       TEXT,               -- 메모
  email      TEXT,               -- 예약자 이메일(선택)
  created_at TEXT,               -- 신청 일시(ISO)
  reminded   INTEGER DEFAULT 0   -- 시작 전 알림 발송 여부(0/1)
);

-- 같은 장비+날짜+시각은 한 건만 (중복 예약 원천 차단)
CREATE UNIQUE INDEX IF NOT EXISTS idx_slot ON reservations (machine, date, hour);

-- 통계/조회 속도용
CREATE INDEX IF NOT EXISTS idx_date    ON reservations (date);
CREATE INDEX IF NOT EXISTS idx_machine ON reservations (machine);
