/* 진동시험기 예약 — 공용 설정
 *
 * 예약 화면(index.html)과 통계 화면(stat.html)이 함께 쓴다.
 * 자원 목록이나 운영시간이 두 파일에 따로 있으면 반드시 어긋난다. 한쪽에서 자원을
 * 추가했는데 다른 쪽 통계에는 안 잡히는 식이다. 그래서 이 파일 하나만 고치면 되게 둔다.
 *
 * 이 파일은 같은 서버에서 서빙한다. 인터넷이 막힌 사내망에서도 동작해야 하므로
 * 외부 CDN 을 쓰지 않는다.
 */
const CONFIG = {
  // 자원 목록. 이 배열 하나가 사이드바·일간 화면의 열·예약창의 자원 선택·목록의
  // 분류 칸·통계의 집계 대상을 모두 결정한다. 자원을 늘리려면 여기에 한 줄 추가한다.
  //
  // group 은 화면을 나누는 단위다. 일간 화면과 통계는 "한 분류의 자원들"을 함께 놓는다.
  // 분류를 섞어 늘어놓으면 열이 계속 늘어나 비교가 안 되기 때문이다.
  //
  // ※ name 은 예약 기록에 그대로 저장된다. 이미 예약이 있는 자원의 이름을 바꾸면
  //   기존 예약이 어느 열에도 안 잡혀 사라진 것처럼 보인다. 바꿀 때는 기록도 함께 옮겨야 한다.
  resources: [
    { group: '시험기',  name: '진동시험기 1호' },
    { group: '시험기',  name: '진동시험기 2호' },
    { group: 'TestBed', name: 'TestBed 1호' },
    { group: 'TestBed', name: 'TestBed 2호' },
  ],
  startHour: 8,     // 예약 가능 시작
  endHour: 20,      // 예약 가능 시각은 8..19 (endHour 미만)
  maxHours: 8,      // 연속 최대
  collection: 'reservations',
};

/* 자원 목록 조회 helper — CONFIG.resources 를 여기저기서 직접 훑지 않도록 모아둔다 */
function groupNames() {
  const seen = [];
  for (const r of CONFIG.resources) if (!seen.includes(r.group)) seen.push(r.group);
  return seen;
}
function machinesOf(group) {
  return CONFIG.resources.filter(r => r.group === group).map(r => r.name);
}
function groupOf(machine) {
  const r = CONFIG.resources.find(x => x.name === machine);
  return r ? r.group : CONFIG.resources[0].group;
}
function allMachines() { return CONFIG.resources.map(r => r.name); }
