# Agent World

[한국어](README.md)

A local dashboard that shows the coding agents running in [herdr](https://herdr.dev) as a 3D village, and lets you
talk to them and build new workspaces without going back to the herdr window. One agent is one character, and
**where it stands is its status**.

| Status | Where the character is |
| --- | --- |
| Working | In the yard of its workspace's house. The speech bubble shows what it is doing. |
| Done | Walks out to the plaza in the middle and waits (green beam). |
| Needs input | Comes out to the gate of its house and jumps (red beam). |
| Idle | Dozes beside the house (dimmed). |

Click a character to open its status window: model, effort, context, last prompt and reply, activity log and the
terminal screen. The camera moves in on that character, and closing the window (✕ or Esc) returns to where you were.
`Open in herdr` (Enter) switches herdr to that pane and, on Hyprland, brings the terminal window to the front.

The UI is Korean by default. Switch to English with the `EN` button in the top bar (remembered per browser), by
opening `?lang=en`, or by setting `AGENT_WORLD_LANG=en`.

## What you can do in the world

| To | Do this |
| --- | --- |
| Send a prompt | The input at the bottom of the status window (`C`). Enter sends, Shift+Enter adds a line. Delivery is confirmed from the user turn that appears in the agent's log. |
| Show an image | Paste it into the input, drop it, or pick it with `＋` (PNG, JPEG, GIF, WebP; 10MB each, 8 at a time). It goes with the prompt. |
| Answer a question or permission request | When an agent needs input, the real dialog appears at the top of the status window. Press the number or key it shows with the quick-key row. |
| Use the terminal directly | `` ` `` opens it large. While it is open, keystrokes go straight to the pane. `Scrollback` shows earlier output. Shift+Esc closes it. |
| Mark a result as seen | Read a finished agent's status window and move on, and it is marked as seen and walks home (`D` does it at once; undo from the toast). |
| Widen the status window | Drag its left edge. The width is remembered; double-click to reset. |
| Build a house | `＋ New house` (`B`) — folder, name, worktree or not, the agent to add and its first prompt, in one go. |
| Add residents and tabs | Click a house sign for the house panel — `New resident`, `New tab`, rename, demolish. Shell panes stand in front of the house as small terminals. |
| Close things | Closing a pane, tab or house lists the agents that will stop with it and asks first. |

On a narrow screen such as a phone, the list becomes a drawer opened with `☰`, and the status window and terminal
use the whole screen. On touch devices the terminal shows a row of keys the on-screen keyboard lacks (Esc, Tab,
arrows, Ctrl+C …) and an input line that shows what you type.

You can **install it to the home screen** as an app: `Add to Home screen` (or `Install app`) in Android Chrome's menu,
or Share → `Add to Home Screen` in iOS Safari. It then opens full-screen without the address bar. On iOS a home-screen
app has storage separate from Safari, so paste the keyed address once after installing. When the server comes back
with a new version, open pages reload themselves (they wait while you are typing or have something open).

Worth knowing:

- **"Seen" is Agent World's own record.** herdr only counts a result as seen when its screen moves to that pane, and
  Agent World does not touch herdr's focus. So herdr's sidebar keeps its done mark (pressing `Open in herdr` clears
  both). The record lives in `~/.local/state/agent-world/seen.json` (`seen-<socket hash>.json` for a named herdr
  session) and is dropped automatically when the agent works again.
- **Questions are not turned into buttons.** Choices differ by harness and version, so the screen is shown as it is
  and keys are sent as they are.
- Terminal colours come from your ghostty config — background, foreground and palette, including `theme = …`
  (a dark default otherwise).
- **Attached images become files on this machine.** They are written to `~/.cache/agent-world/images/` and the path
  is typed into the pane. Claude Code turns the path into `[Image #N]`; other harnesses get the path in the prompt
  text. Files older than seven days are removed.
- Left to the herdr TUI: pane layout, size and movement, copy mode, mouse, plugins, remote machines, session management.

## Use it as a herdr plugin

```sh
herdr plugin install KyongSik-Yoon/agent-world
```

It needs [Bun](https://bun.sh) (checked on 1.4.4). Once installed, herdr starts the server whenever herdr starts
(and leaves it alone if one is already running for that session), and the command palette gets four actions.

| Action | What it does |
| --- | --- |
| `Agent World: open in browser` | Starts it if needed and opens it in the browser, handing over the access key. |
| `Agent World: show address` | Shows the keyed address in a popup — for the first visit from another browser such as a phone (`o` open · `r` restart · `s` stop). |
| `Agent World: restart` | Stops and starts it again — after an update or a config change. |
| `Agent World: stop` | Stops the server for this herdr session. |

The server attaches to that herdr session. The default session is at `http://127.0.0.1:4780`; a named session gets
its own fixed port (see `AGENT_WORLD_PORT` below). To configure it, put the environment variables below as
`NAME=value` lines in the `env` file of the folder printed by `herdr plugin config-dir kyongsik-yoon.agent-world`,
then `restart`:

```sh
AGENT_WORLD_LANG=en
AGENT_WORLD_READONLY=1
```

Logs are in `herdr plugin log list --plugin kyongsik-yoon.agent-world` and in `server.log` in the plugin's state folder.

## Run it yourself

```sh
bun install
bun start            # Agent World → http://127.0.0.1:4780/#k=<key>
```

The printed address carries an **access key**. Open that address once in each browser; after that the browser
remembers it and plain `http://127.0.0.1:4780` works. `bun run url` prints the address again.

| Environment variable | Meaning |
| --- | --- |
| `AGENT_WORLD_PORT` | Port. Without it, each herdr session uses a fixed one — 4780 for the default session, and for a named session one port in 4781–4879 derived from its socket path (the same session always gets the same port). If that port is taken it moves to the next one, and if a server is already running for the same herdr it just prints that address and exits. `bun run url` prints the current address. Bound to loopback only. |
| `AGENT_WORLD_LANG` | Default language: `en` for English, Korean otherwise. Each browser can switch with the `EN`/`한` button in the top bar (remembered) or by opening `?lang=en`. |
| `AGENT_WORLD_READONLY=1` | Read-only. Refuses prompts, keystrokes, creating, closing and `Open in herdr` (moving herdr's screen). Viewing still needs the key. |
| `AGENT_WORLD_TRUST_HOSTS` | The address(es) used when serving through `tailscale serve` (`host.tailnet.ts.net:4780`, comma-separated). Only requests from the account that put this machine on the tailnet are accepted. |
| `AGENT_WORLD_OUTSIDE=1` | Also show sessions outside herdr (other terminals, desktop apps) while attached to herdr. |
| `AGENT_WORLD_RAISE=0` | Do not bring the terminal window to the front on `Open in herdr`. |
| `HERDR_SOCKET_PATH` | herdr socket path (default `~/.config/herdr/herdr.sock`). |
| `AGENT_WORLD_DEV=1` | For working on the UI: rebuilds the bundle on every change (`bun run dev`). |

Camera: drag to rotate, `Space`+drag (or middle/right-button drag) to pan, wheel to zoom. `⌂` (`H`) resets position,
zoom and angle.

Shortcuts: `N` next agent to check · `C` talk · `` ` `` terminal · `D` mark as seen · `B` build a house · `Enter` open
in herdr · `/` search · `H` home · `T` day/night · `Esc` close. Shortcuts are off while you type in an input or the terminal.

This server shows your terminal screens and can type into your terminals. So:

- It binds to 127.0.0.1 only and requires an **access key** on every `/api` request. The key is created on first
  start and kept in a file only you can read (`~/.local/state/agent-world/key`), so other accounts on the same
  machine, or a program that merely knows the address, can neither read screens nor type. To rotate the key, delete
  that file and restart (each browser then needs the new address once).
- Changes are accepted only as same-origin POSTs and only target panes, tabs and workspaces that exist in herdr now.
- The page is served with a Content-Security-Policy, a second barrier against agent-written text running as script.

Treat the keyed address like a password — do not paste it where others can see it.

To use it from another device, expose it inside your tailnet only (never to the public internet):

```sh
AGENT_WORLD_TRUST_HOSTS=<host>.<tailnet>.ts.net:4780 bun start
tailscale serve --bg --https=4780 http://127.0.0.1:4780
```

At start the server also prints the tailnet address with the key — open that once on the other device. A request
from the tailnet must carry the key and come from the account that put this machine on the tailnet. Use
`tailscale serve` in HTTPS mode only: requests arriving through `tailscale funnel` (public internet) are refused, and
raw `--tcp` forwarding should not be used because the sender cannot be identified.

## How it knows

It does not hook into the harnesses. It reads two things.

- **The herdr socket** — `session.snapshot` tells it which pane runs which agent, its status and its session id.
  Control goes through the same socket (`agent.prompt`, `pane.send_input`, `workspace.create`, `agent.start` …).
- **The logs the harnesses write themselves** — it finds the file by session id, reads only the tail, and takes the
  model, effort and current activity from it.

| Harness | Log |
| --- | --- |
| Claude Code | `~/.claude/projects/*/<session>.jsonl` |
| Antigravity | `~/.gemini/antigravity-cli/brain/<session>/.system_generated/logs/transcript.jsonl` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*-<session>.jsonl` |

While attached to herdr it shows herdr's agents only, because sessions outside herdr (other terminals, desktop
apps) cannot be talked to or marked as seen from here. When herdr is not running it finds sessions from logs that
moved in the last 30 minutes and estimates their status from log times (`AGENT_WORLD_OUTSIDE=1` shows them even
while herdr is running). Other harnesses get a character from the title and status herdr reports — add an adapter
under `server/adapters/` to read their logs.

## Layout

```
server/   Bun server — herdr RPC, log tailing, snapshots pushed over SSE
  control.ts  control endpoints (prompts, keys, terminal mirror, create, close)
  adapters/   log readers per harness
  text.ts     server messages in both languages
  key.ts      the access key and owner-only state files
web/      three.js scene and HUD
  detail.ts   status window (agent, shell, house), term.ts terminal mirror, build.ts create/close dialogs
  world/      island and plots (environment), characters, actors, layout, label layer (labels)
  app/        manifest and icons for installing to the home screen
  i18n.ts     t() and the language switch; locale/en.ts holds the English strings
shared/   snapshot types used by both sides
scripts/  plugin.ts — start/stop/open when run as a herdr plugin
dev/      mock-herdr.ts — a fake herdr socket for testing the UI; i18n-check.ts
```

`bun run probe` prints the current snapshot as a table without starting the server. `bun run url` prints the address
(with the key) of the server running for this herdr session. `bun run i18n` checks that every UI string has an English entry.

To test control features, use a named test session instead of the herdr you are working in:

```sh
env -u HERDR_SOCKET_PATH -u HERDR_CLIENT_SOCKET_PATH -u HERDR_SESSION -u HERDR_ENV herdr --session aw-test server &
HERDR_SOCKET_PATH=~/.config/herdr/sessions/aw-test/herdr.sock AGENT_WORLD_PORT=4782 bun start
herdr session stop aw-test && herdr session delete aw-test
```

The brand marks (glyphs and tile colours) come from Collie's (MIT) icon data. The Clawd and Antigravity-arch characters are silhouettes drawn for this project. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

[MIT](LICENSE)
