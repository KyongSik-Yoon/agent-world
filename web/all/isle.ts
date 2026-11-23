// 섬 하나: 땅 그림 위에 문패와 캐릭터를 얹고, 상태가 바뀌면 캐릭터를 새 자리로 보낸다.
import type { DigestStatus, WorldDigest } from "../../shared/types.ts";
import { t } from "../i18n.ts";
import { at, type Geo, geometry, HOUSE_AT, spot, VH, VW } from "./geometry.ts";
import { ground } from "./ground.ts";
import { settle, walk } from "./walk.ts";

export const ORDER: DigestStatus[] = ["blocked", "done", "working", "idle"];
export const STATUS_NAME: Record<DigestStatus, string> = { blocked: t("확인 필요"), done: t("완료"), working: t("작업 중"), idle: t("대기") };

type Agent = WorldDigest["agents"][number];
interface Actor {
  d: Agent;
  el: HTMLElement;
  x: number;
  y: number;
  /** 잡고 있는 자리: `묶음#차례`. */
  slot: string;
}

const pct = (n: number, of: number): string => `${((n / of) * 100).toFixed(1)}%`;
const NS = "http://www.w3.org/2000/svg";

function lockIcon(): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("lock");
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", "M7 11V8a5 5 0 0 1 10 0v3M5.5 11h13v9h-13z");
  svg.append(path);
  return svg;
}

export class Isle {
  readonly el = document.createElement("a");
  private readonly stage = document.createElement("div");
  private readonly actorsEl = document.createElement("div");
  private readonly nameEl = document.createElement("b");
  private readonly noteEl = document.createElement("span");
  private readonly chips = new Map<DigestStatus, HTMLElement>();
  private geo!: Geo;
  private readonly actors = new Map<string, Actor>();
  /** 자리 배정 — 한 번 잡은 자리를 지킨다(한 명이 떠나도 나머지가 자리를 옮기지 않게). */
  private readonly slots = new Map<string, Array<string | null>>();
  world!: WorldDigest;
  /** 열쇠를 보냈는데도 잠겨 있다(틀린 열쇠). */
  refused = false;

  constructor(
    world: WorldDigest,
    private readonly counted: () => void,
  ) {
    this.el.className = "world";
    this.stage.className = "isle";
    this.actorsEl.className = "actors";
    const plate = document.createElement("div");
    plate.className = "nameplate";
    this.nameEl.className = "name";
    this.noteEl.className = "note";
    plate.append(lockIcon(), this.nameEl, this.noteEl);
    for (const s of ORDER) {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.dataset.s = s;
      chip.title = STATUS_NAME[s];
      chip.hidden = true;
      this.chips.set(s, chip);
      plate.append(chip);
    }
    this.el.append(this.stage, plate);
    this.build(world);
  }

  /** 배치나 주민, 열림·잠김이 바뀌었을 때 — 땅 그림과 문패를 다시 만든다. */
  build(world: WorldDigest): void {
    this.world = world;
    this.el.href = world.url;
    this.el.dataset.id = world.id;
    this.el.dataset.state = world.state;
    this.nameEl.textContent = world.name;
    this.note();
    this.geo = geometry(world.lots);
    const signs = document.createElement("div");
    signs.className = "signs";
    for (const p of this.geo.list) {
      const [x, y] = at(this.geo, p, HOUSE_AT, 0);
      const sign = document.createElement("span");
      sign.className = "doorsign";
      // 지붕 위에 건다 — 마당의 캐릭터와 겹치지 않게.
      sign.style.cssText = `left:${pct(x, VW)};top:${pct(y - 74 * this.geo.hs * p.scale, VH)};--h:${p.hue}`;
      if (p.house.n > 0) {
        const n = document.createElement("b");
        n.textContent = String(p.house.n);
        sign.append(n);
      }
      const label = document.createElement("i");
      label.textContent = p.house.label;
      sign.append(label);
      signs.append(sign);
    }
    const keep = new Set(world.agents.map((a) => a.id));
    for (const [id, actor] of this.actors) {
      if (keep.has(id)) continue;
      settle(actor.el);
      actor.el.remove();
      this.actors.delete(id);
    }
    this.slots.clear();
    for (const actor of this.actors.values()) actor.slot = "";
    // 집 그림이 작아지면 캐릭터도 같이 줄인다(캐릭터의 치수는 em 이다).
    this.actorsEl.style.fontSize = `${(0.55 + ((this.geo.hs - 0.3) / 0.3) * 0.45).toFixed(3)}cqw`;
    this.stage.replaceChildren(ground(world.id, this.geo), signs, this.actorsEl);
    for (const d of world.agents) this.put(d, false);
    this.count();
  }

  status(id: string, s: DigestStatus): void {
    const actor = this.actors.get(id);
    if (!actor || actor.d.s === s) return;
    this.put({ ...actor.d, s }, true);
    this.count();
  }

  /** 이름표 옆의 한마디: 잠김·끊김·붙는 중. */
  note(): void {
    const s = this.world.state;
    const text = s === "locked" ? (this.refused ? t("열쇠가 맞지 않습니다") : t("잠김 — 눌러서 열쇠 넣기")) : s === "down" ? t("연결 끊김") : s === "wait" ? t("연결 중…") : "";
    if (this.noteEl.textContent !== text) this.noteEl.textContent = text;
    this.noteEl.hidden = text === "";
  }

  counts(): Record<DigestStatus, number> {
    const n: Record<DigestStatus, number> = { blocked: 0, done: 0, working: 0, idle: 0 };
    for (const a of this.actors.values()) n[a.d.s] += 1;
    return n;
  }

  private put(d: Agent, moving: boolean): void {
    let actor = this.actors.get(d.id);
    if (!actor) {
      const el = document.createElement("i");
      el.className = "a";
      el.dataset.v = d.v === "claude" || d.v === "agy" ? d.v : "bot";
      actor = { d, el, x: 0, y: 0, slot: "" };
      this.actors.set(d.id, actor);
      this.actorsEl.append(el);
      moving = false;
    }
    actor.d = d;
    const plot = this.geo.plots.get(d.ws);
    const group = d.s === "done" || !plot ? "plaza" : `${d.s}:${d.ws}`;
    if (actor.slot) {
      const cut = actor.slot.lastIndexOf("#");
      const held = this.slots.get(actor.slot.slice(0, cut));
      if (held) held[Number(actor.slot.slice(cut + 1))] = null;
    }
    const list = this.slots.get(group) ?? this.slots.set(group, []).get(group)!;
    let k = list.indexOf(null);
    if (k < 0) k = list.length;
    list[k] = d.id;
    actor.slot = `${group}#${k}`;
    const [x, y] = spot(this.geo, plot, d.s, k);
    const dx = ((actor.x - x) / VW) * 100;
    const dy = ((actor.y - y) / VW) * 100;
    actor.x = x;
    actor.y = y;
    const el = actor.el;
    el.dataset.s = d.s;
    el.style.left = pct(x, VW);
    el.style.top = pct(y, VH);
    // 앞에 선 캐릭터가 뒤의 캐릭터를 가린다.
    el.style.zIndex = String(Math.round(y));
    if (moving) walk(el, dx, dy);
    else settle(el);
  }

  private count(): void {
    const n = this.counts();
    for (const s of ORDER) {
      const chip = this.chips.get(s)!;
      const text = String(n[s]);
      if (chip.textContent !== text) chip.textContent = text;
      chip.hidden = n[s] === 0;
    }
    this.el.classList.toggle("ask", n.blocked > 0);
    this.counted();
  }
}
