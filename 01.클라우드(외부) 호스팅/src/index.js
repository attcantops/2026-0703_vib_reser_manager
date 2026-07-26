/**
 * 진동시험기 예약 사이트 - B안 (Cloudflare Workers + D1)
 * ------------------------------------------------------------
 * - 구글에 의존하지 않는 자체 웹앱 + 데이터베이스(D1/SQLite).
 * - 링크 하나로 10층/12층 어디서든 예약. A안(구글시트)과 기능 동일 + 월별 통계 추가.
 *
 * ▼ 운영 방식은 아래 CONFIG 로 조정합니다.
 */
const CONFIG = {
  machines: ['진동시험기 1호'], // 장비 여러 대면 ['진동시험기 1호','진동시험기 2호']
  startHour: 8,                 // 예약 가능 시작 시각 (0~23)
  endHour: 20,                  // 예약 가능 종료 시각 (1~24)
  maxHours: 8,                  // 한 번에 예약 가능한 최대 연속 시간

  // ▼ 메일 설정 (Resend API 사용) --------------------------------
  adminEmail: 'btkang@cantops.biz', // 담당자 메일(예약 알림 수신). 비우면 담당자 알림 안 감
  fromEmail: 'noreply@notify.cantops.biz', // 발신 주소(Resend에서 인증한 도메인). 아래 setup 안내 참고
  fromName: '진동시험기 예약',      // 발신자 표시 이름
  notifyAdmin: true,            // 예약/취소 시 담당자에게 메일
  notifyReserver: true,         // 예약자가 이메일 입력 시 확인 메일
  reminderMinutes: 30,          // 예약 시작 몇 분 전 알림
  remindAdmin: false,           // 시작 전 알림을 담당자에게도 보낼지
  // RESEND_API_KEY 는 코드에 넣지 않고 Cloudflare 시크릿으로 저장합니다(setup 안내).
};

/* ---------------- 공통 유틸 ---------------- */
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
function hhmm(h) { return ('0' + h).slice(-2) + ':00'; }
function uid() { return crypto.randomUUID().slice(0, 8); }

/** 시간 배열이 '연속 + 최대시간 이내'인지 검사. 문제 있으면 메시지, 없으면 null. */
function validateHours(hours) {
  if (!hours || hours.length === 0) return '시간을 선택해 주세요.';
  if (hours.length > CONFIG.maxHours) return '최대 ' + CONFIG.maxHours + '시간까지 예약할 수 있습니다.';
  const sorted = hours.slice().sort(function (a, b) { return a - b; });
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] !== sorted[i - 1] + 1) return '연속된 시간만 예약할 수 있습니다.';
  }
  return null;
}

/** 예약 1건(또는 연속 시간)을 사람이 읽기 좋은 본문으로. */
function buildBody(machine, date, hours, name, dept, memo) {
  const s = Math.min.apply(null, hours), e = Math.max.apply(null, hours) + 1;
  let body = '예약자 : ' + name + (dept ? ' (' + dept + ')' : '') + '\n';
  body += '장비 : ' + machine + '\n';
  body += '날짜 : ' + date + '\n';
  body += '시간 : ' + hhmm(s) + ' ~ ' + hhmm(e) + '\n';
  if (memo) body += '메모 : ' + memo + '\n';
  return body;
}

/**
 * Resend API 로 메일 발송. RESEND_API_KEY 시크릿이 없으면 조용히 건너뜁니다.
 * 반환 Promise 는 호출부에서 ctx.waitUntil() 로 감싸 응답을 막지 않게 합니다.
 */
function sendMail(env, to, subject, body) {
  if (!env.RESEND_API_KEY || !to) return Promise.resolve();
  return fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: CONFIG.fromName + ' <' + CONFIG.fromEmail + '>',
      to: [String(to).trim()],
      subject: subject,
      text: body,
    }),
  }).catch(function () { /* 메일 실패는 예약에 영향 주지 않음 */ });
}

/** 예약/취소 알림을 담당자 + (있으면) 예약자에게 보냅니다. */
function notify(env, ctx, subject, body, reserverEmail) {
  if (CONFIG.notifyAdmin && CONFIG.adminEmail) ctx.waitUntil(sendMail(env, CONFIG.adminEmail, subject, body));
  if (CONFIG.notifyReserver && reserverEmail) ctx.waitUntil(sendMail(env, reserverEmail, subject, body));
}

const INSERT_SQL =
  'INSERT INTO reservations (id,machine,date,hour,name,dept,memo,email,created_at,reminded) VALUES (?,?,?,?,?,?,?,?,?,0)';

/* ---------------- 엔트리 포인트 ---------------- */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path.startsWith('/api/')) {
      try {
        return await handleApi(request, env, ctx, url, path);
      } catch (e) {
        return json({ ok: false, message: '서버 오류: ' + e.message }, 500);
      }
    }
    // 그 외 경로는 정적 파일(public/) 서빙
    return env.ASSETS.fetch(request);
  },

  // Cron 트리거: 예약 시작 전 알림 메일 (wrangler.jsonc triggers.crons 로 5분마다 호출)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(reminderCheck(env));
  },
};

/**
 * 시작 reminderMinutes 분 전인 예약을 찾아 예약자에게 알림 메일 발송.
 * 같은 예약(같은 신청일시)은 한 번만 보내고 reminded=1 로 중복 방지.
 * 한국시간 기준으로 시작시각을 계산합니다(+09:00).
 */
async function reminderCheck(env) {
  const windowMs = CONFIG.reminderMinutes * 60 * 1000;
  const now = Date.now();
  const { results } = await env.DB
    .prepare("SELECT id, date, hour, machine, name, dept, memo, email, created_at FROM reservations WHERE reminded=0 AND email IS NOT NULL AND email!='' ORDER BY date, hour")
    .all();

  const groups = {};
  for (const r of results) {
    const key = r.date + '|' + r.machine + '|' + r.name + '|' + (r.created_at || '');
    if (!groups[key]) groups[key] = { date: r.date, machine: r.machine, name: r.name, dept: r.dept, memo: r.memo, email: r.email, hours: [], ids: [] };
    groups[key].hours.push(r.hour);
    groups[key].ids.push(r.id);
  }

  for (const key of Object.keys(groups)) {
    const g = groups[key];
    const startHour = Math.min.apply(null, g.hours);
    const startMs = Date.parse(g.date + 'T' + ('0' + startHour).slice(-2) + ':00:00+09:00');
    const diff = startMs - now;
    if (diff > 0 && diff <= windowMs) {
      let body = buildBody(g.machine, g.date, g.hours, g.name, g.dept, g.memo);
      body += '\n※ 약 ' + CONFIG.reminderMinutes + '분 후 예약이 시작됩니다.';
      await sendMail(env, g.email, '[진동시험기] 예약 시작 ' + CONFIG.reminderMinutes + '분 전 알림', body);
      if (CONFIG.remindAdmin) await sendMail(env, CONFIG.adminEmail, '[진동시험기] 곧 시작 - ' + g.name, body);
      const ph = g.ids.map(function () { return '?'; }).join(',');
      await env.DB.prepare('UPDATE reservations SET reminded=1 WHERE id IN (' + ph + ')').bind(...g.ids).run();
    }
  }
}

/* ---------------- API 라우터 ---------------- */
async function handleApi(request, env, ctx, url, path) {
  const method = request.method;

  if (path === '/api/config' && method === 'GET') {
    return json({
      machines: CONFIG.machines,
      startHour: CONFIG.startHour,
      endHour: CONFIG.endHour,
      maxHours: CONFIG.maxHours,
    });
  }

  if (path === '/api/reservations' && method === 'GET') {
    const machine = url.searchParams.get('machine');
    const date = url.searchParams.get('date');
    const { results } = await env.DB
      .prepare('SELECT id, hour, name, dept, memo FROM reservations WHERE machine=? AND date=?')
      .bind(machine, date).all();
    const map = {};
    for (const r of results) map[String(r.hour)] = { id: r.id, name: r.name, dept: r.dept, memo: r.memo };
    return json(map);
  }

  if (path === '/api/reserve' && method === 'POST') return reserve(request, env, ctx);
  if (path === '/api/cancel' && method === 'POST') return cancel(request, env, ctx);
  if (path === '/api/cancel-group' && method === 'POST') return cancelGroup(request, env, ctx);
  if (path === '/api/recurring' && method === 'POST') return recurring(request, env, ctx);

  if (path.startsWith('/api/stats/') && method === 'GET') {
    return handleStats(env, url, path.slice('/api/stats/'.length));
  }

  if (path === '/api/export' && method === 'GET') return exportCsv(env, url);

  if (path === '/api/lookup' && method === 'GET') return lookup(env, url);

  return json({ ok: false, message: '잘못된 요청입니다.' }, 404);
}

/* ---------------- 예약 조회 (기간 + 이름 필터) ---------------- */
async function lookup(env, url) {
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const name = (url.searchParams.get('name') || '').trim();
  const machine = (url.searchParams.get('machine') || '').trim();

  const conds = [], bind = [];
  if (from) { conds.push('date>=?'); bind.push(from); }
  if (to) { conds.push('date<=?'); bind.push(to); }
  if (name) { conds.push('name LIKE ?'); bind.push('%' + name + '%'); }
  if (machine) { conds.push('machine=?'); bind.push(machine); }
  const where = conds.length ? conds.join(' AND ') : '1=1';

  // 연속 시간 예약을 한 줄로 묶기 위해 같은 (날짜·장비·예약자·신청일시) 로 그룹
  const { results } = await env.DB
    .prepare('SELECT id, date, hour, machine, name, dept, memo, created_at FROM reservations WHERE ' + where + ' ORDER BY date, hour')
    .bind(...bind).all();

  const groups = {};
  const order = [];
  for (const r of results) {
    const key = r.date + '|' + r.machine + '|' + r.name + '|' + (r.created_at || '');
    if (!groups[key]) { groups[key] = { date: r.date, machine: r.machine, name: r.name, dept: r.dept, memo: r.memo, hours: [], ids: [] }; order.push(key); }
    groups[key].hours.push(r.hour);
    groups[key].ids.push(r.id);
  }
  const list = order.map(function (k) {
    const g = groups[k];
    const hs = g.hours.slice().sort(function (a, b) { return a - b; });
    return {
      date: g.date, machine: g.machine, name: g.name, dept: g.dept, memo: g.memo,
      startHour: hs[0], endHour: hs[hs.length - 1] + 1, count: hs.length, ids: g.ids,
    };
  });
  return json({ count: list.length, list: list });
}

/* ---------------- 일반 예약 ---------------- */
async function reserve(request, env, ctx) {
  const d = await request.json();
  if (!d.name || !String(d.name).trim()) return json({ ok: false, message: '예약자 이름을 입력해 주세요.' });
  const err = validateHours(d.hours);
  if (err) return json({ ok: false, message: err });

  // 이미 예약된 시간대 확인
  const ph = d.hours.map(function () { return '?'; }).join(',');
  const { results: taken } = await env.DB
    .prepare('SELECT hour FROM reservations WHERE machine=? AND date=? AND hour IN (' + ph + ')')
    .bind(d.machine, d.date, ...d.hours).all();
  if (taken.length > 0) {
    const list = taken.map(function (t) { return t.hour + '시'; }).join(', ');
    return json({ ok: false, message: '이미 예약된 시간대가 있습니다: ' + list + '\n새로고침 후 다시 시도해 주세요.' });
  }

  const now = new Date().toISOString();
  const email = String(d.email || '').trim();
  const name = String(d.name).trim();
  const dept = String(d.dept || '').trim();
  const memo = String(d.memo || '').trim();
  const stmts = d.hours.map(function (h) {
    return env.DB.prepare(INSERT_SQL).bind(uid(), d.machine, d.date, h, name, dept, memo, email, now);
  });

  try {
    await env.DB.batch(stmts); // 원자적 실행 + UNIQUE 인덱스로 동시성 안전
  } catch (e) {
    return json({ ok: false, message: '방금 다른 예약과 겹쳤습니다. 새로고침 후 다시 시도해 주세요.' });
  }

  const body = buildBody(d.machine, d.date, d.hours, name, dept, memo);
  notify(env, ctx, '[진동시험기] 신규 예약 - ' + name, body, email);
  return json({ ok: true, message: '예약이 완료되었습니다.' });
}

/* ---------------- 취소 ---------------- */
async function cancel(request, env, ctx) {
  const { id, name } = await request.json();
  const row = await env.DB.prepare('SELECT machine, date, hour, name, dept, memo, email FROM reservations WHERE id=?').bind(id).first();
  if (!row) return json({ ok: false, message: '해당 예약을 찾을 수 없습니다.' });
  if (String(row.name).trim() !== String(name || '').trim()) {
    return json({ ok: false, message: '예약자 이름이 일치해야 취소할 수 있습니다.' });
  }
  await env.DB.prepare('DELETE FROM reservations WHERE id=?').bind(id).run();
  const body = buildBody(row.machine, row.date, [row.hour], row.name, row.dept, row.memo);
  notify(env, ctx, '[진동시험기] 예약 취소 - ' + row.name, body, row.email);
  return json({ ok: true, message: '예약이 취소되었습니다.' });
}

/** 여러 건(연속 시간 묶음)을 한 번에 취소. 이름이 모두 일치해야 함. */
async function cancelGroup(request, env, ctx) {
  const { ids, name } = await request.json();
  if (!ids || ids.length === 0) return json({ ok: false, message: '취소할 예약이 없습니다.' });
  const ph = ids.map(function () { return '?'; }).join(',');
  const { results } = await env.DB.prepare('SELECT id, machine, date, hour, name, dept, memo, email FROM reservations WHERE id IN (' + ph + ')').bind(...ids).all();
  if (results.length === 0) return json({ ok: false, message: '해당 예약을 찾을 수 없습니다.' });
  for (const r of results) {
    if (String(r.name).trim() !== String(name || '').trim()) {
      return json({ ok: false, message: '예약자 이름이 일치해야 취소할 수 있습니다.' });
    }
  }
  await env.DB.prepare('DELETE FROM reservations WHERE id IN (' + ph + ')').bind(...ids).run();
  const f = results[0];
  const body = buildBody(f.machine, f.date, results.map(function (r) { return r.hour; }), f.name, f.dept, f.memo);
  notify(env, ctx, '[진동시험기] 예약 취소 - ' + name, body, f.email);
  return json({ ok: true, message: results.length + '건이 취소되었습니다.' });
}

/* ---------------- 반복 예약 ---------------- */
async function recurring(request, env, ctx) {
  const d = await request.json();
  if (!d.name || !String(d.name).trim()) return json({ ok: false, message: '예약자 이름을 입력해 주세요.' });
  if (!d.dates || d.dates.length === 0) return json({ ok: false, message: '예약할 날짜가 없습니다. 기간/요일을 확인해 주세요.' });
  const err = validateHours(d.hours);
  if (err) return json({ ok: false, message: err });

  // 대상 날짜들의 기존 예약을 한 번에 조회
  const dph = d.dates.map(function () { return '?'; }).join(',');
  const { results: existing } = await env.DB
    .prepare('SELECT date, hour FROM reservations WHERE machine=? AND date IN (' + dph + ')')
    .bind(d.machine, ...d.dates).all();
  const taken = new Set(existing.map(function (r) { return r.date + '|' + r.hour; }));

  const now = new Date().toISOString();
  const email = String(d.email || '').trim();
  const name = String(d.name).trim();
  const dept = String(d.dept || '').trim();
  const memo = String(d.memo || '').trim();

  const booked = [], skipped = [], stmts = [];
  for (const date of d.dates) {
    const conflict = d.hours.some(function (h) { return taken.has(date + '|' + h); });
    if (conflict) { skipped.push(date); continue; }
    for (const h of d.hours) {
      stmts.push(env.DB.prepare(INSERT_SQL).bind(uid(), d.machine, date, h, name, dept, memo, email, now));
      taken.add(date + '|' + h);
    }
    booked.push(date);
  }

  if (stmts.length > 0) {
    try {
      await env.DB.batch(stmts);
    } catch (e) {
      return json({ ok: false, message: '방금 다른 예약과 겹쳤습니다. 새로고침 후 다시 시도해 주세요.' });
    }
  }

  let message;
  if (booked.length === 0) message = '예약 가능한 날짜가 없습니다. (모두 이미 예약됨)';
  else {
    message = booked.length + '일 예약 완료.';
    if (skipped.length > 0) message += '\n이미 예약되어 건너뜀: ' + skipped.join(', ');
  }
  if (booked.length > 0) {
    const s = Math.min.apply(null, d.hours), e = Math.max.apply(null, d.hours) + 1;
    let body = '예약자 : ' + name + (dept ? ' (' + dept + ')' : '') + '\n';
    body += '장비 : ' + d.machine + '\n';
    body += '시간 : 매 예약일 ' + hhmm(s) + ' ~ ' + hhmm(e) + '\n';
    body += '예약일(' + booked.length + '일) : ' + booked.join(', ') + '\n';
    if (skipped.length > 0) body += '건너뜀(이미 예약) : ' + skipped.join(', ') + '\n';
    if (memo) body += '메모 : ' + memo + '\n';
    notify(env, ctx, '[진동시험기] 반복 예약 - ' + name, body, email);
  }
  return json({ ok: true, bookedCount: booked.length, skipped: skipped, message: message });
}

/* ---------------- 통계 ---------------- */
async function handleStats(env, url, kind) {
  // 요약: 총 사용시간 / 예약 인원 / 사용 일수 (연도 또는 월 단위)
  if (kind === 'summary') {
    const month = url.searchParams.get('month');
    const year = url.searchParams.get('year');
    const where = month ? 'substr(date,1,7)=?' : 'substr(date,1,4)=?';
    const val = month || year;
    const row = await env.DB
      .prepare('SELECT COUNT(*) AS hours, COUNT(DISTINCT name) AS people, COUNT(DISTINCT date) AS days FROM reservations WHERE ' + where)
      .bind(val).first();
    return json(row || { hours: 0, people: 0, days: 0 });
  }

  // 데이터에 존재하는 연도 목록(드롭다운용)
  if (kind === 'periods') {
    const { results } = await env.DB
      .prepare("SELECT DISTINCT substr(date,1,4) AS y FROM reservations ORDER BY y DESC").all();
    return json({ years: results.map(function (r) { return r.y; }) });
  }

  // 월별 총 사용시간 (한 해)
  if (kind === 'monthly') {
    const year = url.searchParams.get('year');
    const { results } = await env.DB
      .prepare("SELECT substr(date,1,7) AS month, COUNT(*) AS hours FROM reservations WHERE substr(date,1,4)=? GROUP BY month ORDER BY month")
      .bind(year).all();
    return json(results);
  }

  // 장비별 사용시간 (한 해)
  if (kind === 'machine') {
    const year = url.searchParams.get('year');
    const { results } = await env.DB
      .prepare("SELECT machine, COUNT(*) AS hours FROM reservations WHERE substr(date,1,4)=? GROUP BY machine ORDER BY hours DESC")
      .bind(year).all();
    return json(results);
  }

  // 예약자/부서별 사용시간 (한 달)
  if (kind === 'person') {
    const month = url.searchParams.get('month');
    const { results } = await env.DB
      .prepare("SELECT name, dept, COUNT(*) AS hours FROM reservations WHERE substr(date,1,7)=? GROUP BY name, dept ORDER BY hours DESC")
      .bind(month).all();
    return json(results);
  }

  // 일별 상세 기록 (한 달)
  if (kind === 'daily') {
    const month = url.searchParams.get('month');
    const { results } = await env.DB
      .prepare("SELECT date, machine, name, dept, COUNT(*) AS hours, group_concat(hour) AS hourList FROM reservations WHERE substr(date,1,7)=? GROUP BY date, machine, name, dept ORDER BY date, name")
      .bind(month).all();
    return json(results);
  }

  return json({ ok: false, message: '알 수 없는 통계 항목입니다.' }, 404);
}

/* ---------------- CSV 내보내기 (엑셀) ---------------- */
function csvCell(v) {
  const s = String(v == null ? '' : v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

async function exportCsv(env, url) {
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  let where = '1=1', bind = [], label = 'all';
  if (from && to) { where = 'date>=? AND date<=?'; bind = [from, to]; label = from + '_' + to; }
  else if (from) { where = 'date>=?'; bind = [from]; label = 'from_' + from; }
  else if (to) { where = 'date<=?'; bind = [to]; label = 'to_' + to; }

  const { results } = await env.DB
    .prepare('SELECT date, hour, machine, name, dept, memo, email, created_at FROM reservations WHERE ' + where + ' ORDER BY date, hour')
    .bind(...bind).all();

  const header = ['날짜', '시작시각', '종료시각', '장비', '예약자', '부서/연락처', '메모', '이메일', '신청일시'];
  const lines = [header.map(csvCell).join(',')];
  for (const r of results) {
    lines.push([
      r.date, hhmm(r.hour), hhmm(r.hour + 1), r.machine,
      r.name, r.dept || '', r.memo || '', r.email || '', r.created_at || '',
    ].map(csvCell).join(','));
  }
  // 엑셀에서 한글이 깨지지 않도록 UTF-8 BOM 추가
  const body = '﻿' + lines.join('\r\n');
  return new Response(body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="reservations_' + label + '.csv"',
    },
  });
}
