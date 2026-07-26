# 진동시험기 예약 앱 — 플랫폼별 버전 모음

같은 "진동시험기 예약" 앱을 **여러 플랫폼**으로 만들어, 각 플랫폼의 방식(세계관)을 비교 체험하기 위한 모음입니다.
기능·데이터 모델은 전부 동일하고(장비1대·08~20시·연속 최대8h·이름으로 예약/취소·중복예약 원천차단), **만드는 방식만** 다릅니다.

## 폴더 지도

| 폴더 | 플랫폼 | 결(카테고리) | 상태 |
|---|---|---|---|
| `A-구글시트버전/` | 구글시트 + Apps Script | 노코드/시트 | ✅ 완성·실사용 |
| `01.클라우드(외부) 호스팅/` | Cloudflare Workers + D1 | 엣지 서버리스 | ✅ 완성·**라이브 배포** |
| `C-Supabase/` | Supabase (PostgreSQL) | 올인원 백엔드(BaaS) | 📦 코드 준비(감 익히기용) |
| `D-NextJS-Vercel/` | Next.js + Vercel | 모던 풀스택 프레임워크 | 📦 코드 준비(감 익히기용) |
| `E-PocketBase/` | PocketBase | 단일 실행파일 백엔드 | 📦 코드 준비(감 익히기용) |
| `F-Deno-Deploy/` | Deno Deploy + KV | 엣지 서버리스(Deno) | 📦 코드 준비(감 익히기용) |

> `B-클라우드(외부) 호스팅 CloudFlare/` 폴더는 실제 코드가 아니라 QR·인쇄 안내문·바로가기 모음입니다. Cloudflare 실제 코드는 `01.클라우드(외부) 호스팅/` 에 있습니다.

## 각 플랫폼 한 줄 요약

- **Supabase** — 진짜 관계형 DB(PostgreSQL) + 로그인 + 자동 REST API를 클릭 몇 번으로. 정적 index.html이 DB에 바로 붙는다. "백엔드를 안 짜도 백엔드가 있는" 느낌.
- **Next.js + Vercel** — React 프론트와 API가 한 프로젝트. `git push`면 자동 배포. 요즘 웹개발 주류 스택. (이 버전 DB는 감 익히기용 인메모리 → 운영은 Postgres 교체)
- **PocketBase** — 실행파일 하나가 DB+API+**관리자 화면**+로그인 전부. 예약을 엑셀처럼 직접 편집하는 관리자 페이지가 공짜.
- **Deno Deploy** — Cloudflare의 사촌. TypeScript 네이티브, DB는 내장 Deno KV. 엣지에서 도는 방식은 같지만 Deno 생태계.

## 가입/실행 필요 여부 (감만 익힐 땐 안 해도 됨)

| 플랫폼 | 계정 가입 | 로컬 미리보기 |
|---|---|---|
| Supabase | 필요(무료, GitHub/이메일) | index.html 키 채우면 브라우저로 바로 |
| Next.js + Vercel | 배포 시 Vercel(무료, GitHub) | `npm install` → `npm run dev` |
| PocketBase | 앱 자체는 불필요(실행파일)·공개배포 시 호스팅 계정 | 실행파일 다운로드 후 `pocketbase serve` |
| Deno Deploy | 배포 시 필요(무료, GitHub) | Deno 설치 후 `deno task dev` |

각 폴더의 **`설치방법.md`** 에 그 플랫폼의 세계관·가입·실행·배포 절차가 상세히 있습니다.

## 팁
- 여러 플랫폼을 실제로 올려볼 거면 **GitHub 계정 하나**(att.cantops@gmail.com)만 만들어두면 Supabase·Vercel·Deno·Railway 다 "GitHub로 로그인"으로 공용.
- 실사용은 이미 **Cloudflare 라이브 버전**(https://vibration-reservation.attcantops.workers.dev)으로 충분합니다. C~F는 학습·비교용.
