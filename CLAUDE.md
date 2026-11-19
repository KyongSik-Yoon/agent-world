# Agent World

## 홈페이지

- 주소: https://agent-world.ksyoon.com/ (GitHub Pages, `main` 의 `docs/`)
- `docs/index.html` 한 파일이다. 빌드 없음, 외부 자원은 Google Fonts 뿐. 컨셉은 "떠 있는 섬": 앱의 낮/밤 하늘 위에
  작은 섬을 그리고, 캐릭터가 상태(작업 중·확인 필요·완료·대기)마다 정해진 자리로 걸어가는 것을 첫 화면에서 보여 준다.
- 문구와 숫자는 README(한국어·영어)와 `herdr-plugin.toml` 에 맞춘다. 기능이나 숫자가 바뀌면 README 와 함께 고친다.
- 화면 그림(`docs/img/`)은 실제 세션이 아니라 `dev/mock-herdr.ts` 에 가상의 프로젝트 시나리오를 물려 찍는다.
  로그 폴더(`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `AGY_HOME`)와 `XDG_STATE_HOME` 도 임시 폴더로 돌려, 실제 작업 내용과 사용량이 그림에 들어가지 않게 한다.
  위 막대의 사용량에 가상 값을 넣으려면 `AGENT_WORLD_CLAUDE_LIMITS`·`AGENT_WORLD_AGY_PAYLOAD` 와 가상 로그의 `rate_limits` 를 쓴다(README 의 개발).
