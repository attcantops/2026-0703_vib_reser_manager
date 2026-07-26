// app/api/reservations/route.js
// GET  /api/reservations?machine=..&date=..  → 해당 장비/날짜의 예약현황
// POST /api/reservations                      → 예약(여러 시간 한번에, 검증+충돌검사)

import { CONFIG, getReservations, addReservation } from '../../lib/db';

export const dynamic = 'force-dynamic';

// -----------------------------------------------------------------------------
// GET: 예약현황 조회
// -----------------------------------------------------------------------------
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const machine = searchParams.get('machine') || CONFIG.machines[0];
  const date = searchParams.get('date');

  if (!date) {
    return Response.json({ error: '날짜(date)가 필요합니다.' }, { status: 400 });
  }

  const reservations = getReservations(machine, date);
  return Response.json({ machine, date, reservations });
}

// -----------------------------------------------------------------------------
// POST: 예약하기
//   body: { machine, date, hours:[..], name, dept?, memo?, email? }
//   검증: 비어있지 않음 / maxHours 이내 / 연속된 시간 / 충돌검사
// -----------------------------------------------------------------------------
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: '잘못된 요청 형식입니다.' }, { status: 400 });
  }

  const {
    machine = CONFIG.machines[0],
    date,
    hours,
    name,
    dept,
    memo,
    email,
  } = body || {};

  // 1) 필수값 검사
  if (!date) {
    return Response.json({ error: '날짜를 선택해 주세요.' }, { status: 400 });
  }
  if (!name || !name.trim()) {
    return Response.json({ error: '예약자 이름을 입력해 주세요.' }, { status: 400 });
  }
  if (!Array.isArray(hours) || hours.length === 0) {
    return Response.json({ error: '예약할 시간을 1개 이상 선택해 주세요.' }, { status: 400 });
  }

  // 2) 시간값 정리(정수화·중복제거·정렬) 및 범위 검사
  const sorted = Array.from(new Set(hours.map((h) => Number(h)))).sort((a, b) => a - b);
  for (const h of sorted) {
    if (!Number.isInteger(h) || h < CONFIG.startHour || h >= CONFIG.endHour) {
      return Response.json(
        { error: `예약 가능한 시간(${CONFIG.startHour}시~${CONFIG.endHour - 1}시)을 벗어났습니다.` },
        { status: 400 }
      );
    }
  }

  // 3) maxHours 이내
  if (sorted.length > CONFIG.maxHours) {
    return Response.json(
      { error: `한 번에 최대 ${CONFIG.maxHours}시간까지만 예약할 수 있습니다.` },
      { status: 400 }
    );
  }

  // 4) 연속된 시간인지 검사 (예: 9,10,11 은 OK / 9,11 은 불가)
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] !== sorted[i - 1] + 1) {
      return Response.json(
        { error: '연속된 시간만 한 번에 예약할 수 있습니다.' },
        { status: 400 }
      );
    }
  }

  // 5) 충돌검사 + 저장 (충돌 시 전부 취소 = 아무것도 저장 안 함)
  const result = addReservation({
    machine,
    date,
    hours: sorted,
    name: name.trim(),
    dept,
    memo,
    email,
  });

  if (!result.ok) {
    const list = result.conflicts.map((h) => `${h}시`).join(', ');
    return Response.json(
      { error: `이미 예약된 시간이 있어 예약하지 못했습니다: ${list}` },
      { status: 409 }
    );
  }

  return Response.json(
    { ok: true, message: `예약 완료: ${sorted.map((h) => `${h}시`).join(', ')}`, created: result.created },
    { status: 201 }
  );
}
