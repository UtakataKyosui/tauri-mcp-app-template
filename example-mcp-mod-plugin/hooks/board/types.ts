/** 共有契約の定義元は Tauri/Rust。Specta の生成物を参照する。 */
export type {
  AccessRule,
  AddProgress,
  Assignment,
  Board,
  Card,
  Correlation,
  CreateCard,
  Effort,
  PatchCard,
  PatchBoard,
  Policy,
  ProgressEntry,
  Runtime,
  Status,
  TurnRecord,
  AgentSpawnRecord,
  AgentState,
  SkillUse,
} from "./generated";

/** 送信できなかった書き込みを $.store に積むときの単位。 */
export type PendingOp = {
  at: number;
  method: "POST" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
};
