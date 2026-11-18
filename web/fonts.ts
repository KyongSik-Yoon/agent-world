// 화면 글꼴(IBM Plex Sans KR·JetBrains Mono)의 @font-face 를 붙인다. 글꼴 파일은 서버가 npm 패키지에서 내준다(server/fonts.ts).
// 문서에 <link> 로 적지 않는 것은 화면을 묶을 때(Bun.build) 그 주소를 파일로 찾으려 들다 실패하기 때문이다.
// main.ts 가 맨 먼저 불러, 다른 화면 코드가 돌기 전에 붙는다.
if (typeof document !== "undefined") {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "font/ui.css";
  document.head.append(link);
}
