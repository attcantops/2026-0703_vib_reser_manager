// ============================================================================
// 진동시험기 예약 웹앱 — Deno Deploy 버전 (main.ts)
// ----------------------------------------------------------------------------
// Deno Deploy = TypeScript/JS 네이티브 엣지 런타임. Deno.serve() 로 HTTP 요청을
// 처리하고, 데이터는 내장 키-값 저장소 Deno KV (Deno.openKv()) 에 저장한다.
// 핵심: KV 키 ["res", machine, date, hour] 자체가 유일하므로, atomic() 의
// check(=값이 없어야 함) 조건을 걸면 (machine,date,hour) 중복예약이 원천 차단된다.
// ============================================================================

// ---------- 설정(CONFIG) ----------
const CONFIG = {
  machines: ["진동시험기 1호"], // 장비 목록 (여러 대로 확장 가능)
  startHour: 8,                  // 예약 시작 시각
  endHour: 20,                   // 예약 종료 경계 (예약 가능 시각은 8..19)
  maxHours: 8,                   // 1회 연속 최대 예약 시간
};

// ---------- 예약 데이터 타입 ----------
interface Reservation {
  id: string;
  machine: string;
  date: string;   // 'YYYY-MM-DD'
  hour: number;   // 8~19 (8 이면 08:00~09:00)
  name: string;   // 예약자(필수)
  dept?: string;  // 부서(선택)
  memo?: string;  // 메모(선택)
  email?: string; // 이메일(선택)
  created_at: string;
}

// Deno KV 열기 (Deploy 환경에서는 자동으로 글로벌 분산 KV에 연결됨)
const kv = await Deno.openKv();

// ---------- 유틸: JSON 응답 ----------
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// 간단한 고유 ID 생성
function newId(): string {
  return crypto.randomUUID();
}

// ============================================================================
// API 핸들러들
// ============================================================================

// [GET] /api/config — 프론트에 설정 전달
function handleConfig(): Response {
  return json({ ok: true, config: CONFIG });
}

// [GET] /api/reservations?machine=..&date=YYYY-MM-DD
//  → 특정 장비+날짜의 시각별 예약 목록
async function handleListByDate(url: URL): Promise<Response> {
  const machine = url.searchParams.get("machine") ?? CONFIG.machines[0];
  const date = url.searchParams.get("date");
  if (!date) return json({ ok: false, error: "date 파라미터가 필요합니다." }, 400);

  // prefix ["res", machine, date] 로 해당 날짜의 모든 시간 행을 나열
  const list = kv.list<Reservation>({ prefix: ["res", machine, date] });
  const items: Reservation[] = [];
  for await (const entry of list) items.push(entry.value);
  items.sort((a, b) => a.hour - b.hour);

  return json({ ok: true, machine, date, reservations: items });
}

// [GET] /api/reservations/search?name=..&from=YYYY-MM-DD&to=YYYY-MM-DD
//  → (선택 기능) 기간+이름으로 예약 조회
async function handleSearch(url: URL): Promise<Response> {
  const name = (url.searchParams.get("name") ?? "").trim();
  const from = url.searchParams.get("from") ?? "0000-00-00";
  const to = url.searchParams.get("to") ?? "9999-99-99";
  if (!name) return json({ ok: false, error: "name 파라미터가 필요합니다." }, 400);

  // 모든 장비의 예약을 훑어 이름/기간으로 필터 (소규모라 전수 스캔 허용)
  const items: Reservation[] = [];
  for (const machine of CONFIG.machines) {
    const list = kv.list<Reservation>({ prefix: ["res", machine] });
    for await (const entry of list) {
      const r = entry.value;
      if (r.name === name && r.date >= from && r.date <= to) items.push(r);
    }
  }
  items.sort((a, b) => (a.date + a.hour).localeCompare(b.date + String(b.hour)));
  return json({ ok: true, name, from, to, reservations: items });
}

// [POST] /api/reservations
//  body: { machine, date, hours:[...], name, dept?, memo?, email? }
//  → 여러 시간을 한번에 예약. 검증(비어있지않음/maxHours/연속/충돌) 후 atomic 커밋.
async function handleReserve(req: Request): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "요청 형식이 올바르지 않습니다." }, 400);
  }

  const machine: string = body.machine ?? CONFIG.machines[0];
  const date: string = body.date;
  const hours: number[] = Array.isArray(body.hours) ? body.hours.map(Number) : [];
  const name: string = (body.name ?? "").trim();
  const dept: string = (body.dept ?? "").trim();
  const memo: string = (body.memo ?? "").trim();
  const email: string = (body.email ?? "").trim();

  // --- 서버측 검증 ---
  if (!CONFIG.machines.includes(machine))
    return json({ ok: false, error: "알 수 없는 장비입니다." }, 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? ""))
    return json({ ok: false, error: "날짜 형식이 올바르지 않습니다." }, 400);
  if (!name)
    return json({ ok: false, error: "예약자 이름은 필수입니다." }, 400);
  if (hours.length === 0)
    return json({ ok: false, error: "예약할 시간을 하나 이상 선택하세요." }, 400);
  if (hours.length > CONFIG.maxHours)
    return json({ ok: false, error: `연속 최대 ${CONFIG.maxHours}시간까지만 예약할 수 있습니다.` }, 400);

  // 시간 범위 및 정수 검증
  for (const h of hours) {
    if (!Number.isInteger(h) || h < CONFIG.startHour || h >= CONFIG.endHour)
      return json({ ok: false, error: `예약 가능 시각은 ${CONFIG.startHour}시~${CONFIG.endHour - 1}시 입니다.` }, 400);
  }

  // 연속성 검증: 정렬 후 인접 차이가 모두 1이어야 함
  const sorted = [...new Set(hours)].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] !== 1)
      return json({ ok: false, error: "연속된 시간만 한 번에 예약할 수 있습니다." }, 400);
  }

  // --- atomic 커밋: 모든 (machine,date,hour) 키가 '비어있을 때만' 성공 ---
  // check() 로 각 키의 versionstamp 가 null(=값 없음)인지 확인 → 하나라도 이미
  // 있으면 커밋 실패(ok:false) → 전부 취소되고 충돌 메시지 반환.
  const created_at = new Date().toISOString();
  const created: Reservation[] = [];
  let atomic = kv.atomic();

  for (const hour of sorted) {
    const resKey = ["res", machine, date, hour];
    const id = newId();
    const rec: Reservation = { id, machine, date, hour, name, dept, memo, email, created_at };
    // 이 키가 아직 없어야 함(중복예약 원천 차단)
    atomic = atomic.check({ key: resKey, versionstamp: null })
      .set(resKey, rec)
      // id → 위치 보조 인덱스 (취소 시 id 로 빠르게 역참조)
      .set(["byid", id], { machine, date, hour });
    created.push(rec);
  }

  const result = await atomic.commit();
  if (!result.ok) {
    // 하나라도 이미 예약되어 있으면 전체 실패 → 어떤 시간이 충돌인지 다시 조회해 알려줌
    const conflicts: number[] = [];
    for (const hour of sorted) {
      const got = await kv.get(["res", machine, date, hour]);
      if (got.value !== null) conflicts.push(hour);
    }
    return json({
      ok: false,
      error: "선택한 시간 중 이미 예약된 시간이 있어 예약이 취소되었습니다.",
      conflicts,
    }, 409);
  }

  return json({ ok: true, message: "예약이 완료되었습니다.", reservations: created });
}

// [POST] /api/reservations/cancel
//  body: { id, name }
//  → id 로 예약을 찾고, 이름이 일치할 때만 취소.
async function handleCancel(req: Request): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "요청 형식이 올바르지 않습니다." }, 400);
  }
  const id: string = body.id;
  const name: string = (body.name ?? "").trim();
  if (!id) return json({ ok: false, error: "예약 id 가 필요합니다." }, 400);
  if (!name) return json({ ok: false, error: "본인 이름을 입력해야 취소할 수 있습니다." }, 400);

  // 보조 인덱스로 위치 역참조
  const idx = await kv.get<{ machine: string; date: string; hour: number }>(["byid", id]);
  if (!idx.value) return json({ ok: false, error: "해당 예약을 찾을 수 없습니다." }, 404);

  const { machine, date, hour } = idx.value;
  const resKey = ["res", machine, date, hour];
  const cur = await kv.get<Reservation>(resKey);
  if (!cur.value) {
    // 본체는 없고 인덱스만 남은 경우 인덱스 정리
    await kv.delete(["byid", id]);
    return json({ ok: false, error: "해당 예약을 찾을 수 없습니다." }, 404);
  }

  // 이름 일치 검증
  if (cur.value.name !== name) {
    return json({ ok: false, error: "예약자 이름이 일치하지 않아 취소할 수 없습니다." }, 403);
  }

  // atomic 으로 본체 + 인덱스 함께 삭제 (그 사이 변경 없었는지 versionstamp 확인)
  const del = await kv.atomic()
    .check({ key: resKey, versionstamp: cur.versionstamp })
    .delete(resKey)
    .delete(["byid", id])
    .commit();

  if (!del.ok) return json({ ok: false, error: "취소 처리 중 충돌이 발생했습니다. 다시 시도하세요." }, 409);
  return json({ ok: true, message: "예약이 취소되었습니다." });
}

// ---------- 정적 index.html 서빙 ----------
async function serveIndex(): Promise<Response> {
  try {
    const html = await Deno.readTextFile(new URL("./public/index.html", import.meta.url));
    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  } catch {
    return new Response("index.html 을 찾을 수 없습니다.", { status: 500 });
  }
}

// ============================================================================
// 라우터: Deno.serve 진입점
// ============================================================================
Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const path = url.pathname;

  // --- API 경로 ---
  if (path.startsWith("/api/")) {
    if (path === "/api/config" && req.method === "GET") return handleConfig();
    if (path === "/api/reservations" && req.method === "GET") return await handleListByDate(url);
    if (path === "/api/reservations/search" && req.method === "GET") return await handleSearch(url);
    if (path === "/api/reservations" && req.method === "POST") return await handleReserve(req);
    if (path === "/api/reservations/cancel" && req.method === "POST") return await handleCancel(req);
    return json({ ok: false, error: "알 수 없는 API 경로입니다." }, 404);
  }

  // --- 그 외: 정적 페이지 ---
  return await serveIndex();
});

// ── 확장 가능: 통계/CSV 내보내기/반복예약(매주 같은 시간) 등은 여기에 API를
//    추가하면 된다. 예: GET /api/stats, GET /api/export.csv
