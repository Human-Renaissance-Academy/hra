/** 외부 자산과 데이터 연결이 없는 파서 시험 전용 루트입니다. */
export default function Layout({ children }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
