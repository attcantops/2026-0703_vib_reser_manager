/// <reference path="../pb_data/types.d.ts" />

// 진동시험기 예약 — reservations 컬렉션 자동 생성 마이그레이션
//
// PocketBase는 실행 시 pb_migrations/ 안의 파일을 순서대로 1회씩 적용한다.
// 따라서 이 파일이 있으면 관리자 화면에서 컬렉션을 손으로 만들 필요가 없다.
// (적용 이력은 pb_data/ 안에 남으므로 재실행해도 중복 생성되지 않는다)
//
// 대상 버전: PocketBase v0.23 이상 (fields / app.save API)

migrate((app) => {
  const collection = new Collection({
    type: "base",
    name: "reservations",

    // 로그인 없이 쓰는 사내 공용앱이므로 조회/생성/삭제를 공개한다.
    // updateRule 만 null(관리자 전용) — 이 앱은 수정 기능을 쓰지 않는다.
    listRule: "",
    viewRule: "",
    createRule: "",
    updateRule: null,
    deleteRule: "",

    fields: [
      {
        name: "machine",
        type: "text",
        required: true,
        max: 100,
      },
      {
        name: "date",
        type: "text",
        required: true,
        min: 10,
        max: 10,
        pattern: "^\\d{4}-\\d{2}-\\d{2}$",
      },
      {
        // 예약 시작 시각(정시). 앱은 8~19시만 쓰지만 여유를 둔다.
        // required 를 켜면 PocketBase가 0을 빈 값으로 보아 0시 예약이 막히므로 끈다.
        name: "hour",
        type: "number",
        required: false,
        min: 0,
        max: 23,
        onlyInt: true,
      },
      {
        name: "name",
        type: "text",
        required: true,
        max: 50,
      },
      {
        name: "dept",
        type: "text",
        required: false,
        max: 50,
      },
      {
        name: "memo",
        type: "text",
        required: false,
        max: 500,
      },
      {
        name: "email",
        type: "email",
        required: false,
      },
      {
        name: "created",
        type: "autodate",
        onCreate: true,
        onUpdate: false,
      },
      {
        name: "updated",
        type: "autodate",
        onCreate: true,
        onUpdate: true,
      },
    ],

    // 같은 장비·같은 날짜·같은 시각의 중복 예약을 DB 레벨에서 원천 차단한다.
    // (두 사람이 동시에 같은 칸을 눌러도 한 명만 성공)
    indexes: [
      "CREATE UNIQUE INDEX `idx_unique_machine_date_hour` ON `reservations` (`machine`, `date`, `hour`)",
    ],
  });

  app.save(collection);
}, (app) => {
  // 롤백: 컬렉션 삭제
  const collection = app.findCollectionByNameOrId("reservations");
  app.delete(collection);
});
