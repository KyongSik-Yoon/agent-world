// 스냅샷의 값을 사람이 읽는 한국어 문구로 바꾼다 — 말풍선, 로스터, 상세 패널이 같이 쓴다.
import type { Activity, AgentStatus, AgentView } from "../shared/types.ts";
import { lang, t } from "./i18n.ts";

export const STATUS_LABEL: Record<AgentStatus, string> = {
  blocked: t("확인 필요"),
  done: t("완료"),
  working: t("작업 중"),
  idle: t("대기"),
  unknown: t("알 수 없음"),
};

/** 내가 먼저 봐야 하는 순서. */
export const STATUS_ORDER: AgentStatus[] = ["blocked", "done", "working", "idle", "unknown"];

export function needsAttention(status: AgentStatus): boolean {
  return status === "blocked" || status === "done";
}

// 활동 줄 틀: {what} 자리에 대상이 들어간다(영어는 동사가 앞에 와서 문장째로 풀어야 한다). 빈 틀이면 icon 과 대상만 쓴다.
const VERBS: Array<[RegExp, string, string]> = [
  [/^(bash|shell|exec|run_command|local_shell|command_status|send_command_input)/i, "⚡", ""],
  [/^(read|view_file|view_|list_dir|ls$|notebookread)/i, "📖", t("{what} 읽는 중")],
  [/^(edit|write|multiedit|notebookedit|apply_patch|write_to_file|replace_file_content|multi_replace)/i, "✏️", t("{what} 고치는 중")],
  [/^(grep|glob|grep_search|find|codebase_search|toolsearch)/i, "🔍", t("{what} 찾는 중")],
  [/^(agent|task$|taskcreate|browser_subagent|workflow)/i, "🤝", t("{what} 맡기는 중")],
  [/^(webfetch|websearch|search_web|read_url)/i, "🌐", ""],
  [/^(todowrite|update_plan|task)/i, "📝", t("{what} 계획 정리")],
  [/^skill/i, "🎓", t("{what} 스킬")],
  [/^advisor/i, "🧭", t("{what} 조언 구하는 중")],
];

function toolName(name: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  return mcp ? `${mcp[1]} · ${mcp[2]}` : name;
}

/** 활동 하나를 한 줄로. 말풍선과 활동 로그에 쓴다. */
export function activityLine(a: Activity): string {
  switch (a.kind) {
    case "thinking":
      return t("💭 생각 중…");
    case "text":
      return `💬 ${plain(a.text)}`;
    case "user":
      return `📨 ${plain(a.text)}`;
    case "result":
      return a.text;
    case "tool": {
      if (a.name.startsWith("mcp__")) return `🔌 ${toolName(a.name)}${a.text ? ` · ${a.text}` : ""}`;
      for (const [re, icon, verb] of VERBS) {
        if (!re.test(a.name)) continue;
        const what = a.text || a.name;
        return `${icon} ${verb ? verb.replace("{what}", what) : what}`;
      }
      return `🔧 ${a.name}${a.text ? ` · ${a.text}` : ""}`;
    }
  }
}

/** 마크다운 기호를 걷어낸 한 줄 — 링크는 글자만 남긴다. */
export function plain(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*`]|^#+\s*|^>\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function firstLine(text: string | undefined): string {
  const line = (text ?? "").split("\n").find((l) => l.trim());
  return line ? plain(line) : "";
}

/**
 * 머리 위 말풍선. 쉬는 에이전트는 말풍선이 없다(null).
 * full 이 아니면 완료는 짧은 한마디만 한다 — 광장에 여럿이 모여도 서로를 덮지 않게.
 */
export function bubbleText(a: AgentView, full = true): string | null {
  switch (a.status) {
    case "working":
      return a.activity ? activityLine(a.activity) : t("⏳ 일하는 중…");
    case "done": {
      const line = full ? firstLine(a.lastReply) : "";
      return `✅ ${line || t("다 했어요!")}`;
    }
    case "blocked": {
      // 무엇을 기다리는지 로그에서 읽혔으면 그것을 말한다.
      const p = a.pending;
      if (!p) return t("🙋 확인이 필요해요");
      const what = (p.questions?.[0]?.question || p.detail).split("\n").find((l) => l.trim() && !l.startsWith("#")) ?? "";
      const line = what.length > 60 ? `${what.slice(0, 59)}…` : what;
      return p.asksUser ? `🙋 ${line || t("질문이 있어요")}` : `🔐 ${p.tool}${line ? ` · ${line}` : ""}`;
    }
    default:
      return null;
  }
}

export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 5) return t("방금");
  if (s < 60) return t("{n}초 전", { n: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t("{n}분 전", { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? t("{h}시간 {m}분 전", { h, m: m % 60 }) : t("{h}시간 전", { h });
  return t("{n}일 전", { n: Math.floor(h / 24) });
}

export function duration(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return t("{n}초", { n: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t("{n}분", { n: m });
  const h = Math.floor(m / 60);
  return h < 24 ? t("{h}시간 {m}분", { h, m: m % 60 }) : t("{n}일", { n: Math.floor(h / 24) });
}

/** 상태 옆에 붙는 시간 문구: "12분째", "3분 전". */
export function statusAge(a: AgentView, now = Date.now()): string {
  if (!a.statusSince) return "";
  return a.status === "working" || a.status === "blocked" ? t("{time}째", { time: duration(a.statusSince, now) }) : ago(a.statusSince, now);
}

export function tokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

export function clock(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString(lang === "en" ? "en-GB" : "ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

const EFFORT_LEVEL: Record<string, number> = { minimal: 1, low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };

/** effort 를 5칸 눈금으로. 모르는 값이면 0. */
export function effortLevel(effort: string | undefined): number {
  return effort ? (EFFORT_LEVEL[effort.toLowerCase()] ?? 0) : 0;
}

/** 홈 디렉터리를 ~ 로 줄인다. */
export function shortPath(path: string): string {
  return path.replace(/^\/home\/[^/]+/, "~");
}
