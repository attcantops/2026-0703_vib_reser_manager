/**
 * 진동시험기 예약 사이트 - 구글 Apps Script 백엔드 (영문 함수명 안전판)
 * ------------------------------------------------------------
 * - 구글 스프레드시트를 데이터베이스로 사용합니다.
 * - 링크(웹앱 URL) 하나로 10층/12층 어디서든 예약할 수 있습니다.
 * - 예약 내역은 연결된 구글시트에서 관리자가 바로 보고 수정할 수 있습니다.
 *
 * ▼ 여기 CONFIG 만 바꾸면 운영 방식을 조정할 수 있습니다.
 */
const CONFIG = {
  machines: ['진동시험기 1호'],   // 장비 여러 대면 ['진동시험기 1호','진동시험기 2호'] 처럼 추가
  startHour: 8,                   // 예약 가능 시작 시각 (0~23)
  endHour: 20,                    // 예약 가능 종료 시각 (1~24). 8~20 이면 08:00~20:00
  maxHours: 8,                    // 한 번에 예약 가능한 최대 시간(연속)
  sheetName: '예약내역',

  // ▼ 메일 알림 설정 ---------------------------------------------
  adminEmail: 'btkang@cantops.biz', // 담당자 메일(여기로 예약 알림이 옴). 비우면 담당자 알림 안 감
  notifyAdmin: true,              // 예약/취소 시 담당자에게 메일
  notifyReserver: true,           // 예약자가 이메일을 입력하면 확인 메일 발송

  reminderMinutes: 30,            // 예약 시작 몇 분 전에 알림 메일을 보낼지
  remindAdmin: false,             // 시작 전 알림을 담당자에게도 보낼지(true면 담당자도 받음)
};

/** 시각(숫자)을 'HH:00' 문자열로. */
function hhmm(h) { return ('0' + h).slice(-2) + ':00'; }

/** 예약 1건을 사람이 읽기 좋은 본문으로. */
function buildBody(machine, date, hours, name, dept, memo) {
  const s = Math.min.apply(null, hours), e = Math.max.apply(null, hours) + 1;
  let body = '예약자 : ' + name + (dept ? ' (' + dept + ')' : '') + '\n';
  body += '장비 : ' + machine + '\n';
  body += '날짜 : ' + date + '\n';
  body += '시간 : ' + hhmm(s) + ' ~ ' + hhmm(e) + '\n';
  if (memo) body += '메모 : ' + memo + '\n';
  return body;
}

/** 메일 발송(실패해도 예약 자체는 유지). */
function sendMail_(to, subject, body) {
  if (!to) return;
  try { MailApp.sendEmail(String(to).trim(), subject, body); } catch (e) { /* 메일 실패 무시 */ }
}

/** 시간 배열이 '연속 + 최대시간 이내'인지 검사합니다. 문제 있으면 메시지를, 없으면 null 반환. */
function validateHours(hours) {
  if (!hours || hours.length === 0) return '시간을 선택해 주세요.';
  if (hours.length > CONFIG.maxHours) return '최대 ' + CONFIG.maxHours + '시간까지 예약할 수 있습니다.';
  const sorted = hours.slice().sort(function (a, b) { return a - b; });
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] !== sorted[i - 1] + 1) return '연속된 시간만 예약할 수 있습니다.';
  }
  return null;
}

/** 웹앱에 접속하면 예약 화면(index.html)을 보여줍니다. */
function doGet() {
  return HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle('진동시험기 예약')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** 화면에서 설정값(기기목록/운영시간)을 읽어갈 때 사용합니다. */
function getConfig() {
  return {
    machines: CONFIG.machines,
    startHour: CONFIG.startHour,
    endHour: CONFIG.endHour,
    maxHours: CONFIG.maxHours,
  };
}

/** 예약 데이터를 저장할 시트를 준비합니다(없으면 자동 생성 + 머리글 작성). */
function ensureSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG.sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.sheetName);
    sheet.appendRow(['ID', '기기', '날짜', '시', '예약자', '부서', '메모', '신청일시', '이메일', '알림']);
    sheet.setFrozenRows(1);
    sheet.getRange('A1:J1').setFontWeight('bold').setBackground('#eef2ff');
  }
  return sheet;
}

/**
 * 특정 기기 + 날짜의 예약 현황을 돌려줍니다.
 * 반환: { '9': {id, name, dept, memo}, '13': {...}, ... }  (시(hour)를 키로 사용)
 */
function getReservations(machine, date) {
  const sheet = ensureSheet();
  const rows = sheet.getDataRange().getValues();
  const result = {};
  for (let i = 1; i < rows.length; i++) {
    const id = rows[i][0];
    const rMachine = rows[i][1];
    const rDate = formatDate(rows[i][2]);
    const rHour = rows[i][3];
    const name = rows[i][4];
    const dept = rows[i][5];
    const memo = rows[i][6];
    if (rMachine === machine && rDate === date) {
      result[String(rHour)] = { id: id, name: name, dept: dept, memo: memo };
    }
  }
  return result;
}

/**
 * 예약을 저장합니다. 여러 시간대를 한 번에 예약할 수 있습니다.
 * data = { machine, date:'2026-07-22', hours:[9,10,11], name, dept, memo }
 * 이미 예약된 시간대가 하나라도 있으면 전체를 취소하고 알려줍니다(중복 방지).
 */
function addReservation(data) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000); // 두 사람이 동시에 예약해도 충돌 안 나게 잠금
  try {
    if (!data.name || !String(data.name).trim()) {
      return { ok: false, message: '예약자 이름을 입력해 주세요.' };
    }
    const hourError = validateHours(data.hours);
    if (hourError) return { ok: false, message: hourError };

    const current = getReservations(data.machine, data.date);
    const dup = data.hours.filter(function (h) { return current[String(h)]; });
    if (dup.length > 0) {
      const list = dup.map(function (h) { return h + '시'; }).join(', ');
      return { ok: false, message: '이미 예약된 시간대가 있습니다: ' + list + '\n새로고침 후 다시 시도해 주세요.' };
    }

    const sheet = ensureSheet();
    const now = new Date();
    const email = String(data.email || '').trim();
    data.hours.forEach(function (h) {
      const id = Utilities.getUuid().slice(0, 8);
      sheet.appendRow([
        id, data.machine, data.date, h,
        String(data.name).trim(),
        String(data.dept || '').trim(),
        String(data.memo || '').trim(),
        now, email,
      ]);
    });

    // 메일 알림
    const body = buildBody(data.machine, data.date, data.hours, data.name, data.dept, data.memo);
    if (CONFIG.notifyAdmin) sendMail_(CONFIG.adminEmail, '[진동시험기] 신규 예약 - ' + data.name, body);
    if (CONFIG.notifyReserver && email) sendMail_(email, '[진동시험기] 예약이 완료되었습니다', body);

    return { ok: true, message: '예약이 완료되었습니다.' };
  } finally {
    lock.releaseLock();
  }
}

/** 예약을 취소(삭제)합니다. 본인 확인은 간단히 이름 일치로 처리합니다. */
function cancelReservation(id, name) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = ensureSheet();
    const rows = sheet.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === id) {
        if (String(rows[i][4]).trim() !== String(name).trim()) {
          return { ok: false, message: '예약자 이름이 일치해야 취소할 수 있습니다.' };
        }
        const rMachine = rows[i][1], rDate = formatDate(rows[i][2]), rHour = rows[i][3];
        const rName = rows[i][4], rDept = rows[i][5], rMemo = rows[i][6], rEmail = rows[i][8];
        sheet.deleteRow(i + 1);

        // 취소 메일 알림
        const body = buildBody(rMachine, rDate, [rHour], rName, rDept, rMemo);
        if (CONFIG.notifyAdmin) sendMail_(CONFIG.adminEmail, '[진동시험기] 예약 취소 - ' + rName, body);
        if (CONFIG.notifyReserver && rEmail) sendMail_(rEmail, '[진동시험기] 예약이 취소되었습니다', body);

        return { ok: true, message: '예약이 취소되었습니다.' };
      }
    }
    return { ok: false, message: '해당 예약을 찾을 수 없습니다.' };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 반복 예약: 여러 날짜에 같은 시간대를 한 번에 예약합니다.
 * data = { machine, dates:['2026-08-04', ...], hours:[14,15], name, dept, memo }
 * 어떤 날짜에 시간이 하나라도 겹치면 그 날짜만 건너뛰고, 나머지는 예약합니다.
 */
function addRecurring(data) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    if (!data.name || !String(data.name).trim()) return { ok: false, message: '예약자 이름을 입력해 주세요.' };
    if (!data.dates || data.dates.length === 0) return { ok: false, message: '예약할 날짜가 없습니다. 월/요일을 확인해 주세요.' };
    const hourError = validateHours(data.hours);
    if (hourError) return { ok: false, message: hourError };

    const sheet = ensureSheet();
    const rows = sheet.getDataRange().getValues();

    // 기존 예약을 (날짜|시) 형태로 한 번에 모읍니다.
    const taken = {};
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][1] === data.machine) {
        taken[formatDate(rows[i][2]) + '|' + rows[i][3]] = true;
      }
    }

    const now = new Date();
    const email = String(data.email || '').trim();
    const bookedDates = [];
    const skipped = [];
    const toAppend = [];

    data.dates.forEach(function (date) {
      const conflict = data.hours.filter(function (h) { return taken[date + '|' + h]; });
      if (conflict.length > 0) {
        skipped.push(date);
      } else {
        data.hours.forEach(function (h) {
          const id = Utilities.getUuid().slice(0, 8);
          toAppend.push([
            id, data.machine, date, h,
            String(data.name).trim(), String(data.dept || '').trim(), String(data.memo || '').trim(), now, email,
          ]);
          taken[date + '|' + h] = true; // 같은 호출 내 중복도 방지
        });
        bookedDates.push(date);
      }
    });

    if (toAppend.length > 0) {
      sheet.getRange(sheet.getLastRow() + 1, 1, toAppend.length, 9).setValues(toAppend);
    }

    let message;
    if (bookedDates.length === 0) {
      message = '예약 가능한 날짜가 없습니다. (모두 이미 예약됨)';
    } else {
      message = bookedDates.length + '일 예약 완료.';
      if (skipped.length > 0) message += '\n이미 예약되어 건너뜀: ' + skipped.join(', ');
    }

    // 메일 알림 (반복 예약 요약)
    if (bookedDates.length > 0) {
      const s = Math.min.apply(null, data.hours), e = Math.max.apply(null, data.hours) + 1;
      let body = '예약자 : ' + data.name + (data.dept ? ' (' + data.dept + ')' : '') + '\n';
      body += '장비 : ' + data.machine + '\n';
      body += '시간 : 매 예약일 ' + hhmm(s) + ' ~ ' + hhmm(e) + '\n';
      body += '예약일(' + bookedDates.length + '일) : ' + bookedDates.join(', ') + '\n';
      if (skipped.length > 0) body += '건너뜀(이미 예약) : ' + skipped.join(', ') + '\n';
      if (data.memo) body += '메모 : ' + data.memo + '\n';
      if (CONFIG.notifyAdmin) sendMail_(CONFIG.adminEmail, '[진동시험기] 반복 예약 - ' + data.name, body);
      if (CONFIG.notifyReserver && email) sendMail_(email, '[진동시험기] 반복 예약이 완료되었습니다', body);
    }

    return { ok: true, bookedCount: bookedDates.length, skipped: skipped, message: message };
  } finally {
    lock.releaseLock();
  }
}

/**
 * (한 번만 실행) 5분마다 도는 알림 트리거를 만듭니다.
 * Apps Script 편집기에서 이 함수를 선택하고 ▶실행 하세요.
 */
function setupReminderTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'reminderCheck') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('reminderCheck').timeBased().everyMinutes(5).create();
}

/**
 * (트리거가 자동 호출) 시작 reminderMinutes 분 전인 예약을 찾아 예약자에게 알림 메일을 보냅니다.
 * 같은 예약(같은 신청일시)은 한 번만 발송하고, '알림' 열에 Y 표시로 중복을 막습니다.
 */
function reminderCheck() {
  const sheet = ensureSheet();
  const rows = sheet.getDataRange().getValues();
  const now = new Date();
  const windowMs = CONFIG.reminderMinutes * 60 * 1000;

  // (기기|날짜|예약자|신청일시) 로 예약 건을 묶습니다.
  const groups = {};
  for (let i = 1; i < rows.length; i++) {
    const machine = rows[i][1];
    const date = formatDate(rows[i][2]);
    const hour = Number(rows[i][3]);
    const name = rows[i][4];
    const dept = rows[i][5];
    const memo = rows[i][6];
    const ts = rows[i][7] instanceof Date ? rows[i][7].getTime() : String(rows[i][7]);
    const email = rows[i][8];
    const flag = rows[i][9];
    const key = machine + '|' + date + '|' + name + '|' + ts;
    if (!groups[key]) {
      groups[key] = { rows: [], hours: [], machine: machine, date: date, name: name, dept: dept, memo: memo, email: email, reminded: false };
    }
    const gp = groups[key];
    gp.rows.push(i + 1);      // 실제 시트 행 번호
    gp.hours.push(hour);
    if (email) gp.email = email;
    if (String(flag) === 'Y') gp.reminded = true;
  }

  Object.keys(groups).forEach(function (key) {
    const gp = groups[key];
    if (gp.reminded || !gp.email) return;
    const startHour = Math.min.apply(null, gp.hours);
    const p = gp.date.split('-');
    const start = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), startHour, 0, 0);
    const diff = start.getTime() - now.getTime();
    if (diff > 0 && diff <= windowMs) {
      let body = buildBody(gp.machine, gp.date, gp.hours, gp.name, gp.dept, gp.memo);
      body += '\n※ 약 ' + CONFIG.reminderMinutes + '분 후 예약이 시작됩니다.';
      sendMail_(gp.email, '[진동시험기] 예약 시작 ' + CONFIG.reminderMinutes + '분 전 알림', body);
      if (CONFIG.remindAdmin) sendMail_(CONFIG.adminEmail, '[진동시험기] 곧 시작 - ' + gp.name, body);
      gp.rows.forEach(function (r) { sheet.getRange(r, 10).setValue('Y'); });
    }
  });
}

/** 날짜 값을 'YYYY-MM-DD' 문자열로 통일합니다. */
function formatDate(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(value);
}

/** (테스트용) 편집기에서 직접 실행해 메일 발송/권한을 확인합니다. */
function testMail() {
  Logger.log('남은 메일 발송 가능 수: ' + MailApp.getRemainingDailyQuota());
  MailApp.sendEmail(CONFIG.adminEmail, '[테스트] 진동시험기 메일', '메일 발송 테스트입니다. 이 메일이 오면 정상입니다.');
  Logger.log('발송 시도 완료');
}
