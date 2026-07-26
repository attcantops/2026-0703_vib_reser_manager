// app/api/cancel/route.js
// POST /api/cancel  → 예약 취소 (id + name, 이름이 일치해야 취소됨)

import { removeReservation } from '../../lib/db';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: '잘못된 요청 형식입니다.' }, { status: 400 });
  }

  const { id, name } = body || {};

  if (id === undefined || id === null || id === '') {
    return Response.json({ error: '취소할 예약 id가 필요합니다.' }, { status: 400 });
  }
  if (!name || !name.trim()) {
    return Response.json({ error: '예약자 이름을 입력해 주세요.' }, { status: 400 });
  }

  const result = removeReservation(id, name.trim());

  if (!result.ok) {
    if (result.reason === 'not_found') {
      return Response.json({ error: '해당 예약을 찾을 수 없습니다.' }, { status: 404 });
    }
    if (result.reason === 'name_mismatch') {
      return Response.json(
        { error: '예약자 이름이 일치하지 않아 취소할 수 없습니다.' },
        { status: 403 }
      );
    }
    return Response.json({ error: '취소하지 못했습니다.' }, { status: 400 });
  }

  return Response.json({ ok: true, message: '예약이 취소되었습니다.', removed: result.removed });
}
