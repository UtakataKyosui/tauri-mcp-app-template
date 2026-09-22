import type { EngineInterface, On, PluginOptions, Register } from "claude-code";
import type { Board, Card, PendingOp, Policy } from "./board/types";
import {
  agentStatesOf,
  alreadyCountedByTool,
  countsAsUse,
  emptyBuffer,
  telemetryPath,
  turnRecord,
  type Buffer,
} from "./board/telemetry";
import {
  allows,
  blockedReason,
  cardPath,
  filterSkillListing,
  DEFAULT_SOCKET_SUFFIX,
  focusBlock,
  focusOf,
  op,
  ORIGIN,
  OUTBOX_KEY,
  OUTBOX_LIMIT,
  progressEntry,
  promptFor,
  phaseOf,
  policyFor,
  renderCard,
  revisionPath,
  ROLES,
  RULES,
  TOOL_PREFIX,
  TOOL_SPECS,
} from "./board/plan";

type Engine = EngineInterface;

/**
 * 看板アプリの Unix socket。設定 → 環境変数 → 既定パスの順に決まる。
 * セッションごとに一度だけ解決すればよいが、module reload で捨てられる。
 */
async function resolveSocket($: Engine, options: PluginOptions): Promise<string> {
  const configured = typeof options.socketPath === "string" ? options.socketPath : "";
  if (configured) return configured;
  const fromEnv = await $.env.get("CLAUDE_KANBAN_SOCK");
  if (fromEnv) return fromEnv;
  const home = (await $.env.get("HOME")) ?? "";
  return `${home}${DEFAULT_SOCKET_SUFFIX}`;
}

async function request(
  $: Engine,
  socket: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const res = await $.http.fetch(`${ORIGIN}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    socketPath: socket,
  });
  if (!res.ok) throw new Error(`board ${method} ${path}: ${res.status}`);
  return res.text ? (JSON.parse(res.text) as unknown) : undefined;
}

async function readOutbox($: Engine): Promise<PendingOp[]> {
  const raw = await $.store.get(OUTBOX_KEY);
  return Array.isArray(raw) ? (raw as PendingOp[]) : [];
}

/** 溜まった書き込みを投入順に流す。1件でも失敗したらそこで止め、残りは保持する。 */
async function flush($: Engine, socket: string): Promise<number> {
  const queued = await readOutbox($);
  if (queued.length === 0) return 0;
  let sent = 0;
  for (const pending of queued) {
    try {
      await request($, socket, pending.method, pending.path, pending.body);
      sent += 1;
    } catch {
      break;
    }
  }
  await $.store.set(OUTBOX_KEY, queued.slice(sent));
  return sent;
}

/**
 * 書き込みを1件試し、届かなければ outbox へ積む。看板アプリが落ちている間も
 * セッション側の記録を失わないための緩衝で、次に届いた時点で順に流れる。
 */
async function write($: Engine, socket: string, pending: PendingOp): Promise<boolean> {
  try {
    await flush($, socket);
    await request($, socket, pending.method, pending.path, pending.body);
    return true;
  } catch {
    const queued = await readOutbox($);
    queued.push(pending);
    await $.store.set(OUTBOX_KEY, queued.slice(-OUTBOX_LIMIT));
    return false;
  }
}

async function fetchBoard($: Engine, socket: string): Promise<Board> {
  await flush($, socket);
  return (await request($, socket, "GET", "/board")) as Board;
}

async function fetchCard($: Engine, socket: string, id: string): Promise<Card> {
  await flush($, socket);
  return (await request($, socket, "GET", cardPath(id))) as Card;
}

/**
 * `$.http.fetch` は timeout も signal も取らない。ソケットファイルだけが残って
 * listener が居ないとき呼び出しは返らず、フックの予算も `$` の待ちを打ち切らない。
 * 読み取りはここで期限を切って諦める。
 */
const READ_DEADLINE_MS = 1500;

async function withDeadline<T>(
  $: Engine,
  signal: AbortSignal,
  work: Promise<T>,
): Promise<T> {
  return Promise.race([
    work,
    $.clock.sleep(READ_DEADLINE_MS, { signal }).then((): never => {
      throw new Error("board unreachable");
    }),
  ]);
}

/** 看板が読めないときは両方 undefined。看板の不在でセッションを止めない。 */
async function focusedCard(
  $: Engine,
  socket: string,
  signal: AbortSignal,
): Promise<{ card: Card | undefined; policy: Policy | undefined }> {
  try {
    const board = await withDeadline($, signal, fetchBoard($, socket));
    const card = focusOf(board.cards, board.focus);
    return { card, policy: policyFor(board.policies, card) };
  } catch {
    return { card: undefined, policy: undefined };
  }
}

/**
 * セッション中だけ持つ観測の状態。モジュールの環境はセッションを通じて
 * 生き、ホットリロードで捨てられる。計測の取りこぼしは許容する。
 */
type SessionState = {
  sessionId?: string;
  promptId?: string;
  /**
   * このターンの計測を帰属させるカード。プロンプトの入口で確定させる。
   * turn.complete で引き直さないのは、そこでは next.signal が既に abort して
   * おり、読み取りが即座に失敗して未帰属レコードになるため。
   */
  attributedCardId?: string;
  /** カードが指名した effort。ターンのレコードへ写す。 */
  attributedEffort?: string | number;
  /** そのターンで動いた SubAgent の id。状態の絞り込みに使う。 */
  seenAgents: Set<string>;
  /** main ループと SubAgent を混ぜないよう、ループごとに分けて溜める。 */
  buffers: Map<string, Buffer>;
  focus?: { card: Card | undefined; policy: Policy | undefined; at: number };
};

const MAIN_LOOP = "main";
const FOCUS_TTL_MS = 10_000;

function bufferOf(state: SessionState, agentId: string | undefined): Buffer {
  const key = agentId ?? MAIN_LOOP;
  const found = state.buffers.get(key);
  if (found) return found;
  const fresh = emptyBuffer();
  state.buffers.set(key, fresh);
  return fresh;
}

/**
 * フォーカスは計測フックからも引かれるため、毎回ソケットを往復させない。
 * move / dispatch はキャッシュを捨てて次回引き直させる。
 */
async function focusCached(
  $: Engine,
  socket: string,
  signal: AbortSignal,
  now: number,
  state: SessionState,
): Promise<{ card: Card | undefined; policy: Policy | undefined }> {
  if (state.focus && now - state.focus.at < FOCUS_TTL_MS) return state.focus;
  const found = await focusedCard($, socket, signal);
  state.focus = { ...found, at: now };
  return state.focus;
}

export const register: Register = (on: On, options: PluginOptions) => {
  const state: SessionState = { buffers: new Map(), seenAgents: new Set() };

  on("session.start", async ($, e, next) => {
    for (const spec of TOOL_SPECS) {
      await $.tool.register({
        name: spec.name,
        description: spec.description,
        inputSchema: { ...spec.inputSchema },
      });
    }
    for (const role of ROLES) {
      await $.agent.register({
        name: role.name,
        description: role.description,
        prompt: role.prompt,
        tools: [...role.tools],
        model: role.model,
        effort: role.effort,
        disallowedTools: ["AskUserQuestion"],
      });
    }
    // 前のセッションが届けられなかった書き込みを、起動のたびに流し直す。
    await flush($, await resolveSocket($, options)).catch(() => 0);
    return next(e);
  });

  /**
   * 禁止された Skill をモデルの一覧から消す。一覧は prompt.section ではなく
   * この attachment (`skill_listing`) として届く。SubAgent の一覧は
   * agent.offer が既に絞っているため、ここでは触らない。
   */
  on("prompt.attachment", { type: "skill_listing" }, async ($, e, next) => {
    const result = await next(e);
    if (!result.text) return result;
    const socket = await resolveSocket($, options);
    const { card, policy } = await focusCached($, socket, next.signal, await $.clock.now(), state);
    if (!card || !policy) return result;
    return {
      ...result,
      text: filterSkillListing(result.text, (name) => allows(policy, "skills", name)),
    };
  });

  /** 看板が touch する sentinel を engine のファイル監視に載せる。 */
  on("classic.SessionStart", async ($, e, next) => {
    const result = await next(e);
    const revision = revisionPath(await resolveSocket($, options));
    return { ...result, watchPaths: [...(result.watchPaths ?? []), revision] };
  });

  /**
   * 看板がカードやポリシーを編集したら sentinel を touch する。ポーリング
   * なしでキャッシュを捨てられ、GUI の編集が次のフックから効く。
   */
  on("classic.FileChanged", async ($, e, next) => {
    const revision = revisionPath(await resolveSocket($, options));
    if (e.file_path === revision) {
      state.focus = undefined;
      // 一覧はプロセスごとに保持されるので、ポリシーが変わったら引き直させる。
      $.ui.invalidate("prompt.attachment");
    }
    return next(e);
  });

  on("tool.call", { tool: `${TOOL_PREFIX}board` }, async ($, e) => {
    const socket = await resolveSocket($, options);
    const board = await fetchBoard($, socket);
    const cards = e.status ? board.cards.filter((c) => c.status === e.status) : board.cards;
    return { result: cards.map(renderCard).join("\n\n") || "(カードなし)" };
  });

  on("tool.call", { tool: `${TOOL_PREFIX}card` }, async ($, e) => {
    const socket = await resolveSocket($, options);
    return { result: renderCard(await fetchCard($, socket, e.id)) };
  });

  on("tool.call", { tool: `${TOOL_PREFIX}progress` }, async ($, e) => {
    const socket = await resolveSocket($, options);
    const { id, note, summary } = e;
    const now = await $.clock.now();
    const at = new Date(now).toISOString();
    const delivered = await write(
      $,
      socket,
      op(now, "POST", `${cardPath(id)}/progress`, {
        entry: progressEntry(at, note),
        summary,
      }),
    );
    return {
      result: delivered ? `記録しました (${id})` : `看板アプリが応答しないため保留しました (${id})`,
    };
  });

  on("tool.call", { tool: `${TOOL_PREFIX}move` }, async ($, e) => {
    const socket = await resolveSocket($, options);
    const { id, status } = e;
    const delivered = await write($, socket, op(await $.clock.now(), "PATCH", cardPath(id), { status }));
    state.focus = undefined;
    return { result: delivered ? `${id} を ${status} へ移しました` : `保留しました (${id})` };
  });

  on("tool.call", { tool: `${TOOL_PREFIX}dispatch` }, async ($, e) => {
    const socket = await resolveSocket($, options);
    const { id, prompt } = e;
    const card = await fetchCard($, socket, id);
    const { runtime, model, effort, role } = card.assignment;
    const text = prompt ?? promptFor(card);

    if (runtime === "codex") {
      const codex = typeof options.codexCommand === "string" ? options.codexCommand : "codex";
      const delivered = await write(
        $,
        socket,
        op(await $.clock.now(), "POST", `${cardPath(id)}/runs`, {
          runtime: "codex",
          command: codex,
          model,
          effort,
          prompt: text,
        }),
      );
      return {
        result: delivered
          ? `${id} を codex (${codex} --model ${model}, effort ${effort}) の run として看板へ登録しました。完了は看板が書き戻します。`
          : `看板アプリが応答しないため run を保留しました (${id})。`,
      };
    }

    const { agentId, deny } = await $.agent.spawn({
      subagentType: role ? `kanban:${role}` : "general-purpose",
      prompt: text,
      description: card.title,
      model,
    });
    if (deny) return { result: `起動を拒否されました: ${deny}` };
    await write($, socket, op(await $.clock.now(), "PATCH", cardPath(id), { status: "doing" }));
    state.focus = undefined;
    return { result: `${id} を ${role ?? "general-purpose"} (${model}) で起動しました: ${agentId}` };
  });

  /**
   * モデルが自分で kanban: のロールを呼んだとき、カードの指名を当てる。
   * dispatch 経由の起動は model を明示済みでここを素通りする。Explore や Plan
   * など看板と無関係な SubAgent まで巻き込まないよう、対象を限定する。
   */
  on("agent.spawn", async ($, e, next) => {
    const socket = await resolveSocket($, options);
    const now = await $.clock.now();
    bufferOf(state, e.parentAgentId).agents.push({
      toolUseId: e.tool_use_id,
      subagentType: e.subagentType,
      model: e.model,
      background: e.background,
      at: now,
    });
    if (e.model || !e.subagentType.startsWith("kanban:")) return next(e);
    const { card: focus } = await focusCached($, socket, next.signal, now, state);
    if (!focus || focus.assignment.runtime !== "claude") return next(e);
    return next({ ...e, model: focus.assignment.model });
  });

  /**
   * Phase で許可されていない SubAgent を、モデルの一覧から消し dispatch も
   * 拒否する。看板が読めないときは何も絞らない。遮断側に倒すと、看板の
   * 不在だけで全 SubAgent が消え、原因に気づけない。
   */
  on("agent.offer", async ($, e, next) => {
    const socket = await resolveSocket($, options);
    const { card, policy } = await focusCached(
      $,
      socket,
      next.signal,
      await $.clock.now(),
      state,
    );
    if (!card || !policy) return next(e);
    if (allows(policy, "agents", e.agent)) return next(e);
    return { isOffered: false };
  });

  /**
   * ここは会話の最初のメッセージに乗る。書き換えると以降の全リクエストの
   * 接頭辞が変わり、プロンプトキャッシュが全損する。だから不変のルールだけを
   * 置き、毎ターン変わるカードの状態は prompt.submit の注記が運ぶ。
   */
  on("prompt.context", async ($, e, next) => {
    const result = await next(e);
    return { ...result, blocks: [...result.blocks, { name: "kanbanRules", text: RULES }] };
  });

  on("prompt.submit", async ($, e, next) => {
    if (options.structurePrompts === false) return next(e);
    if (e.text.startsWith("/") || e.text.startsWith("#")) return next(e);
    const socket = await resolveSocket($, options);
    const { card: focus } = await focusCached($, socket, next.signal, await $.clock.now(), state);
    if (!focus) return next(e);
    const pending = (await readOutbox($).catch(() => [])).length;
    return next({ ...e, text: `${focusBlock(focus, pending)}\n\n${e.text}` });
  });
  /**
   * OTel のイベントが持つ `prompt.id` と同じ値をここで拾う。metric 側には
   * この属性が付かないため、カード単位の突き合わせはイベント側でしかできない。
   */
  on("classic.UserPromptSubmit", async ($, e, next) => {
    state.sessionId = e.session_id;
    state.promptId = e.prompt_id;
    const socket = await resolveSocket($, options);
    const now = await $.clock.now();
    const { card: focus } = await focusCached($, socket, next.signal, now, state);
    state.attributedCardId = focus?.id;
    state.attributedEffort = focus?.assignment.effort;
    await write(
      $,
      socket,
      op(now, "POST", "/correlations", {
        cardId: focus?.id,
        sessionId: e.session_id,
        promptId: e.prompt_id,
        at: now,
      }),
    );
    return next(e);
  });

  // 計測はターン境界でまとめて送る。ここでは溜めるだけにする。
  on("tool.call", async ($, e, next) => {
    if (countsAsUse(e.tool)) {
      bufferOf(state, e.agentId).tools.push({ tool: e.tool, at: await $.clock.now() });
    }
    return next(e);
  });

  /**
   * Skill ツール経由なら、どのループが呼んだかが分かる。遮断と計測を1つの
   * フックで行う。同じイベントに2本登録すると、ネスト順で計測側が外側に
   * 来たとき、next を呼ばない内側の答えを受け取ることになる。
   */
  on("tool.call", { tool: "Skill" }, async ($, e, next) => {
    const socket = await resolveSocket($, options);
    const now = await $.clock.now();
    const { card, policy } = await focusCached($, socket, next.signal, now, state);
    const blocked = card && policy && !allows(policy, "skills", e.skill);
    bufferOf(state, e.agentId).skills.push({
      skill: e.skill,
      at: now,
      via: blocked ? "blocked" : "tool",
    });
    if (blocked) return { deny: blockedReason("Skill", e.skill, phaseOf(card)) };
    return next(e);
  });

  /**
   * 展開そのものを止める層。ツールの deny だけでは、スラッシュコマンドや
   * プリロードの経路で中身がコンテキストへ入る。
   *
   * スラッシュ・プリロードの使用もここで拾う。ループが分からないため main に
   * 寄る。Skill ツール経由で既に数えた分は飛ばす。
   */
  on("skill.prompt", async ($, e, next) => {
    const socket = await resolveSocket($, options);
    const now = await $.clock.now();
    const { card, policy } = await focusCached($, socket, next.signal, now, state);
    const blocked = card && policy && !allows(policy, "skills", e.skill);

    if (blocked || !alreadyCountedByTool(state.buffers.values(), e.skill)) {
      bufferOf(state, undefined).skills.push({
        skill: e.skill,
        at: now,
        via: blocked ? "blocked" : "expansion",
      });
    }
    if (blocked) return { text: blockedReason("Skill", e.skill, phaseOf(card)) };
    return next(e);
  });

  /**
   * ターンの終わりに、そのループで溜めた観測をカードへ帰属させて送る。
   * SubAgent のターンもここへ来るため、ループごとに分けて記録する。
   */
  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    const socket = await resolveSocket($, options);
    const now = await $.clock.now();
    const cardId = state.attributedCardId;

    const key = e.agentId ?? MAIN_LOOP;
    const buffer = bufferOf(state, e.agentId);
    state.buffers.delete(key);

    if (e.agentId) state.seenAgents.add(e.agentId);
    // signal を取らない呼び出し。ここで withDeadline に包むと、abort 済みの
    // signal で即座に失敗する。
    const infos = await $.agent.list().catch(() => []);
    const agentStates = agentStatesOf(infos, state.seenAgents);

    await write(
      $,
      socket,
      op(
        now,
        "POST",
        telemetryPath(cardId),
        turnRecord(
          {
            turnId: e.turnId,
            answer: e.answer,
            agentId: e.agentId,
            reason: e.reason,
            durationMs: e.durationMs,
            usage: e.usage,
          },
          buffer,
          {
            cardId,
            sessionId: state.sessionId,
            promptId: state.promptId,
            effort: state.attributedEffort,
          },
          agentStates,
          now,
        ),
      ),
    );
    return result;
  });

  // セッションが終わる前に、届いていない書き込みを流し切る。
  on("session.end", async ($, e, next) => {
    await flush($, await resolveSocket($, options)).catch(() => 0);
    return next(e);
  });
};
