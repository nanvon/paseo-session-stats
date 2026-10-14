import type { Stats, Usage } from "./stats";

// 流式片段只有文字，实时值按字符估算：CJK 约 1 字 1 token，其余约 4 字符 1 token
const CJK = /[　-鿿가-힯＀-￯]/;

export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK.test(ch)) cjk++;
    else other++;
  }
  return cjk + other / 4;
}

export function formatCount(value: number): string {
  if (value < 1000) return Math.round(value).toString();
  // 去掉末尾的 .0：1.0k 显示为 1k，1.0M 显示为 1M
  if (value < 10_000) return `${Number((value / 1000).toFixed(1))}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  if (value < 10_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
  return `${Math.round(value / 1_000_000)}M`;
}

export function formatSeconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}

/**
 * 缓存命中率。各 provider 的 inputTokens 口径不同：codex 按 OpenAI 口径已含缓存部分，
 * claude、pi、omp、opencode、antigravity 不含。cache write 没有上报，只能按缓存读占比算。
 * 没有缓存读时不显示，与 Claude mod、pi 扩展一致。
 */
export function cacheHitRate(provider: string | null, usage: Usage | null): number | null {
  const cached = usage?.cachedInputTokens;
  if (typeof cached !== "number" || cached <= 0) return null;
  const input = usage?.inputTokens ?? 0;
  const total = provider === "codex" ? input : input + cached;
  if (total <= 0) return null;
  return Math.min(100, (cached / total) * 100);
}

// usage 的统计范围，浮层里说明数值是哪一段的
export function usageScope(provider: string | null): string {
  switch (provider) {
    case "claude":
    case "antigravity":
      return "整轮汇总";
    case "codex":
      return "最近一次请求";
    case "pi":
    case "omp":
      return "会话累计";
    default:
      return "取决于 provider";
  }
}

/**
 * Paseo 把 composer pill 宽度限制在 160px 且只显示一行，所以三项指标各占一个 pill。
 * 返回 null 表示隐藏该 pill。速度 pill 始终显示：它的图标负责订阅 timeline。
 * 进行中未出值时用 -- 占位，避免 pill 时有时无。
 */
export function speedLabel(s: Stats): string {
  if (s.running) return `实时 ${s.tps === null ? "--" : Math.round(s.tps)} t/s`;
  return s.turnTps === null ? "-- t/s" : `本轮 ${Math.round(s.turnTps)} t/s`;
}

export function ttftLabel(s: Stats): string | null {
  if (!s.running && s.ttft === null) return null;
  return `首字 ${s.ttft === null ? "--" : formatSeconds(s.ttft)}s`;
}

export function cacheLabel(s: Stats): string | null {
  const hit = cacheHitRate(s.provider, s.usage);
  return hit === null ? null : `缓存 ${Math.round(hit)}%`;
}
