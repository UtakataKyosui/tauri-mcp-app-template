import { expect, mock, test } from "claude-code/testing";
import type { On } from "claude-code";

/** プラグインは env と store を読む。テスト環境では明示的に生やす。 */
function base(on: On): void {
  mock.env(on, { HOME: "/tmp/kanban-test" });
  mock.store(on);
  mock.clock(on);
}

/**
 * 型宣言が engine の実際の受け渡しと一致するかを確かめる。これらは型定義を
 * 読んで手で書いたもので、tsc は宣言を信じるだけなので検証にならない。
 */

test("MCP ツールの引数は e 直下に来る", async ($, on) => {
  let seen: unknown;
  on("tool.call", { tool: "mcp__kanban__card" }, ($$, e) => {
    seen = (e as { id?: string }).id;
    return { result: "ok" };
  });
  await $.tool.call({ tool: "mcp__kanban__card", id: "C-1" }).catch(() => undefined);
  expect(seen).toBe("C-1");
});

test("Skill ツールの入力は e.skill を持つ", async ($, on) => {
  let seen: unknown;
  on("tool.call", { tool: "Skill" }, ($$, e) => {
    seen = e.skill;
    return { result: "ok" };
  });
  await $.tool.call({ tool: "Skill", skill: "commit" }).catch(() => undefined);
  expect(seen).toBe("commit");
});

test("agent.offer は e.agent で型名を渡す", async ($, on) => {
  let seen: unknown;
  on("agent.offer", ($$, e) => {
    seen = e.agent;
    return { isOffered: false };
  });
  await $.agent.offer({ agent: "Explore", description: "", source: "test", provider: { plugin: "engine", tier: "core" } }).catch(() => undefined);
  expect(seen).toBe("Explore");
});

test("看板が読めないとき agent.offer は何も絞らない", async ($, on) => {
  base(on);
  on("agent.offer", () => ({ isOffered: true }));
  const result = await $.agent.offer({ agent: "Explore", description: "探索", source: "test", provider: { plugin: "engine", tier: "core" } });
  expect(result.isOffered).toBe(true);
});

test("看板が読めないとき Skill ツールは拒否されない", async ($, on) => {
  base(on);
  let reached = false;
  on("tool.call", { tool: "Skill" }, () => {
    reached = true;
    return { result: "ok" };
  });
  await $.tool.call({ tool: "Skill", skill: "commit" }).catch(() => undefined);
  expect(reached).toBe(true);
});

/*
 * classic.* のイベントはここでは検証できない。テストハーネスは engine 自身の
 * ステップを持たないため、prompt.submit を誰かが next なしで答えた時点で
 * classic.UserPromptSubmit まで降りない。
 *
 * 代わりに実セッションで確認した（2026-09-22, Claude Code 2.1.278）。
 * 使い捨ての観測プラグインを --plugin-dir で読ませ、$.fs.write で結果を出す:
 *
 *   classic.SessionStart  keys=session_id,transcript_path,cwd,scratchpad_dir,
 *                              prompt_id,permission_mode,agent_id,agent_type,
 *                              effort,hook_event_name,source,model,session_title
 *   classic.UserPromptSubmit  session_id=string prompt_id=string
 *                              (例: db44a872-e646-41f1-97bc-7356949148da)
 *   classic.FileChanged  watchPaths に載せたパスの変更で発火する
 *                              (path と event='change' を受け取る)
 */
