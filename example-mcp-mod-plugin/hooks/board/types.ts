/** 看板が持つデータの形。Tauri 側の Rust 構造体と一対一で対応する。 */

export type Runtime = "claude" | "codex";

export type Status = "backlog" | "ready" | "doing" | "review" | "done" | "blocked";

/** カードが指名する実行者。看板がここを持つことで、振り分けの決定権が GUI 側に残る。 */
export type Assignment = {
  runtime: Runtime;
  /** claude なら alias か id、codex なら model id。 */
  model: string;
  /** low / medium / high / xhigh / max、または整数の budget。 */
  effort: string | number;
  /** claude のとき、使う SubAgent ロール名。Mod が同名で agent.register する。 */
  role?: string;
};

export type ProgressEntry = {
  at: string;
  by: string;
  note: string;
};

/**
 * ある Phase で使ってよい Skill / SubAgent。deny が優先し、allow があれば
 * そこに無いものは拒否する。Phase にポリシーが無ければ全て許可する。
 */
export type Policy = {
  skills?: { allow?: string[]; deny?: string[] };
  agents?: { allow?: string[]; deny?: string[] };
};

export type Card = {
  id: string;
  title: string;
  objective: string;
  requirements: string[];
  status: Status;
  /** ポリシーを引くキー。省略すると status を Phase として使う。 */
  phase?: string;
  assignment: Assignment;
  /** 直近の到達点を一文で。プロンプトへ差し込むのはこれで、entries は差し込まない。 */
  summary: string;
  entries: ProgressEntry[];
  updatedAt: string;
};

export type Board = {
  cards: Card[];
  /** 現在 doing のカード id。セッションが今どれを進めているか。 */
  focus?: string;
  /** Phase 名をキーにしたポリシー。GUI が編集する。 */
  policies?: Record<string, Policy>;
};

/** 送信できなかった書き込みを $.store に積むときの単位。 */
export type PendingOp = {
  at: number;
  method: "POST" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
};

/** 1ターンの観測結果。カードへ帰属させた状態で看板へ送る。 */
export type TurnRecord = {
  /** 送信時点のフォーカスカード。無いときは未帰属として記録する。 */
  cardId?: string;
  sessionId?: string;
  /** OTel のイベント属性 `prompt.id` と同じ値。突き合わせの鍵。 */
  promptId?: string;
  turnId: string;
  /** SubAgent のターンならその id。main ループでは付かない。 */
  agentId?: string;
  reason: string;
  durationMs: number;
  model?: string;
  /**
   * カードが指名した effort を写したもの。実際に適用された値は turn.step が
   * 持つが、読むには全モデルリクエストのストリームを自分のジェネレータに
   * 通す必要があるため観測しない。
   */
  effort?: string | number;
  tokens?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
  };
  /** SubAgent のターンのとき、その最終回答。先頭だけを残す。 */
  answer?: string;
  answerLength?: number;
  tools: { tool: string; at: number }[];
  skills: SkillUse[];
  agents: AgentSpawnRecord[];
  /** そのターンで動いた SubAgent の、ターン終了時点の状態。 */
  agentStates: AgentState[];
  at: number;
};

/**
 * spawn の時点では agentId がまだ無い。突き合わせは tool_use_id で行う。
 * 実際に動いた結果は agentStates と、その SubAgent 自身の TurnRecord が持つ。
 */
export type AgentSpawnRecord = {
  toolUseId: string;
  subagentType: string;
  model?: string;
  background: boolean;
  at: number;
};

export type SkillUse = {
  skill: string;
  at: number;
  /**
   * `tool` は Skill ツール経由でループが分かるもの、`expansion` は
   * スラッシュコマンドやプリロードで、ループが分からず main に寄る。
   * `blocked` は Phase のポリシーで遮断したもの。
   */
  via: "tool" | "expansion" | "blocked";
};

export type AgentState = {
  id: string;
  type: string;
  status: string;
  description: string;
  parentId?: string;
  /** この Mod が spawn したのか、モデルが自分で呼んだのかの区別。 */
  spawnedBy?: string;
  name?: string;
};

/**
 * カードとセッション・プロンプトの対応。OTel が吐くイベント側には
 * カードの概念が無いため、これを保存しておかないと突き合わせられない。
 */
export type Correlation = {
  cardId?: string;
  sessionId: string;
  promptId?: string;
  at: number;
};
