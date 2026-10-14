import type { PluginClientContext } from "@getpaseo/plugin/client";

type Paseo = PluginClientContext["paseo"];
export type AgentList = Awaited<ReturnType<Paseo["agents"]["list"]>>;
export type AgentUpdate = Parameters<Parameters<Paseo["agents"]["subscribe"]>[0]>[0];
export type AgentSnapshot = AgentList["entries"][number]["agent"];

const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 60_000;

/**
 * 跟随宿主上的全部 agent。0.9 起 `agents.subscribe()` 只是本地监听，必须先用
 * `agents.list({ subscribe: {} })` 打开 observation 才会收到推送：先来一次快照，
 * 重连后再来一次，中间是增量。observation 出错会被 Paseo 释放，这里按退避重开。
 * 返回清理函数。
 */
export function followAgents(
  paseo: Paseo,
  handlers: { snapshot(list: AgentList): void; update(update: AgentUpdate): void },
): () => void {
  const lifetime = new AbortController();
  let release: (() => void) | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let retryDelay = RETRY_MIN_MS;

  function reopen(error: unknown): void {
    release?.();
    release = null;
    if (lifetime.signal.aborted || retry !== null) return;
    console.warn("session-stats: agent observation failed; reopening", error);
    retry = setTimeout(() => {
      retry = null;
      open();
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
  }

  function open(): void {
    paseo.agents
      .list({ subscribe: {}, signal: lifetime.signal })
      .then(({ subscription }) => {
        if (lifetime.signal.aborted) {
          void subscription.release().catch(() => undefined);
          return;
        }
        const unsubscribe = subscription.subscribe({
          snapshot(list) {
            retryDelay = RETRY_MIN_MS;
            handlers.snapshot(list);
          },
          update(message) {
            if (message.type === "agent_update") handlers.update(message.payload);
          },
          error: reopen,
        });
        release = () => {
          unsubscribe();
          void subscription.release().catch(() => undefined);
        };
      })
      .catch(reopen);
  }

  open();
  return () => {
    lifetime.abort();
    if (retry !== null) clearTimeout(retry);
    retry = null;
    release?.();
    release = null;
  };
}
