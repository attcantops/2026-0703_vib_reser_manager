// app/lib/db.js
// =============================================================================
//  DB 어댑터 (감 익히기용 인메모리 버전)
// =============================================================================
//  이 파일은 예약 데이터를 저장/조회하는 "데이터 계층"입니다.
//  지금은 서버 메모리(모듈 스코프 배열)에 저장하므로 별도 설치 없이
//  `npm run dev` 만으로 바로 동작합니다.
//
//  ⚠️ 인메모리의 한계:
//    - 서버를 재시작하면(코드 저장/재배포 포함) 데이터가 전부 초기화됩니다.
//    - Vercel 같은 서버리스 환경에서는 요청마다 다른 인스턴스가 뜰 수 있어
//      데이터가 유지되지 않을 수 있습니다. → "동작 감 잡기"용으로만 쓰세요.
//
//  🔁 운영(실제 사용) 전환 방법:
//    아래 함수들의 "내부 구현"만 Vercel Postgres 또는 Supabase 로 바꾸면
//    나머지 코드(API Route, 화면)는 그대로 재사용됩니다.
//    ───────────────────────────────────────────────────────────────────────
//    [교체 지점 ①] getReservations / addReservation / removeReservation 의
//                  몸통을 실제 DB 쿼리로 교체.
//    [교체 지점 ②] UNIQUE(machine, date, hour) 제약은 실제 DB에서는
//                  테이블에 UNIQUE 인덱스로 걸어두는 것을 권장.
//
//    예) Supabase 테이블 SQL:
//      create table reservations (
//        id          bigserial primary key,
//        machine     text not null,
//        date        text not null,        -- 'YYYY-MM-DD'
//        hour        int  not null,         -- 8..19
//        name        text not null,
//        dept        text,
//        memo        text,
//        email       text,
//        created_at  timestamptz default now(),
//        unique (machine, date, hour)       -- 중복예약 원천차단
//      );
// =============================================================================

// -----------------------------------------------------------------------------
// 설정값 (CONFIG) — 화면/검증 로직에서 공통으로 사용
// -----------------------------------------------------------------------------
export const CONFIG = {
  machines: ['진동시험기 1호'],
  startHour: 8,   // 예약 시작 시각
  endHour: 20,    // 예약 종료 경계 (실제 예약 가능 시각은 8..19)
  maxHours: 8,    // 한 번에 예약 가능한 연속 최대 시간
};

// -----------------------------------------------------------------------------
// 인메모리 저장소
// -----------------------------------------------------------------------------
// Next.js 개발 모드는 파일 변경 시 모듈을 다시 평가할 수 있어,
// globalThis 에 저장해 두면 핫리로드 중에도 데이터가 조금 더 잘 유지됩니다.
const store = globalThis.__vibrationStore__ || {
  reservations: [], // 예약 배열 (각 원소 = 1시간 1건)
  nextId: 1,        // 자동 증가 id
};
globalThis.__vibrationStore__ = store;

// -----------------------------------------------------------------------------
// 조회: 특정 machine + date 의 모든 예약
// -----------------------------------------------------------------------------
export function getReservations(machine, date) {
  // [교체 지점 ①] 실제 DB에서는:
  //   select * from reservations where machine = $1 and date = $2
  return store.reservations
    .filter((r) => r.machine === machine && r.date === date)
    .sort((a, b) => a.hour - b.hour);
}

// -----------------------------------------------------------------------------
// 특정 (machine, date, hour) 가 이미 예약됐는지 검사 — UNIQUE 흉내
// -----------------------------------------------------------------------------
export function isTaken(machine, date, hour) {
  return store.reservations.some(
    (r) => r.machine === machine && r.date === date && r.hour === hour
  );
}

// -----------------------------------------------------------------------------
// 예약 추가: hours 배열을 한 번에 (검증은 API Route 에서 수행)
//   - 충돌이 하나라도 있으면 아무것도 저장하지 않고 실패를 알린다.
// -----------------------------------------------------------------------------
export function addReservation({ machine, date, hours, name, dept, memo, email }) {
  // 1) 충돌 선검사 (UNIQUE(machine,date,hour) 흉내)
  const conflicts = hours.filter((h) => isTaken(machine, date, h));
  if (conflicts.length > 0) {
    return { ok: false, conflicts };
  }

  // 2) 전부 추가 (원자적으로 — 위에서 충돌 없음을 이미 확인)
  // [교체 지점 ①] 실제 DB에서는 트랜잭션으로 여러 row insert
  const created = [];
  const createdAt = new Date().toISOString();
  for (const hour of hours) {
    const row = {
      id: store.nextId++,
      machine,
      date,
      hour,
      name,
      dept: dept || '',
      memo: memo || '',
      email: email || '',
      created_at: createdAt,
    };
    store.reservations.push(row);
    created.push(row);
  }
  return { ok: true, created };
}

// -----------------------------------------------------------------------------
// 취소: id + name. 이름이 일치해야 삭제 성공.
// -----------------------------------------------------------------------------
export function removeReservation(id, name) {
  const idx = store.reservations.findIndex((r) => r.id === Number(id));
  if (idx === -1) {
    return { ok: false, reason: 'not_found' };
  }
  if (store.reservations[idx].name !== name) {
    return { ok: false, reason: 'name_mismatch' };
  }
  // [교체 지점 ①] 실제 DB에서는:
  //   delete from reservations where id = $1 and name = $2
  const [removed] = store.reservations.splice(idx, 1);
  return { ok: true, removed };
}

// -----------------------------------------------------------------------------
// (선택/확장 가능) 기간 + 이름 조회 목록
//   화면에서 아직 쓰지 않지만 확장용으로 남겨둠.
// -----------------------------------------------------------------------------
export function listByNameAndRange(name, fromDate, toDate) {
  return store.reservations
    .filter(
      (r) =>
        r.name === name &&
        r.date >= fromDate &&
        r.date <= toDate
    )
    .sort((a, b) => (a.date + a.hour).localeCompare(b.date + b.hour));
}
