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
// ── 왜 레코드 훅이 아니라 별도 경로인가 ──────────────────────────────────
// 예약 1건은 1시간 = 1레코드다. 9~12시 예약은 레코드 3개가 연달아 만들어진다.
// 레코드 생성 훅에 메일을 걸면 한 번 예약에 메일이 3통 간다. 게다가 첫 레코드가
// 만들어지는 시점에는 뒤의 둘이 아직 없어서 "9시~10시"라고 잘못 적히게 된다.
// 그래서 화면이 예약·취소를 다 끝낸 뒤 이 경로를 한 번 부른다. 메일 한 통에
// 정확한 시간 범위가 담긴다.
//
// ── 공용 함수를 require 로 가져오는 이유 ─────────────────────────────────
// 훅 핸들러는 요청마다 격리된 VM 에서 돈다. 이 파일 상단에 함수를 정의해도
// 핸들러 안에서는 보이지 않고 ReferenceError 가 난다(응답은 400). 그래서
// 공용 함수는 vibres_mail_lib.js 에 두고 핸들러 안에서 불러온다.
//
// ── 한계 (알고 쓰는 것) ──────────────────────────────────────────────────
// 화면을 거치지 않고 API 를 직접 호출해 예약·삭제하면 메일이 안 간다. 컬렉션
// 규칙이 이미 공개라 API 직접 호출 자체를 막지 못하므로 메일만 완벽하게 만들
// 방법이 없다. 사내 사용 기준으로는 화면이 유일한 경로다.
//
// ── SMTP 설정 ────────────────────────────────────────────────────────────
// 관리자 화면 http://<주소>/_/ → Settings → Mail settings 에서 넣는다.
// 설정 전에는 아무 일도 하지 않고 조용히 넘어간다. 예약 기능에는 영향이 없다.
// 그래서 SMTP 를 나중에 켜도 코드는 손댈 필요가 없다.

// ── 예약 생성 알림 ───────────────────────────────────────────────────────
routerAdd('POST', '/api/vibres/notify-reserve', (e) => {
  const lib = require(`${__hooks}/vibres_mail_lib.js`);
  try {
    const d = lib.parse(e);

    // 실제로 있는 예약인지 확인한다. 확인 없이 보내면 이 주소가 그대로
    // 아무 내용이나 보내는 메일 발송기가 된다.
    if (!lib.exists(d)) throw new Error('해당 예약을 찾을 수 없습니다');

    if (lib.CONF.notifyAdminOnReserve) {
      lib.send(
        lib.recipients(lib.CONF.admin),
        '[예약] ' + d.machine + ' ' + d.date,
        lib.body('진동시험기 예약이 등록되었습니다', [
          ['자원', d.machine],
          ['예약 시간', lib.range(d)],
          ['예약자', d.name + (d.dept ? ' (' + d.dept + ')' : '')],
          ['사용 용도', d.memo || '-'],
        ]),
      );
    }
    return e.json(200, { ok: true });
  } catch (err) {
    // 화면은 이 응답을 보지 않는다. 메일이 실패해도 예약은 이미 끝나 있다.
    lib.log('[오류] notify-reserve: ' + err);
    return e.json(200, { ok: false });
  }
});

// ── 취소 통보 ────────────────────────────────────────────────────────────
// 지금 구조에서는 이름·부서만 맞으면 남의 예약도 지울 수 있다. 지워진 사실을
// 당사자가 알 방법이 이 메일뿐이라, 세 가지 중 값어치가 가장 크다.
routerAdd('POST', '/api/vibres/notify-cancel', (e) => {
  const lib = require(`${__hooks}/vibres_mail_lib.js`);
  try {
    const d = lib.parse(e);

    // 정말 지워졌는지 확인한다. 남아 있는데 취소 메일을 보내면 안 된다.
    if (lib.exists(d)) throw new Error('아직 남아 있는 예약입니다');

    const byOther = d.actor && d.actor !== d.name;
    const note = byOther
      ? '이 예약은 ' + d.actor + ' 님이 삭제했습니다. 착오라면 다시 예약해 주세요.'
      : '';
    const rows = [
      ['자원', d.machine],
      ['예약 시간', lib.range(d)],
      ['예약자', d.name + (d.dept ? ' (' + d.dept + ')' : '')],
      ['삭제한 사람', d.actor || '-'],
    ];

    if (lib.CONF.notifyOwnerOnCancel && lib.validEmail(d.email)) {
      lib.send([{ address: d.email }],
        '[예약 취소] ' + d.machine + ' ' + d.date,
        lib.body('예약이 취소되었습니다', rows, note));
    }
    if (lib.CONF.notifyAdminOnCancel) {
      lib.send(lib.recipients(lib.CONF.admin),
        '[예약 취소] ' + d.machine + ' ' + d.date,
        lib.body('진동시험기 예약이 취소되었습니다', rows));
    }
    return e.json(200, { ok: true });
  } catch (err) {
    lib.log('[오류] notify-cancel: ' + err);
    return e.json(200, { ok: false });
  }
});

console.log('[vibres-mail] 메일 훅 등록됨 (SMTP 미설정이면 발송은 건너뜁니다)');
