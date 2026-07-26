// app/api/config/route.js
// GET /api/config  →  화면이 초기 설정(CONFIG)을 받아가는 엔드포인트

import { CONFIG } from '../../lib/db';

// 인메모리 저장소를 쓰므로 정적 캐시가 아닌 매 요청 실행되게 함
export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json(CONFIG);
}
