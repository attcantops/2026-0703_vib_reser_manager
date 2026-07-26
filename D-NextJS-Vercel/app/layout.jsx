// app/layout.jsx
// App Router 의 최상위 레이아웃. 모든 페이지를 감싼다.
// 한국어(lang="ko") 설정 + 최소 전역 스타일.

export const metadata = {
  title: '진동시험기 예약',
  description: '사내 진동시험기 예약 관리 웹앱',
};

export default function RootLayout({ children }) {
  return (
    <html lang="ko">
      <body>
        {/* 최소 전역 스타일 — 초심자용으로 별도 CSS 파일 없이 인라인 처리 */}
        <style>{`
          * { box-sizing: border-box; }
          html, body {
            margin: 0;
            padding: 0;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI',
              'Malgun Gothic', '맑은 고딕', sans-serif;
            background: #f5f6f8;
            color: #222;
          }
          button { font-family: inherit; cursor: pointer; }
          input, textarea, select { font-family: inherit; }
        `}</style>
        {children}
      </body>
    </html>
  );
}
