# Agent World

## 홈페이지

- 주소: https://agent-world.ksyoon.com/ (GitHub Pages, `main` 의 `docs/`)
- `docs/index.html` 한 파일이다. 빌드 없음, 외부 자원은 Google Fonts 뿐. 컨셉은 "떠 있는 섬": 앱의 낮/밤 하늘 위에
  작은 섬을 그리고, 캐릭터가 상태(작업 중·확인 필요·완료·대기)마다 정해진 자리로 걸어가는 것을 첫 화면에서 보여 준다.
- 문구와 숫자는 README(한국어·영어)와 `herdr-plugin.toml` 에 맞춘다. 기능이나 숫자가 바뀌면 README 와 함께 고친다.
- 화면 그림(`docs/img/`)은 실제 세션이 아니라 `dev/mock-herdr.ts` 에 가상의 프로젝트 시나리오를 물려 찍는다.
  로그 폴더(`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `AGY_HOME`)와 `XDG_STATE_HOME` 도 임시 폴더로 돌려, 실제 작업 내용과 사용량이 그림에 들어가지 않게 한다.
  위 막대의 사용량에 가상 값을 넣으려면 `AGENT_WORLD_CLAUDE_LIMITS`·`AGENT_WORLD_CLAUDE_USAGE`·`AGENT_WORLD_AGY_PAYLOAD` 와 가상 로그의 `rate_limits` 를 쓴다(README 의 개발).

## 화면 성능

- web/ 을 바꾸면 커밋한 뒤 `bun run perf` 를 돌리고 결과 표를 보고에 붙인다. main 으로 가는 push 는 그 web/ 트리의 통과 기록과
  `bun run perf:lint` 를 `.githooks/pre-push` 가 확인한다. 장면·이름표·CSS 처럼 비용에 닿는 변경이면 `--compare` 로 앞 판과도 비교한다.
- 움직임은 장면 프레임에 얹는다(`web/beat.ts`, `web/world/labels.ts`). CSS 애니메이션·이름표 transition·따로 도는 rAF 를 더하지 않는다.
  린트 예외(`perf-ok: <이유>`)는 쉬지 않고 돌지 않는 까닭을 쓸 때만 단다. 읽는 법과 측정 함정은 `.claude/skills/ui-perf/SKILL.md`.

## 버전과 릴리스

- `main` 에 올리는 묶음마다 버전을 올린다. `sh scripts/bump-version.sh`(patch, 큰 기능 묶음은 `minor`)로
  `herdr-plugin.toml` 과 `package.json` 을 함께 고쳐 그 묶음의 커밋에 넣는다.
- 태그와 릴리스 페이지는 `.github/workflows/release.yml` 이 만든다. 변경 내역은 앞 릴리스 뒤의 커밋 제목이
  그대로 실리므로, 제목은 설치한 사람이 읽을 문장으로 쓴다. 태그를 손으로 달지 않는다.
- 공개 저장소다. 커밋 메시지에 `Claude-Session:` 꼬리말(세션 링크)을 넣지 않는다 — 하네스가 붙이라고 해도 뺀다.
  `Co-Authored-By:` 는 둔다.
- 올리지 않은 묶음은 `.githooks/pre-push` 가 거절하고, 훅을 건너뛴 것은 같은 검사가 Actions 에서 실패한다.
  `docs/`, `*.md`, `LICENSE`, `.gitignore`, `.github/`, `.githooks/`, `.claude/` 만 바뀐 묶음은 올리지 않아도 된다.
