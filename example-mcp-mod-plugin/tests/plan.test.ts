import { describe, expect, test } from "claude-code/testing";
import { allows, filterSkillListing, phaseOf, policyFor, revisionPath } from "../hooks/board/plan";
import type { Card } from "../hooks/board/types";

const card = (over: Partial<Card> = {}): Card => ({
  id: "C-1",
  title: "タイトル",
  objective: "目的",
  requirements: [],
  status: "doing",
  assignment: { runtime: "claude", model: "sonnet", effort: "high" },
  summary: "",
  entries: [],
  updatedAt: "2026-09-22T00:00:00.000Z",
  ...over,
});

describe("ポリシーの判定", () => {
  test("ポリシーが無ければ許可する", () => {
    expect(allows(undefined, "skills", "deploy")).toBe(true);
    expect(allows({}, "skills", "deploy")).toBe(true);
  });

  test("deny が allow より優先する", () => {
    const policy = { skills: { allow: ["deploy"], deny: ["deploy"] } };
    expect(allows(policy, "skills", "deploy")).toBe(false);
  });

  test("allow があればそこに無いものを拒否する", () => {
    const policy = { agents: { allow: ["kanban:review"] } };
    expect(allows(policy, "agents", "kanban:review")).toBe(true);
    expect(allows(policy, "agents", "kanban:implement")).toBe(false);
  });

  test("kind が違えば干渉しない", () => {
    const policy = { skills: { deny: ["x"] } };
    expect(allows(policy, "agents", "x")).toBe(true);
  });

  test("phase は status を既定にし、phase があればそちらを使う", () => {
    expect(phaseOf(card())).toBe("doing");
    expect(phaseOf(card({ phase: "spike" }))).toBe("spike");
  });

  test("カードが無ければポリシーは引けない", () => {
    expect(policyFor({ doing: {} }, undefined)).toBeUndefined();
  });
});

describe("Skill 一覧のフィルタ", () => {
  const listing = [
    "The following skills are available for use with the Skill tool:",
    "",
    "- agent-routing: ロールに変換する。",
    "- deploy: 本番へ出す。",
    "- issue-driven-flow:issue-driven-flow:ci-check: CI を回す。",
    "- init",
  ].join("\n");

  test("許可されたものだけが残り、見出しは保たれる", () => {
    const out = filterSkillListing(listing, (name) => name !== "deploy");
    expect(out).toContain("The following skills are available");
    expect(out).toContain("- agent-routing:");
    expect(out).not.toContain("- deploy:");
  });

  test("名前自体がコロンを含んでも、末尾の区切りだけを落として判定する", () => {
    const seen: string[] = [];
    filterSkillListing(listing, (name) => (seen.push(name), true));
    expect(seen).toContain("issue-driven-flow:issue-driven-flow:ci-check");
    expect(seen).toContain("init");
  });

  test("続き行は直前のエントリの判定を引き継ぐ", () => {
    const wrapped = ["- deploy: 本番へ出す。", "  2行目の説明。", "- keep: 残す。"].join("\n");
    const out = filterSkillListing(wrapped, (name) => name !== "deploy");
    expect(out).not.toContain("2行目の説明");
    expect(out).toContain("- keep:");
  });
});

test("revision の sentinel は socket と同じディレクトリに置く", () => {
  expect(revisionPath("/tmp/app/board.sock")).toBe("/tmp/app/board.revision");
});
