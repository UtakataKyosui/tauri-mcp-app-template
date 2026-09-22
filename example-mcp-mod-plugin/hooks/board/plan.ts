/**
 * 看板への要求と、モデルが読むテキストの組み立て。
 * ここには engine interface を持ち込まない。`$` はフック本体でしか使えず、
 * 別モジュールへ渡すと `claude plugin validate` が読めなくなる。
 */
import type { Card, PendingOp, Policy, ProgressEntry, Status } from "./types";

export const TOOL_PREFIX = "mcp__kanban__";

/** socketPath で到達先が決まるため、host 名は捨てられる。 */
export const ORIGIN = "http://kanban";

export const OUTBOX_KEY = "board.outbox";
export const OUTBOX_LIMIT = 200;

export const STATUSES: Status[] = ["backlog", "ready", "doing", "review", "done", "blocked"];

export const DEFAULT_SOCKET_SUFFIX = "/.local/share/sample-tauri-app/board.sock";

/**
 * 看板がポリシーやカードを編集したときに touch するファイル。engine の
 * ファイル監視に載せて classic.FileChanged で受けると、ポーリングなしで
 * キャッシュを捨てられる。
 */
export function revisionPath(socket: string): string {
  const cut = socket.lastIndexOf("/");
  return `${cut < 0 ? "." : socket.slice(0, cut)}/board.revision`;
}

export function op(
  at: number,
  method: PendingOp["method"],
  path: string,
  body?: unknown,
): PendingOp {
  return { at, method, path, body };
}

export function cardPath(id: string): string {
  return `/cards/${encodeURIComponent(id)}`;
}

export function focusOf(cards: readonly Card[], focus?: string): Card | undefined {
  if (focus) {
    const named = cards.find((c) => c.id === focus);
    if (named) return named;
  }
  return cards.find((c) => c.status === "doing");
}

export function phaseOf(card: Card): string {
  return card.phase ?? card.status;
}

export function policyFor(
  policies: Record<string, Policy> | undefined,
  card: Card | undefined,
): Policy | undefined {
  if (!policies || !card) return undefined;
  return policies[phaseOf(card)];
}

/**
 * deny が優先し、allow があればそこに無いものを拒否する。ポリシーが無ければ
 * 許可する。看板が読めないときは policy が undefined になり、ここも許可を返す。
 * 遮断側に倒すと、看板の不在だけで SubAgent が全て消える。
 */
export function allows(
  policy: Policy | undefined,
  kind: "skills" | "agents",
  name: string,
): boolean {
  const rule = policy?.[kind];
  if (!rule) return true;
  if (rule.deny?.includes(name)) return false;
  if (rule.allow && !rule.allow.includes(name)) return false;
  return true;
}

export function blockedReason(kind: "Skill" | "SubAgent", name: string, phase: string): string {
  return `${kind} "${name}" は Phase "${phase}" では使えません。看板のポリシーで許可されていません。`;
}

/**
 * Skill 一覧は prompt.section ではなく prompt.attachment の `skill_listing`
 * として届く（実行時に観測して確認した）。1 エントリは行頭の `- ` で始まり、
 * 次の `- ` までが 1 件。名前は説明との区切りのコロンまでだが、名前自体が
 * `plugin:skill` のようにコロンを含むため、末尾のコロンだけを落とす。
 */
export function filterSkillListing(text: string, allowed: (name: string) => boolean): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let keeping = true;
  for (const line of lines) {
    const entry = /^- ([A-Za-z0-9_.:-]+)/.exec(line);
    if (entry) {
      keeping = allowed(entry[1]!.replace(/:$/, ""));
      if (keeping) out.push(line);
      continue;
    }
    // 見出しと、直前のエントリの続き行。続き行は残す判定を引き継ぐ。
    if (keeping) out.push(line);
  }
  return out.join("\n");
}

/** モデルが読む形。entries は嵩むので直近3件に切る。 */
export function renderCard(card: Card): string {
  const reqs = card.requirements.map((r) => `- ${r}`).join("\n");
  const recent = card.entries
    .slice(-3)
    .map((e) => `- ${e.at} ${e.by}: ${e.note}`)
    .join("\n");
  return [
    `## ${card.id} ${card.title} [${card.status}]`,
    `目的: ${card.objective}`,
    `担当: ${card.assignment.runtime} / ${card.assignment.model} / effort ${card.assignment.effort}` +
      (card.assignment.role ? ` / role ${card.assignment.role}` : ""),
    `到達点: ${card.summary || "(未記録)"}`,
    reqs && `要件:\n${reqs}`,
    recent && `直近の進捗:\n${recent}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** 実行者に渡す指示は、カードの目的・要件・到達点から組み立てる。 */
export function promptFor(card: Card): string {
  return [
    `# ${card.title} (${card.id})`,
    "",
    "## 目的",
    card.objective,
    "",
    "## 要件",
    ...card.requirements.map((r) => `- ${r}`),
    "",
    "## ここまでの到達点",
    card.summary || "(未着手)",
  ].join("\n");
}

export function progressEntry(at: string, note: string): ProgressEntry {
  return { at, by: "claude", note };
}

export const RULES = [
  "この作業は Tauri 製の看板で管理されている。看板のカードが、タスクの目的・要件・到達点・担当(claude か codex か、どのモデルを何 effort で使うか)の唯一の記録である。",
  "モデルや effort を自分で選ばない。カードの assignment に従う。従えない理由があるときは、実行する前にそれを述べる。",
  "作業の区切りごとに mcp__kanban__progress で到達点を看板へ書き戻す。会話が圧縮されても看板は残る。",
  "カードに無い作業を始める前に、mcp__kanban__board で既存のカードを確認する。",
].join("\n");

export function focusBlock(card: Card | undefined, pending: number): string {
  const head = card
    ? [
        `focus: ${card.id} ${card.title} [${card.status}]`,
        `目的: ${card.objective}`,
        `担当: ${card.assignment.runtime} / ${card.assignment.model} / effort ${card.assignment.effort}`,
        `到達点: ${card.summary || "(未着手)"}`,
      ].join("\n")
    : "focus: なし。着手前に mcp__kanban__board でカードを確認する。";
  const warn = pending > 0 ? `\n\n注意: 看板アプリへ届いていない書き込みが ${pending} 件ある。` : "";
  return head + warn;
}

export function promptFrame(card: Card): string {
  const a = card.assignment;
  return `<kanban card="${card.id}" runtime="${a.runtime}" model="${a.model}" effort="${a.effort}" />`;
}

/** 看板の assignment.role が指すロール。定義元をここ1箇所に置く。 */
export const ROLES = [
  {
    name: "implement",
    description: "看板のカード1枚を実装する。コードを書く・変更する作業を任せるとき。",
    model: "sonnet",
    effort: "high",
    prompt: [
      "あなたは看板のカード1枚を実装する担当です。",
      "カードの要件に書かれた範囲だけを変更し、範囲外の改善は行いません。",
      "着手前に mcp__kanban__card で担当カードを読み、区切りごとに mcp__kanban__progress で進捗を追記します。",
      "最後に、何をどこまでやったか・残りは何かを1〜2文で報告します。",
    ].join("\n"),
    tools: [
      "Read",
      "Write",
      "Edit",
      "Grep",
      "Glob",
      "Bash",
      "mcp__kanban__card",
      "mcp__kanban__progress",
    ],
  },
  {
    name: "review",
    description: "変更済みのコードを読み、指摘を洗い出す。読み取り専用。",
    model: "sonnet",
    effort: "high",
    prompt: [
      "あなたは一次レビュー担当です。変更を読み、指摘を洗い出します。",
      "コードは変更しません。指摘には根拠となるファイルと行を必ず添えます。",
      "推測で書かず、読んで確かめた事実だけを指摘にします。",
    ].join("\n"),
    tools: ["Read", "Grep", "Glob", "Bash", "mcp__kanban__card"],
  },
  {
    name: "refute",
    description: "一次レビューの指摘に反証を試みる。誤検知を落とすための敵対的検証。",
    model: "opus",
    effort: "xhigh",
    prompt: [
      "あなたは検証担当です。渡された指摘を鵜呑みにせず、成立しない理由を探します。",
      "指摘ごとに CONFIRMED / REFUTED を判定し、判定の根拠をコードから示します。",
      "反証できなかった指摘だけが残ります。",
    ].join("\n"),
    tools: ["Read", "Grep", "Glob", "Bash"],
  },
] as const;

export const TOOL_SPECS = [
  {
    name: "board",
    description:
      "看板の全カードを状態つきで返す。今どのタスクが誰(claude/codex)のどのモデルに割り当たっているかを確認するために使う。",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: STATUSES, description: "絞り込む状態。省略で全件。" },
      },
    },
  },
  {
    name: "card",
    description: "看板のカードを1枚、目的・要件・進捗つきで返す。",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "progress",
    description:
      "カードに進捗を1件追記する。作業の区切りごとに呼ぶ。summary を渡すとカードの到達点も置き換える。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        note: { type: "string", description: "何をどこまでやったか。1〜2文。" },
        summary: { type: "string", description: "カードの到達点を置き換える一文。省略可。" },
      },
      required: ["id", "note"],
    },
  },
  {
    name: "move",
    description: "カードの状態を変える。",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, status: { type: "string", enum: STATUSES } },
      required: ["id", "status"],
    },
  },
  {
    name: "dispatch",
    description:
      "カードを、そのカードが指名する実行者へ投げる。claude なら SubAgent を起動し、codex なら看板アプリに run を登録して実行を任せる。モデルと effort はカードの指名に従い、ここでは選ばない。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        prompt: {
          type: "string",
          description: "実行者に渡す指示。省略するとカードから組み立てる。",
        },
      },
      required: ["id"],
    },
  },
] as const;
