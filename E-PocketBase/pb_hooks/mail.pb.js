/// <reference path="../pb_data/types.d.ts" />
//
// 진동시험기 예약 — 메일 알림
//
// 보내는 것은 두 가지뿐이다.
//   1) 관리자 알림   예약이 생기면 담당자가 즉시 안다
//   2) 취소 통보     남이 내 예약을 지웠을 때 당사자가 알 방법이 이것뿐이다
//
// 예약자 본인에게 보내는 "예약 확인" 메일은 넣지 않았다. 방금 자기가 한 예약이고
// 화면에 그대로 보인다. 받는 사람에겐 광고나 다름없다.
//
// ── 왜 훅(record hook)이 아니라 별도 경로인가 ────────────────────────────
// 예약 1건은 1시간 = 1레코드다. 9~12시 예약은 레코드 3개가 연달아 만들어진다.
// 레코드 생성 훅에 메일을 걸면 한 번 예약에 메일이 3통 간다. 게다가 첫 번째
// 레코드가 만들어지는 시점에는 아직 뒤의 두 개가 없어서 "9시~10시"라고 잘못
// 적히게 된다.
// 그래서 화면이 예약·취소를 다 끝낸 뒤 이 경로를 한 번 부르게 했다. 메일 한 통에
// 정확한 시간 범위가 담긴다.
//
// ── 한계 (알고 쓰는 것) ──────────────────────────────────────────────────
// 화면을 거치지 않고 API 를 직접 호출해 예약·삭제하면 메일이 안 간다. 지금
// 컬렉션 규칙이 이미 공개라 API 직접 호출 자체를 막지 못하므로, 메일만 따로
// 완벽하게 만들 방법이 없다. 사내 사용 기준으로는 화면이 유일한 경로다.
//
// ── SMTP 설정 ────────────────────────────────────────────────────────────
// 관리자 화면 http://<주소>/_/  → Settings → Mail settings 에서 넣는다.
// 설정 전에는 이 파일이 아무 일도 하지 않고 조용히 넘어간다. 예약 기능에는
// 영향이 없다. 그래서 SMTP 를 나중에 켜도 코드는 손댈 필요가 없다.

const VIBRES_MAIL = {
  // 예약·취소 알림을 받을 담당자. 여러 명이면 쉼표로 나눈다.
  admin: 'btkang@cantops.biz',
  notifyAdminOnReserve: true,   // 예약 생기면 담당자에게
  notifyAdminOnCancel: true,    // 취소되면 담당자에게
  notifyOwnerOnCancel: true,    // 취소되면 예약자 본인에게 (값어치 가장 큼)
};

// ─────────────────────────────────────────────────────────────────────────

function vibresLog(msg) {
  console.log('[vibres-mail] ' + msg);
}

/** 시:00 을 오전/오후 표기로. 화면과 같은 방식으로 적어야 헷갈리지 않는다. */
function vibresAmPm(h) {
  h = Number(h);
  if (h === 0) return '오전 12:00';
  if (h < 12) return '오전 ' + h + ':00';
  if (h === 12) return '오후 12:00';
  return '오후 ' + (h - 12) + ':00';
}

function vibresEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 아주 느슨한 형식 검사. 오타를 잡으려는 게 아니라 헤더 주입을 막으려는 것이다. */
function vibresValidEmail(s) {
  s = String(s || '').trim();
  if (!s || s.length > 254) return false;
  if (/[\r\n,;<>]/.test(s)) return false;
  return /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(s);
}

function vibresRecipients(list) {
  const out = [];
  for (const raw of String(list || '').split(',')) {
    const a = raw.trim();
    if (vibresValidEmail(a)) out.push({ address: a });
  }
  return out;
}

/**
 * 메일 발송. 어떤 이유로든 예외를 밖으로 내보내지 않는다.
 * 메일이 안 갔다고 예약이 실패하면 안 된다 — 예약이 본체고 메일은 얹은 기능이다.
 */
function vibresSend(to, subject, html) {
  try {
    if (!to.length) return false;

    // SMTP 미설정이면 조용히 건너뛴다. PocketBase 는 이 경우 sendmail 을 쓰려다
    // 실패하는데, 사내 서버엔 sendmail 이 없어 매번 오류만 쌓인다.
    const st = $app.settings();
    if (!st.smtp || !st.smtp.enabled) {
      vibresLog('SMTP 미설정 — 발송 건너뜀: ' + subject);
      return false;
    }

    const from = {
      address: st.meta.senderAddress,
      name: st.meta.senderName || '진동시험기 예약',
    };
    $app.newMailClient().send(new MailerMessage({ from: from, to: to, subject: subject, html: html }));
    vibresLog('발송: ' + subject + ' -> ' + to.map(function (t) { return t.address; }).join(', '));
    return true;
  } catch (err) {
    vibresLog('[오류] 발송 실패: ' + err);
    return false;
  }
}

/** 본문 공통 틀 */
function vibresBody(title, rows, note) {
  let h = '<div style="font-family:-apple-system,Segoe UI,Malgun Gothic,sans-serif;font-size:14px;color:#24292f;line-height:1.6">';
  h += '<h2 style="font-size:16px;margin:0 0 16px">' + vibresEsc(title) + '</h2>';
  h += '<table cellpadding="0" cellspacing="0" style="border-collapse:collapse">';
  for (const r of rows) {
    h += '<tr>'
      + '<td style="padding:5px 16px 5px 0;color:#57606a;white-space:nowrap;vertical-align:top">' + vibresEsc(r[0]) + '</td>'
      + '<td style="padding:5px 0">' + vibresEsc(r[1]) + '</td>'
      + '</tr>';
  }
  h += '</table>';
  if (note) h += '<p style="margin:18px 0 0;color:#6b7280;font-size:13px">' + vibresEsc(note) + '</p>';
  h += '</div>';
  return h;
}

/** 요청 본문에서 예약 정보를 꺼내고 형식을 검사한다 */
function vibresParse(e) {
  const b = e.requestInfo().body || {};
  const machine = String(b.machine || '').trim();
  const date = String(b.date || '').trim();
  const start = Number(b.startHour);
  const end = Number(b.endHour);
  const name = String(b.name || '').trim();

  if (!machine || !name) throw new Error('자원과 예약자는 필수입니다');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('날짜 형식이 올바르지 않습니다');
  if (!isFinite(start) || !isFinite(end) || end <= start) throw new Error('시간 범위가 올바르지 않습니다');
  if (machine.length > 100 || name.length > 100) throw new Error('값이 너무 깁니다');

  return {
    machine: machine, date: date, startHour: start, endHour: end, name: name,
    dept: String(b.dept || '').trim().slice(0, 100),
    memo: String(b.memo || '').trim().slice(0, 500),
    email: String(b.email || '').trim(),
    actor: String(b.actor || '').trim().slice(0, 100),
  };
}

function vibresRange(d) {
  return d.date + ' ' + vibresAmPm(d.startHour) + ' ~ ' + vibresAmPm(d.endHour)
    + ' (' + (d.endHour - d.startHour) + '시간)';
}

// ── 예약 생성 알림 ───────────────────────────────────────────────────────
routerAdd('POST', '/api/vibres/notify-reserve', (e) => {
  try {
    const d = vibresParse(e);

    // 실제로 있는 예약인지 확인한다. 확인 없이 보내면 이 주소가 그대로
    // 아무 내용이나 보내는 메일 발송기가 된다.
    const found = $app.findRecordsByFilter(
      'reservations',
      'machine = {:m} && date = {:d} && hour = {:h}',
      '', 1, 0,
      { m: d.machine, d: d.date, h: d.startHour },
    );
    if (!found.length) throw new Error('해당 예약을 찾을 수 없습니다');

    if (VIBRES_MAIL.notifyAdminOnReserve) {
      vibresSend(
        vibresRecipients(VIBRES_MAIL.admin),
        '[예약] ' + d.machine + ' ' + d.date,
        vibresBody('진동시험기 예약이 등록되었습니다', [
          ['자원', d.machine],
          ['예약 시간', vibresRange(d)],
          ['예약자', d.name + (d.dept ? ' (' + d.dept + ')' : '')],
          ['사용 용도', d.memo || '-'],
        ]),
      );
    }
    return e.json(200, { ok: true });
  } catch (err) {
    // 화면은 이 응답을 보지 않는다. 메일이 실패해도 예약은 이미 끝나 있다.
    vibresLog('[오류] notify-reserve: ' + err);
    return e.json(200, { ok: false });
  }
});

// ── 취소 통보 ────────────────────────────────────────────────────────────
// 지금 구조에서는 이름·부서만 맞으면 남의 예약도 지울 수 있다. 지워진 사실을
// 당사자가 알 방법이 이 메일뿐이라, 세 가지 중 값어치가 가장 크다.
routerAdd('POST', '/api/vibres/notify-cancel', (e) => {
  try {
    const d = vibresParse(e);

    // 정말 지워졌는지 확인한다. 남아 있는데 취소 메일을 보내면 안 된다.
    const still = $app.findRecordsByFilter(
      'reservations',
      'machine = {:m} && date = {:d} && hour = {:h}',
      '', 1, 0,
      { m: d.machine, d: d.date, h: d.startHour },
    );
    if (still.length) throw new Error('아직 남아 있는 예약입니다');

    const byOther = d.actor && d.actor !== d.name;
    const note = byOther
      ? '이 예약은 ' + d.actor + ' 님이 삭제했습니다. 착오라면 다시 예약해 주세요.'
      : '';

    if (VIBRES_MAIL.notifyOwnerOnCancel && vibresValidEmail(d.email)) {
      vibresSend(
        [{ address: d.email }],
        '[예약 취소] ' + d.machine + ' ' + d.date,
        vibresBody('예약이 취소되었습니다', [
          ['자원', d.machine],
          ['예약 시간', vibresRange(d)],
          ['예약자', d.name + (d.dept ? ' (' + d.dept + ')' : '')],
          ['삭제한 사람', d.actor || '-'],
        ], note),
      );
    }

    if (VIBRES_MAIL.notifyAdminOnCancel) {
      vibresSend(
        vibresRecipients(VIBRES_MAIL.admin),
        '[예약 취소] ' + d.machine + ' ' + d.date,
        vibresBody('진동시험기 예약이 취소되었습니다', [
          ['자원', d.machine],
          ['예약 시간', vibresRange(d)],
          ['예약자', d.name + (d.dept ? ' (' + d.dept + ')' : '')],
          ['삭제한 사람', d.actor || '-'],
        ]),
      );
    }
    return e.json(200, { ok: true });
  } catch (err) {
    vibresLog('[오류] notify-cancel: ' + err);
    return e.json(200, { ok: false });
  }
});

vibresLog('메일 훅 등록됨 (SMTP 미설정이면 발송은 건너뜁니다)');
