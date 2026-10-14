import { useCallback, useSyncExternalStore } from "react";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import type { AgentSnapshot } from "./agents";
import { estimateTokens } from "./format";

type Paseo = PluginClientContext["paseo"];
type AgentHandle = ReturnType<Paseo["agents"]["ref"]>;
type TimelineEvent = Parameters<Parameters<AgentHandle["timeline"]["subscribe"]>[0]>[0];
export type Usage = NonNullable<AgentSnapshot["lastUsage"]>;

export type Stats = {
  provider: string | null;
  model: string | null;
  cwd: string | null;
  // 一轮正在进行：进行中显示实时速度，结束后显示本轮均速
  running: boolean;
  // 本轮到目前为止的实时速度（估算）
  tps: number | null;
  // 上一轮的平均速度：只计生成时间，不含首字等待和工具执行
  turnTps: number | null;
  // turnTps 是否用 provider 上报的精确 output 算出；否则为字符估算
  turnTpsPrecise: boolean;
  // 上一轮收到了输出，但 provider 没有逐字流式输出（整段一次到达），生成时间太短无法测速
  speedUnmeasurable: boolean;
  // 最近一步的首字时间（ms）：步起点到首个 assistant/reasoning 片段
  ttft: number | null;
  // 最近一次带 token 数的 usage。Claude 轮次中途的上报只有上下文两个字段，不覆盖这里
  usage: Usage | null;
  contextUsed: number | null;
  contextMax: number | null;
  cost: number | null;
  // 已排队、等本轮结束后发送的快捷按钮
  queued: string | null;
};

const EMPTY: Stats = {
  provider: null,
  model: null,
  cwd: null,
  running: false,
  tps: null,
  turnTps: null,
  turnTpsPrecise: false,
  speedUnmeasurable: false,
  ttft: null,
  usage: null,
  contextUsed: null,
  contextMax: null,
  cost: null,
  queued: null,
};

const REFRESH_MS = 500;
// 首个片段后太短的窗口算出的速度不稳定，不显示
const MIN_WINDOW_MS = 300;
const TIMELINE_RETRY_MS = 3_000;
// 轮次结束后等这么久内到达的 usage 仍用来重算本轮均速（pi/omp 在轮次结束后才读最终统计）
const LATE_USAGE_MS = 15_000;

// 本轮累计，不对外发布
type Turn = {
  // 从轮次开始就在接收 timeline；中途接入的轮次不用精确 output 算均速
  sawStart: boolean;
  // 本轮开始时的累计 output，pi/omp 上报会话累计值，用差值算本轮
  outputAtStart: number | undefined;
  // 本轮首个片段的时间和片段数
  firstAt: number | undefined;
  deltas: number;
  // 本轮已经算出过首字时间
  ttftSet: boolean;
  // 当前步：步起点（轮次开始或上一个工具结束）、首个片段、最后一个片段、估算 token
  stepStartAt: number | undefined;
  stepFirstAt: number | undefined;
  stepLastAt: number;
  stepEstimated: number;
  // 已结束步骤的生成耗时和估算 token
  ms: number;
  estimated: number;
  shownAt: number;
};

function newTurn(): Turn {
  return {
    sawStart: false,
    outputAtStart: undefined,
    firstAt: undefined,
    deltas: 0,
    ttftSet: false,
    stepStartAt: undefined,
    stepFirstAt: undefined,
    stepLastAt: 0,
    stepEstimated: 0,
    ms: 0,
    estimated: 0,
    shownAt: 0,
  };
}

type Entry = {
  stats: Stats;
  status: AgentSnapshot["status"] | null;
  // 最近一次见到的轮次 id，用来识别新一轮开始
  turnId: string | null;
  // 刚结束的一轮，等迟到的 usage 重算均速
  lastTurn: { turn: Turn; until: number } | null;
  listeners: Set<() => void>;
  // 当前挂载的 pill 数；只有输入框在屏幕上时才订阅 timeline
  watchers: number;
  stopTimeline: (() => void) | null;
  retry: ReturnType<typeof setTimeout> | null;
  turn: Turn;
  queued: { label: string; text: string } | null;
};

function hasTokens(usage: Usage | undefined): usage is Usage {
  return (
    usage !== undefined &&
    (usage.inputTokens !== undefined || usage.cachedInputTokens !== undefined || usage.outputTokens !== undefined)
  );
}

// 能拿到本轮精确 output 的 provider：claude、antigravity 上报整轮汇总，pi、omp 上报会话累计取差值。
// codex 只有最近一次请求，其他 provider 口径未知，都退回字符估算
function hasPreciseOutput(provider: string | null): boolean {
  return provider === "claude" || provider === "antigravity" || provider === "pi" || provider === "omp";
}

function preciseOutput(provider: string | null, usage: Usage | null, turn: Turn): number | null {
  const output = usage?.outputTokens;
  if (!turn.sawStart || typeof output !== "number") return null;
  switch (provider) {
    case "claude":
    case "antigravity":
      return output;
    case "pi":
    case "omp":
      return turn.outputAtStart === undefined ? null : output - turn.outputAtStart;
    default:
      return null;
  }
}

// 本轮均速：生成时间太短时清空，不沿用上一轮的值；有精确 output 用精确值，否则用估算
function turnSpeed(turn: Turn, provider: string | null, usage: Usage | null): Partial<Stats> {
  if (turn.ms < MIN_WINDOW_MS) {
    return { turnTps: null, turnTpsPrecise: false, speedUnmeasurable: turn.deltas > 0 };
  }
  const precise = preciseOutput(provider, usage, turn);
  if (precise !== null && precise > 0) {
    return { turnTps: precise / (turn.ms / 1000), turnTpsPrecise: true, speedUnmeasurable: false };
  }
  if (turn.estimated > 0) {
    return { turnTps: turn.estimated / (turn.ms / 1000), turnTpsPrecise: false, speedUnmeasurable: false };
  }
  return { turnTps: null, turnTpsPrecise: false, speedUnmeasurable: false };
}

export type StatsStore = ReturnType<typeof createStatsStore>;

/**
 * 每个 agent 一份统计。agent 快照（状态、轮次、usage）来自 observation，所有 agent 都有；
 * 流式计时来自 `agents.ref(id).timeline.subscribe()`，只在该 agent 的 pill 挂载时订阅。
 *
 * 用户发起的轮次，daemon 不把 turn_started 转发给客户端，轮次开始改由快照里 activeTurn 的变化识别。
 * 时间统一用 daemon 时钟：activeTurn.startedAt 和每个流事件的 timestamp，时间差不受客户端时钟和转发延迟影响。
 */
export function createStatsStore(paseo: Paseo) {
  const entries = new Map<string, Entry>();

  function ensure(agentId: string): Entry {
    let entry = entries.get(agentId);
    if (!entry) {
      entry = {
        stats: EMPTY,
        status: null,
        turnId: null,
        lastTurn: null,
        listeners: new Set(),
        watchers: 0,
        stopTimeline: null,
        retry: null,
        turn: newTurn(),
        queued: null,
      };
      entries.set(agentId, entry);
    }
    return entry;
  }

  function publish(entry: Entry, patch: Partial<Stats>) {
    entry.stats = { ...entry.stats, ...patch };
    entry.listeners.forEach((listener) => listener());
  }

  function usagePatch(usage: Usage | undefined): Partial<Stats> {
    if (!usage) return {};
    const patch: Partial<Stats> = {};
    if (hasTokens(usage)) patch.usage = usage;
    if (usage.contextWindowUsedTokens !== undefined) patch.contextUsed = usage.contextWindowUsedTokens;
    if (usage.contextWindowMaxTokens !== undefined) patch.contextMax = usage.contextWindowMaxTokens;
    if (usage.totalCostUsd !== undefined) patch.cost = usage.totalCostUsd;
    return patch;
  }

  // ---- 快照 ----

  function applySnapshot(agent: AgentSnapshot) {
    const entry = ensure(agent.id);
    const patch: Partial<Stats> = {
      provider: agent.provider,
      model: agent.model,
      cwd: agent.cwd,
      running: agent.status === "running",
    };

    const active = agent.activeTurn;
    if (active && active.turnId !== entry.turnId) {
      entry.turnId = active.turnId;
      const startedAt = active.startedAt ? Date.parse(active.startedAt) : NaN;
      Object.assign(patch, startTurn(entry, Number.isFinite(startedAt) ? startedAt : undefined));
    }

    // usage 在轮次开始判断之后合并，startTurn 取到的是上一轮结束时的累计 output
    const usage = usagePatch(agent.lastUsage);
    Object.assign(patch, usage);
    if (usage.usage) Object.assign(patch, lateTurnSpeed(entry, agent.provider, usage.usage));

    entry.status = agent.status;
    publish(entry, patch);
    flushQueued(agent.id, entry);
  }

  function remove(agentId: string) {
    const entry = entries.get(agentId);
    if (!entry) return;
    stopTimeline(entry);
    entries.delete(agentId);
  }

  // 快照替换整个集合：不再列出的 agent 去掉统计，正在显示的 pill 保留
  function retain(agentIds: Set<string>) {
    [...entries.keys()].forEach((agentId) => {
      const entry = entries.get(agentId);
      if (!agentIds.has(agentId) && entry && entry.watchers === 0) remove(agentId);
    });
  }

  // ---- 轮次 ----

  /**
   * 新一轮开始。at 为 daemon 记录的开始时间。快照和 timeline 走不同的订阅，
   * 片段可能先于快照到达：这时保留已累计的数据，只补算首字时间
   */
  function startTurn(entry: Entry, at: number | undefined): Partial<Stats> {
    entry.lastTurn = null;
    const watching = entry.stopTimeline !== null;
    const outputAtStart = entry.stats.usage?.outputTokens;
    const turn = entry.turn;
    if (turn.firstAt !== undefined) {
      turn.sawStart = watching;
      turn.outputAtStart = outputAtStart;
      if (at !== undefined && !turn.ttftSet && turn.firstAt >= at) {
        turn.ttftSet = true;
        return { ttft: turn.firstAt - at };
      }
      return {};
    }
    entry.turn = { ...newTurn(), sawStart: watching, outputAtStart, stepStartAt: at };
    return { running: true, tps: null, ttft: null };
  }

  // 刚结束的一轮在等待期内收到新 usage：重算本轮均速，只从估算升级为精确值
  function lateTurnSpeed(entry: Entry, provider: string, usage: Usage): Partial<Stats> {
    const last = entry.lastTurn;
    if (!last || Date.now() > last.until) return {};
    const speed = turnSpeed(last.turn, provider, usage);
    if (!speed.turnTpsPrecise) return {};
    entry.lastTurn = null;
    return speed;
  }

  // ---- timeline 订阅 ----

  function watch(agentId: string): () => void {
    const entry = ensure(agentId);
    entry.watchers += 1;
    if (entry.watchers === 1) startTimeline(agentId, entry);
    return () => {
      entry.watchers -= 1;
      if (entry.watchers === 0) stopTimeline(entry);
    };
  }

  function startTimeline(agentId: string, entry: Entry) {
    if (entry.stopTimeline || entry.watchers === 0) return;
    // 没订阅期间的片段都丢了，累计值作废；中途接入的轮次 sawStart 为 false
    entry.turn = newTurn();
    try {
      const subscription = paseo.agents.ref(agentId).timeline.subscribe((event) => handleEvent(agentId, entry, event));
      entry.stopTimeline = () => {
        void subscription.release().catch(() => undefined);
      };
      subscription.ready.catch((error: unknown) => retryTimeline(agentId, entry, error));
    } catch (error) {
      retryTimeline(agentId, entry, error);
    }
  }

  function stopTimeline(entry: Entry) {
    if (entry.retry !== null) clearTimeout(entry.retry);
    entry.retry = null;
    entry.stopTimeline?.();
    entry.stopTimeline = null;
  }

  // 订阅出错时 Paseo 会释放它；pill 还在显示就过一会儿重开。中断期间的事件丢失，本轮计时可能不完整
  function retryTimeline(agentId: string, entry: Entry, error: unknown) {
    console.warn("session-stats: timeline subscription failed; retrying", error);
    stopTimeline(entry);
    if (entry.watchers === 0) return;
    entry.retry = setTimeout(() => {
      entry.retry = null;
      startTimeline(agentId, entry);
    }, TIMELINE_RETRY_MS);
  }

  function handleEvent(agentId: string, entry: Entry, message: TimelineEvent) {
    try {
      const event = message.event;
      if (event.type === "error") {
        retryTimeline(agentId, entry, event.error);
        return;
      }
      const parsed = "timestamp" in message && typeof message.timestamp === "string" ? Date.parse(message.timestamp) : NaN;
      const at = Number.isFinite(parsed) ? parsed : Date.now();
      switch (event.type) {
        // 只有 agent 自发的轮次会转发 turn_started；与快照识别到的是同一轮时跳过
        case "turn_started":
          if (event.turnId !== undefined && event.turnId === entry.turnId) break;
          if (event.turnId !== undefined) entry.turnId = event.turnId;
          publish(entry, startTurn(entry, at));
          break;
        case "timeline": {
          const item = event.item;
          if (item.type === "assistant_message" || item.type === "reasoning") onDelta(entry, at, item.text);
          else if (item.type === "tool_call") onTool(entry, at, item.status);
          break;
        }
        case "turn_completed":
          endTurn(entry, event.usage);
          break;
        case "turn_failed":
        case "turn_canceled":
          endTurn(entry, undefined);
          break;
      }
    } catch (error) {
      // timeline 事件结构变化时只丢掉这一条，不影响 pill 和其他统计
      console.warn("session-stats: could not handle timeline event", error);
    }
  }

  function onDelta(entry: Entry, at: number, text: string) {
    if (!text) return;
    const turn = entry.turn;
    const patch: Partial<Stats> = {};
    if (!entry.stats.running) patch.running = true;
    turn.deltas += 1;
    if (turn.firstAt === undefined) turn.firstAt = at;
    if (turn.stepFirstAt === undefined) {
      turn.stepFirstAt = at;
      if (turn.stepStartAt !== undefined && at >= turn.stepStartAt) {
        patch.ttft = at - turn.stepStartAt;
        turn.ttftSet = true;
      }
      turn.stepStartAt = undefined;
    }
    turn.stepLastAt = at;
    turn.stepEstimated += estimateTokens(text);

    // 实时值 =（已结束步骤 + 当前步）估算 token / 累计生成耗时
    const ms = turn.ms + (at - turn.stepFirstAt);
    const now = Date.now();
    if (ms >= MIN_WINDOW_MS && now - turn.shownAt >= REFRESH_MS) {
      turn.shownAt = now;
      patch.tps = (turn.estimated + turn.stepEstimated) / (ms / 1000);
    }
    if (Object.keys(patch).length > 0) publish(entry, patch);
  }

  // 结束当前步。extendTo：精确 output 含工具参数 token，这段生成没有文字片段，把窗口延到工具条目到达
  function closeStep(turn: Turn, extendTo?: number) {
    if (turn.stepFirstAt !== undefined) {
      const last = extendTo !== undefined ? Math.max(turn.stepLastAt, extendTo) : turn.stepLastAt;
      turn.ms += last - turn.stepFirstAt;
      turn.estimated += turn.stepEstimated;
    }
    turn.stepFirstAt = undefined;
    turn.stepLastAt = 0;
    turn.stepEstimated = 0;
  }

  function onTool(entry: Entry, at: number, status: string) {
    const turn = entry.turn;
    closeStep(turn, hasPreciseOutput(entry.stats.provider) ? at : undefined);
    // 工具结束后模型开始下一次请求，作为下一步首字时间的起点；并行工具以最后一个结束的为准
    if (status !== "running") turn.stepStartAt = at;
  }

  function endTurn(entry: Entry, usage: Usage | undefined) {
    const turn = entry.turn;
    closeStep(turn);
    const latest = hasTokens(usage) ? usage : entry.stats.usage;
    const patch: Partial<Stats> = {
      running: false,
      ...usagePatch(usage),
      ...turnSpeed(turn, entry.stats.provider, latest),
    };
    // 还没拿到精确值的，留着等迟到的 usage
    entry.lastTurn = patch.turnTpsPrecise ? null : { turn, until: Date.now() + LATE_USAGE_MS };
    entry.turn = newTurn();
    publish(entry, patch);
  }

  // ---- 快捷按钮 ----

  function send(agentId: string, text: string): Promise<void> {
    return paseo.agents.ref(agentId).send(text);
  }

  /**
   * 空闲时直接发送；进行中排队，等这一轮结束（状态变为 idle 或 error）再发。
   * send() 在轮次进行中默认会中断当前轮，所以不能直接发。再按别的按钮替换排队项
   */
  async function submit(agentId: string, label: string, text: string): Promise<"sent" | "queued"> {
    const entry = ensure(agentId);
    if (entry.status === "running" || entry.status === "initializing") {
      entry.queued = { label, text };
      publish(entry, { queued: label });
      return "queued";
    }
    await send(agentId, text);
    return "sent";
  }

  function cancelQueued(agentId: string) {
    const entry = entries.get(agentId);
    if (!entry?.queued) return;
    entry.queued = null;
    publish(entry, { queued: null });
  }

  function flushQueued(agentId: string, entry: Entry) {
    if (!entry.queued) return;
    if (entry.status === "closed") {
      cancelQueued(agentId);
      return;
    }
    if (entry.status !== "idle" && entry.status !== "error") return;
    const { label, text } = entry.queued;
    entry.queued = null;
    publish(entry, { queued: null });
    send(agentId, text).catch((error: unknown) => {
      console.error(`session-stats: could not send queued "${label}"`, error);
    });
  }

  function subscribe(agentId: string, listener: () => void): () => void {
    const entry = ensure(agentId);
    entry.listeners.add(listener);
    return () => entry.listeners.delete(listener);
  }

  function get(agentId: string): Stats {
    return entries.get(agentId)?.stats ?? EMPTY;
  }

  function dispose() {
    entries.forEach((entry) => {
      stopTimeline(entry);
      entry.listeners.clear();
    });
    entries.clear();
  }

  return { applySnapshot, remove, retain, watch, submit, cancelQueued, subscribe, get, dispose };
}

export function useStats(store: StatsStore, agentId: string): Stats {
  const subscribe = useCallback((listener: () => void) => store.subscribe(agentId, listener), [store, agentId]);
  const get = useCallback(() => store.get(agentId), [store, agentId]);
  return useSyncExternalStore(subscribe, get, get);
}
