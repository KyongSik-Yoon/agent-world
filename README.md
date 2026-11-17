# Agent World

herdr 에 떠 있는 코딩 에이전트들을 3D 마을로 보여 주는 로컬 대시보드. 에이전트 하나가 캐릭터 하나이고,
**어디에 서 있는지가 곧 상태**다.

| 상태 | 캐릭터가 있는 곳 |
| --- | --- |
| 작업 중 | 자기 워크스페이스 집터의 마당에서 일한다. 말풍선에 지금 하는 일이 뜬다. |
| 완료 | 가운데 광장으로 걸어 나와 기다린다(초록 빛기둥). |
| 확인 필요 | 집터 대문 앞에 나와 뛴다(빨간 빛기둥). |
| 대기 | 집 옆에서 존다(흐리게). |

캐릭터를 누르면 상태 창이 열린다 — 모델, effort, 컨텍스트, 마지막 지시와 응답, 활동 로그, 터미널 화면.
`herdr 에서 열기`(Enter)는 herdr 화면을 그 pane 으로 옮기고, Hyprland 에서는 터미널 창까지 앞으로 가져온다.

## 실행

```sh
bun install
bun start            # http://127.0.0.1:4780
```

| 환경 변수 | 뜻 |
| --- | --- |
| `AGENT_WORLD_PORT` | 포트(기본 4780). 루프백에만 묶인다. |
| `AGENT_WORLD_RAISE=0` | `herdr 에서 열기`가 터미널 창을 앞으로 가져오지 않게 한다. |
| `HERDR_SOCKET_PATH` | herdr 소켓 경로(기본 `~/.config/herdr/herdr.sock`). |
| `AGENT_WORLD_DEV=1` | 화면 코드를 고칠 때. 번들을 매번 새로 만든다(`bun run dev`). |

단축키: `N` 다음 확인 대상 · `Enter` herdr 로 이동 · `/` 찾기 · `H` 전체 보기 · `T` 낮/밤 · `Esc` 닫기.

## 어떻게 아는가

하네스를 후킹하지 않는다. 두 가지만 읽는다.

- **herdr 소켓** (`session.snapshot`) — 어떤 pane 에 어떤 에이전트가 있고 상태가 무엇인지, 그리고 세션 id.
- **하네스가 스스로 쓰는 로그** — 그 세션 id 로 파일을 찾아 꼬리만 읽고, 모델·effort·지금 하는 일을 뽑는다.

| 하네스 | 로그 |
| --- | --- |
| Claude Code | `~/.claude/projects/*/<session>.jsonl` |
| Antigravity | `~/.gemini/antigravity-cli/brain/<session>/.system_generated/logs/transcript.jsonl` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*-<session>.jsonl` |

herdr 에 없는 세션(다른 터미널, 데스크톱 앱)은 최근 30분 안에 움직인 로그로 찾아내고, 상태는 로그 시각으로
추정한다. herdr 가 꺼져 있으면 이 방식만으로 돈다. 그 밖의 하네스는 herdr 가 알려 주는 제목과 상태만으로
캐릭터가 선다 — 로그를 읽게 하려면 `server/adapters/` 에 어댑터 하나를 더하면 된다.

## 구조

```
server/   Bun 서버 — herdr RPC, 로그 tail, 스냅샷을 SSE 로 밀어 준다
  adapters/   하네스별 로그 리더
web/      three.js 장면과 HUD
  world/      섬·집터(environment), 캐릭터(characters), 배우(actor), 배치(layout)
shared/   서버와 화면이 같이 쓰는 스냅샷 타입
dev/      mock-herdr.ts — 실제 herdr 없이 화면을 시험하는 흉내 소켓
```

`bun run probe` 는 서버를 띄우지 않고 지금의 스냅샷을 표로 찍는다.

캐릭터의 실루엣과 브랜드 마크는 Collie(MIT)의 상태줄 로고·아이콘 데이터에서 왔다.
