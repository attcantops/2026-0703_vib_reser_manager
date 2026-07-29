// 진동시험기 예약 — 메일 알림 공용 함수
//
// ※ 왜 별도 모듈인가
//   PocketBase 의 훅 핸들러는 요청마다 격리된 VM 에서 실행된다. 훅 파일 상단에
//   함수를 정의해도 핸들러 안에서는 보이지 않는다(ReferenceError 로 400 이 난다).
//   그래서 공용 함수는 이 모듈에 두고, 핸들러 안에서 require 로 불러온다.
//
//   const lib = require(`${__hooks}/vibres_mail_lib.js`)

const CONF = {
  // 예약·취소 알림을 받을 담당자. 여러 명이면 쉼표로 나눈다.
  admin: 'btkang@cantops.biz',
  notifyAdminOnReserve: true,   // 예약 생기면 담당자에게
  notifyAdminOnCancel: true,    // 취소되면 담당자에게
  notifyOwnerOnCancel: true,    // 취소되면 예약자 본인에게 (값어치 가장 큼)
};

function log(msg) {
  console.log('[vibres-mail] ' + msg);
}

/** 시:00 을 오전/오후 표기로. 화면과 같은 방식이라야 헷갈리지 않는다. */
function ampm(h) {
  h = Number(h);
  if (h === 0) return '오전 12:00';
  if (h < 12) return '오전 ' + h + ':00';
  if (h === 12) return '오후 12:00';
  return '오후 ' + (h - 12) + ':00';
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 느슨한 형식 검사. 오타를 잡으려는 게 아니라 헤더 주입을 막으려는 것이다. */
function validEmail(s) {
  s = String(s || '').trim();
  if (!s || s.length > 254) return false;
  if (/[\r\n,;<>]/.test(s)) return false;
  return /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(s);
}

function recipients(list) {
  const out = [];
  const parts = String(list || '').split(',');
  for (let i = 0; i < parts.length; i++) {
    const a = parts[i].trim();
    if (validEmail(a)) out.push({ address: a });
  }
  return out;
}

/**
 * 메일 발송. 어떤 이유로든 예외를 밖으로 내보내지 않는다.
 * 메일이 안 갔다고 예약이 실패하면 안 된다 — 예약이 본체고 메일은 얹은 기능이다.
 */
function send(to, subject, html) {
  try {
    if (!to || !to.length) return false;

    // SMTP 미설정이면 조용히 건너뛴다. PocketBase 는 이 경우 sendmail 을 찾다가
    // 실패하는데, 사내 서버엔 sendmail 이 없어 오류만 쌓인다.
    const st = $app.settings();
    if (!st.smtp || !st.smtp.enabled) {
      log('SMTP 미설정 — 발송 건너뜀: ' + subject);
      return false;
    }

    const from = {
      address: st.meta.senderAddress,
      name: st.meta.senderName || '진동시험기 예약',
    };
    $app.newMailClient().send(new MailerMessage({
      from: from, to: to, subject: subject, html: html,
    }));
    log('발송: ' + subject);
    return true;
  } catch (err) {
    log('[오류] 발송 실패: ' + err);
    return false;
  }
}

/** 본문 공통 틀 */
function body(title, rows, note) {
  let h = '<div style="font-family:-apple-system,Segoe UI,Malgun Gothic,sans-serif;font-size:14px;color:#24292f;line-height:1.6">';
  h += '<h2 style="font-size:16px;margin:0 0 16px">' + esc(title) + '</h2>';
  h += '<table cellpadding="0" cellspacing="0" style="border-collapse:collapse">';
  for (let i = 0; i < rows.length; i++) {
    h += '<tr>'
      + '<td style="padding:5px 16px 5px 0;color:#57606a;white-space:nowrap;vertical-align:top">' + esc(rows[i][0]) + '</td>'
      + '<td style="padding:5px 0">' + esc(rows[i][1]) + '</td>'
      + '</tr>';
  }
  h += '</table>';
  if (note) h += '<p style="margin:18px 0 0;color:#6b7280;font-size:13px">' + esc(note) + '</p>';
  h += '</div>';
  return h;
}

/** 요청 본문에서 예약 정보를 꺼내고 형식을 검사한다 */
function parse(e) {
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

function range(d) {
  return d.date + ' ' + ampm(d.startHour) + ' ~ ' + ampm(d.endHour)
    + ' (' + (d.endHour - d.startHour) + '시간)';
}

/** 그 시각에 예약 레코드가 남아 있는지 */
function exists(d) {
  const found = $app.findRecordsByFilter(
    'reservations',
    'machine = {:m} && date = {:d} && hour = {:h}',
    '', 1, 0,
    { m: d.machine, d: d.date, h: d.startHour },
  );
  return found.length > 0;
}

module.exports = {
  CONF: CONF,
  log: log, ampm: ampm, esc: esc, validEmail: validEmail, recipients: recipients,
  send: send, body: body, parse: parse, range: range, exists: exists,
};
