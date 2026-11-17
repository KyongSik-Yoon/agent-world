# Agent World

[English](README.en.md)

herdr 에 떠 있는 코딩 에이전트들을 3D 마을로 보여 주고, herdr 창으로 돌아가지 않고도 말을 걸고 집을 짓는
로컬 대시보드. 에이전트 하나가 캐릭터 하나이고, **어디에 서 있는지가 곧 상태**다.

| 상태 | 캐릭터가 있는 곳 |
| --- | --- |
| 작업 중 | 자기 워크스페이스 집터의 마당에서 일한다. 말풍선에 지금 하는 일이 뜬다. |
| 완료 | 가운데 광장으로 걸어 나와 기다린다(초록 빛기둥). |
| 확인 필요 | 집터 대문 앞에 나와 뛴다(빨간 빛기둥). |
| 대기 | 집 옆에서 존다(흐리게). |

캐릭터를 누르면 상태 창이 열린다 — 모델, effort, 컨텍스트, 마지막 지시와 응답, 활동 로그, 터미널 화면.
카메라가 그 캐릭터에게 다가가고, 창을 닫으면(✕ 또는 Esc) 고르기 전에 보던 자리와 배율로 돌아간다.
`herdr 에서 열기`(Enter)는 herdr 화면을 그 pane 으로 옮기고, Hyprland 에서는 터미널 창까지 앞으로 가져온다.

## 월드에서 하는 일

| 하고 싶은 일 | 어떻게 |
| --- | --- |
| 지시 보내기 | 상태 창 아래 입력창(`C`). Enter 전송, Shift+Enter 줄바꿈. 받았는지는 로그에 찍힌 사용자 턴으로 확인해 알려 준다. |
| 이미지 보여 주기 | 입력창에 붙여넣거나, 끌어다 놓거나, `＋` 로 고른다(PNG·JPEG·GIF·WebP, 장당 10MB, 한 번에 8장). 지시와 함께 간다. |
| 질문·권한에 답하기 | 확인 필요가 되면 상태 창 위에 실제 대화상자가 뜬다. 적힌 번호·키를 빠른 키 줄로 누른다. |
| 터미널 직접 다루기 | `` ` `` 로 크게 보기. 열려 있는 동안 키 입력이 그대로 pane 으로 간다(한글 포함). `지난 출력 보기`로 스크롤백. Shift+Esc 로 닫는다. |
| 완료 확인 | 완료한 캐릭터의 상태 창을 읽고 떠나면 확인 처리되어 집으로 돌아간다(`D` 로 바로, 토스트에서 되돌리기). |
| 상태 창 넓히기 | 상태 창의 왼쪽 가장자리를 끈다. 맞춘 폭은 브라우저에 기억되고, 두 번 누르면 처음 폭으로 돌아간다. |
| 집 짓기 | `＋ 집 짓기`(`B`) — 폴더, 이름, 워크트리 여부, 들일 에이전트와 첫 지시까지 한 번에. |
| 주민·탭 늘리기 | 집 문패를 누르면 집 패널 — `새 주민`, `새 탭`, 이름 바꾸기, 철거. 셸 pane 은 집 앞 단말기로 서 있다. |
| 닫기 | pane·탭·집 닫기는 함께 꺼지는 에이전트를 보여 주고 확인을 받는다. |

휴대폰처럼 좁은 화면에서는 목록이 `☰` 로 여닫는 서랍이 되고, 상태 창과 터미널은 화면 전체를 쓴다. 터치 기기의
터미널에는 화면 자판에 없는 키(Esc·Tab·화살표·Ctrl+C 등)가 단추 줄로 나오고, 치는 글자가 보이는 입력란이 아래에 붙는다.

알아 둘 점:

- **확인 처리는 월드만의 기록이다.** herdr 는 화면을 그 pane 으로 옮겼을 때만 "봤다"고 치는데, 월드는 herdr 의
  초점을 건드리지 않는다. 그래서 herdr 사이드바에는 완료 표시가 남는다(`herdr 에서 열기`를 누르면 함께 풀린다).
  기록은 `~/.local/state/agent-world/seen.json` 에 있고(이름 붙은 herdr 세션은 `seen-<소켓 해시>.json` 으로 따로), 에이전트가 다시 일하면 저절로 무효가 된다.
- **질문을 버튼으로 바꾸지 않는다.** 하네스와 버전마다 선택지가 달라서, 화면을 그대로 보여 주고 키를 그대로 보낸다.
- 터미널의 색은 ghostty 설정에서 읽은 배경·글자색·팔레트로 그린다(없으면 어두운 기본색).
- **붙인 이미지는 이 PC 의 파일이 된다.** `~/.cache/agent-world/images/` 에 적고 그 경로를 pane 에 넣는다. Claude Code 는
  경로를 받아 `[Image #N]` 으로 달고, 그 밖의 하네스에는 경로를 글에 실어 보낸다. 이레가 지난 파일은 지운다.
- herdr TUI 에 남겨 둔 것: pane 배치·크기·이동, 복사 모드, 마우스, 플러그인, 원격 머신, 세션 관리.

## herdr 플러그인으로 쓰기

```sh
herdr plugin install KyongSik-Yoon/agent-world
```

[Bun](https://bun.sh)이 있어야 한다(1.4.4 에서 확인했다). 설치하면 herdr 가 시작할 때마다 서버를 띄워 두고(같은 세션에 이미 떠 있으면 그대로 둔다),
명령 팔레트에 네 가지 동작이 생긴다.

| 동작 | 하는 일 |
| --- | --- |
| `Agent World: open in browser` | 떠 있지 않으면 띄우고 브라우저로 연다(접속 열쇠까지 넘겨 준다). |
| `Agent World: show address` | 열쇠가 붙은 주소를 팝업으로 보여 준다 — 휴대폰 같은 다른 브라우저에서 처음 열 때 쓴다(`o` 열기 · `r` 다시 띄우기 · `s` 끄기). |
| `Agent World: restart` | 껐다가 다시 띄운다 — 업데이트하거나 설정을 바꾼 뒤에. |
| `Agent World: stop` | 이 herdr 세션의 서버를 끈다. |

서버는 그 herdr 세션에 붙는다. 기본 세션은 `http://127.0.0.1:4780`, 이름 붙은 세션은 세션마다 정해진 다른 포트다(아래 `AGENT_WORLD_PORT`).
설정은 `herdr plugin config-dir kyongsik-yoon.agent-world` 가 찍는 폴더의 `env` 파일에 아래 환경 변수를 `이름=값` 으로 적고 `restart` 한다:

```sh
AGENT_WORLD_LANG=en
AGENT_WORLD_READONLY=1
```

서버의 기록은 `herdr plugin log list --plugin kyongsik-yoon.agent-world` 와 플러그인 상태 폴더의 `server.log` 에 남는다.

## 직접 실행

```sh
bun install
bun start            # Agent World → http://127.0.0.1:4780/#k=<열쇠>
```

찍힌 주소에는 **접속 열쇠**가 붙어 있다. 브라우저마다 처음 한 번은 이 주소로 열어야 하고, 그 뒤로는 그 브라우저가 기억한다
(`http://127.0.0.1:4780` 만으로 열린다). 주소를 다시 보려면 `bun run url`.

| 환경 변수 | 뜻 |
| --- | --- |
| `AGENT_WORLD_PORT` | 포트. 주지 않으면 herdr 세션마다 정해진 자리를 쓴다 — 기본 세션은 4780, 이름 붙은 세션은 소켓 경로에서 정해지는 4781~4879 의 한 포트(세션이 같으면 늘 같다). 그 자리가 차 있으면 옆 포트로 옮겨 띄우고, 같은 herdr 에 이미 떠 있으면 그 주소만 알리고 끝난다. 지금 주소는 `bun run url` 이 찍는다. 루프백에만 묶인다. |
| `AGENT_WORLD_LANG` | 기본 말. `en` 이면 영어, 그 밖에는 한국어. 화면 오른쪽 위의 `EN`/`한` 단추로 브라우저마다 따로 바꿀 수 있고(기억된다), 주소에 `?lang=en` 을 붙여 열어도 된다. |
| `AGENT_WORLD_READONLY=1` | 보기 전용. 지시·키 입력·만들기·닫기와 `herdr 에서 열기`(herdr 화면 옮기기) 요청을 모두 거절한다. 보는 데에도 열쇠는 필요하다. |
| `AGENT_WORLD_TRUST_HOSTS` | `tailscale serve` 로 내보낼 때의 주소(`host.tailnet.ts.net:4780`, 쉼표로 여럿). 이 PC 를 tailnet 에 올린 계정의 요청만 받는다. |
| `AGENT_WORLD_OUTSIDE=1` | herdr 에 붙어 있는 동안에도 herdr 밖 세션(다른 터미널, 데스크톱 앱)을 함께 보여 준다. |
| `AGENT_WORLD_RAISE=0` | `herdr 에서 열기`가 터미널 창을 앞으로 가져오지 않게 한다. |
| `HERDR_SOCKET_PATH` | herdr 소켓 경로(기본 `~/.config/herdr/herdr.sock`). |
| `AGENT_WORLD_DEV=1` | 화면 코드를 고칠 때. 번들을 매번 새로 만든다(`bun run dev`). |

화면 조작: 드래그로 회전, `Space`+드래그(또는 휠 버튼·오른쪽 버튼 드래그)로 맵 이동, 휠로 확대·축소. `⌂`(`H`)는
위치·배율·각도를 처음 화면으로 되돌린다.

단축키: `N` 다음 확인 대상 · `C` 말 걸기 · `` ` `` 터미널 · `D` 확인 완료 · `B` 집 짓기 · `Enter` herdr 로 이동 ·
`/` 찾기 · `H` 처음 화면 · `T` 낮/밤 · `Esc` 닫기. 입력란이나 터미널에 글을 치는 동안에는 단축키가 듣지 않는다.

이 서버는 터미널 화면을 내보내고 터미널에 글자를 넣을 수 있다. 그래서:

- 127.0.0.1 에만 묶이고, 모든 `/api` 요청에 **접속 열쇠**를 요구한다. 열쇠는 처음 뜰 때 만들어 이 사용자만 읽는 파일
  (`~/.local/state/agent-world/key`)에 둔다 — 같은 PC 의 다른 계정이나, 주소만 아는 다른 프로그램은 화면을 읽지도 글자를 넣지도 못한다.
  열쇠를 바꾸려면 그 파일을 지우고 서버를 다시 띄운다(브라우저마다 새 주소로 한 번 다시 열어야 한다).
- 바꾸는 요청은 같은 출처에서 온 POST 만 받고, 대상은 지금 herdr 에 실제로 있는 pane·탭·스페이스로 한정한다.
- 화면 문서에는 콘텐츠 보안 정책을 붙여, 에이전트가 쓴 글이 스크립트로 돌 길을 한 겹 더 막는다.

열쇠가 붙은 주소는 비밀번호처럼 다룬다 — 남에게 보이는 곳에 붙여 넣지 않는다.

다른 기기에서 쓰려면 tailnet 안으로만 내보낸다(공인 인터넷 공개는 하지 않는다):

```sh
AGENT_WORLD_TRUST_HOSTS=<host>.<tailnet>.ts.net:4780 bun start
tailscale serve --bg --https=4780 http://127.0.0.1:4780
```

서버가 뜰 때 tailnet 주소도 열쇠와 함께 찍어 준다 — 다른 기기에서는 그 주소로 한 번 연다. tailnet 으로 온 요청은 열쇠에 더해,
이 PC 를 tailnet 에 올린 계정의 것일 때만 받는다. `tailscale serve` 의 HTTPS 방식만 쓴다: `tailscale funnel`(공인 인터넷 공개)로 온
요청은 거절하고, `--tcp` 로 그대로 넘기는 방식은 누가 보냈는지 알 수 없으므로 쓰지 않는다.

## 어떻게 아는가

하네스를 후킹하지 않는다. 두 가지만 읽는다.

- **herdr 소켓** — `session.snapshot` 으로 어떤 pane 에 어떤 에이전트가 있고 상태가 무엇인지, 세션 id 를 읽는다.
  조작도 같은 소켓으로 한다(`agent.prompt`, `pane.send_input`, `workspace.create`, `agent.start` …).
- **하네스가 스스로 쓰는 로그** — 그 세션 id 로 파일을 찾아 꼬리만 읽고, 모델·effort·지금 하는 일을 뽑는다.

| 하네스 | 로그 |
| --- | --- |
| Claude Code | `~/.claude/projects/*/<session>.jsonl` |
| Antigravity | `~/.gemini/antigravity-cli/brain/<session>/.system_generated/logs/transcript.jsonl` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*-<session>.jsonl` |

herdr 에 붙어 있는 동안에는 herdr 의 에이전트만 보여 준다. herdr 밖의 세션(다른 터미널, 데스크톱 앱)은 월드에서
말을 걸 수도 확인 처리할 수도 없기 때문이다. herdr 가 꺼져 있으면 최근 30분 안에 움직인 로그로 세션을 찾아내고
상태는 로그 시각으로 추정한다(`AGENT_WORLD_OUTSIDE=1` 이면 herdr 가 켜져 있어도 함께 보여 준다). 그 밖의 하네스는 herdr 가 알려 주는 제목과 상태만으로
캐릭터가 선다 — 로그를 읽게 하려면 `server/adapters/` 에 어댑터 하나를 더하면 된다.

## 구조

```
server/   Bun 서버 — herdr RPC, 로그 tail, 스냅샷을 SSE 로 밀어 준다
  control.ts  조작 엔드포인트(지시·키 입력·터미널 미러·만들기·닫기)
  adapters/   하네스별 로그 리더
  text.ts     서버가 건네는 말(한국어·영어)
  key.ts      접속 열쇠와 이 사용자만 읽는 상태 파일
web/      three.js 장면과 HUD
  detail.ts   상태 창(에이전트·셸·집), term.ts 터미널 미러, build.ts 만들기·닫기 대화상자
  world/      섬·집터(environment), 캐릭터(characters), 배우(actor), 배치(layout), 이름표 층(labels)
  i18n.ts     t() 와 말 바꾸기 — 영어 풀이는 locale/en.ts
shared/   서버와 화면이 같이 쓰는 스냅샷 타입
scripts/  plugin.ts — herdr 플러그인으로 돌 때의 시작·정지·열기
dev/      mock-herdr.ts — 실제 herdr 없이 화면을 시험하는 흉내 소켓, i18n-check.ts
```

`bun run probe` 는 서버를 띄우지 않고 지금의 스냅샷을 표로 찍는다. `bun run url` 은 이 herdr 세션에 떠 있는 서버의 주소를 찍는다
(열쇠 포함. 서버가 `~/.local/state/agent-world/server*.json` 에 적어 둔 것을 읽는다). `bun run i18n` 은 화면의 문장마다
영어 풀이가 있는지 본다 — 화면에 글을 더하면 `t("…")` 로 감싸고 `web/locale/en.ts` 에 풀이를 적는다.

조작을 시험할 때는 쓰고 있는 herdr 대신 이름 붙은 테스트 세션을 쓴다:

```sh
# 따로 도는 빈 herdr. herdr pane 안에서 띄울 때는 물려받은 HERDR_* 를 떼어야 쓰던 세션과 섞이지 않는다.
env -u HERDR_SOCKET_PATH -u HERDR_CLIENT_SOCKET_PATH -u HERDR_SESSION -u HERDR_ENV herdr --session aw-test server &
HERDR_SOCKET_PATH=~/.config/herdr/sessions/aw-test/herdr.sock AGENT_WORLD_PORT=4782 bun start
herdr session stop aw-test && herdr session delete aw-test
```

캐릭터의 실루엣과 브랜드 마크는 Collie(MIT)의 상태줄 로고·아이콘 데이터에서 왔다. 자세한 고지는 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## 라이선스

[MIT](LICENSE)
