/**
 * 観測の蓄積。engine interface を持ち込まず、フックが呼ぶ純関数として置く。
 *
 * 計測はターン境界でまとめて送る。tool.call ごとにソケットへ往復すると、
 * 全ツール呼び出しにレイテンシが乗る。
 */
import type { AgentSpawnRecord, AgentState, SkillUse, TurnRecord } from "./types";

export type Buffer = {
  tools: { tool: string; at: number }[];
  skills: SkillUse[];
  agents: AgentSpawnRecord[];
};

/** SubAgent の最終回答をそのまま積むとカードが嵩む。長さは別に残す。 */
export const ANSWER_HEAD = 1000;

export function headOf(text: string): { answer: string; answerLength: number } {
  return { answer: text.slice(0, ANSWER_HEAD), answerLength: text.length };
}

/**
 * `skill.prompt` は Skill ツール経由・スラッシュ・プリロードの全部で発火する。
 * ツール経由で既に数えた分を二重に数えないための判定。順序の仮定は置かず、
 * `via` をレコードに残して看板側で判別できるようにしてある。
 */
export function alreadyCountedByTool(buffers: Iterable<Buffer>, skill: string): boolean {
  for (const buffer of buffers) {
    if (buffer.skills.some((s) => s.skill === skill && s.via === "tool")) return true;
  }
  return false;
}

export function emptyBuffer(): Buffer {
  return { tools: [], skills: [], agents: [] };
}

/** 自分のツールは数えない。progress を書くたびに使用回数が増えてしまう。 */
export function countsAsUse(tool: string): boolean {
  return !tool.startsWith("mcp__kanban__");
}

export function telemetryPath(cardId: string | undefined): string {
  return cardId ? `/cards/${encodeURIComponent(cardId)}/telemetry` : "/telemetry";
}

export function agentStatesOf(
  infos: readonly AgentState[],
  seen: ReadonlySet<string>,
): AgentState[] {
  return infos.filter((info) => seen.has(info.id));
}

export type TurnFacts = {
  turnId: string;
  answer: string;
  agentId?: string;
  reason: string;
  durationMs: number;
  usage?: {
    model: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
};

export function turnRecord(
  facts: TurnFacts,
  buffer: Buffer,
  meta: {
    cardId?: string;
    sessionId?: string;
    promptId?: string;
    effort?: string | number;
  },
  agentStates: AgentState[],
  at: number,
): TurnRecord {
  const head = facts.agentId ? headOf(facts.answer) : undefined;
  return {
    cardId: meta.cardId,
    sessionId: meta.sessionId,
    promptId: meta.promptId,
    turnId: facts.turnId,
    agentId: facts.agentId,
    reason: facts.reason,
    durationMs: facts.durationMs,
    model: facts.usage?.model,
    effort: meta.effort,
    tokens: facts.usage && {
      input: facts.usage.input_tokens,
      output: facts.usage.output_tokens,
      cacheRead: facts.usage.cache_read_input_tokens,
      cacheCreation: facts.usage.cache_creation_input_tokens,
    },
    answer: head?.answer,
    answerLength: head?.answerLength,
    tools: buffer.tools,
    skills: buffer.skills,
    agents: buffer.agents,
    agentStates,
    at,
  };
}
