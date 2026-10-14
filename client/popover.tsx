import type { PluginButtonContentProps, PluginHostProps } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { Text, View } from "react-native";
import { cacheHitRate, formatCount, formatSeconds, usageScope } from "./format";
import { useStats, type StatsStore } from "./stats";

// 与 pi-zentui 的上下文警戒线一致
const CONTEXT_WARNING = 70;
const CONTEXT_ERROR = 90;

type Theme = PluginHostProps["theme"];

// 三个统计 pill 共用的详情浮层
export function createStatsPopover(store: StatsStore) {
  return function StatsPopover(props: PluginButtonContentProps) {
    // 联合类型也覆盖 header 按钮；composer pill 总是属于某个 agent
    if (props.context !== "agent") return null;
    return <StatsPopoverBody store={store} agentId={props.agentId} theme={props.theme} />;
  };
}

function StatsPopoverBody({ store, agentId, theme }: { store: StatsStore; agentId: string; theme: Theme }) {
  const s = useStats(store, agentId);
  const styles = useMemo(() => createStyles(theme), [theme]);

  const speed = s.running ? s.tps : s.turnTps;
  let speedText = "--";
  if (speed !== null) speedText = `${Math.round(speed)} t/s${s.running || !s.turnTpsPrecise ? "（估算）" : ""}`;
  else if (!s.running && s.speedUnmeasurable) speedText = "--（未逐字流式输出）";

  const percent =
    s.contextUsed !== null && s.contextMax !== null && s.contextMax > 0 ? (s.contextUsed / s.contextMax) * 100 : null;
  const contextText =
    s.contextUsed === null
      ? "--"
      : `${formatCount(s.contextUsed)}${s.contextMax !== null ? `/${formatCount(s.contextMax)}` : ""}${
          percent !== null ? ` ${percent.toFixed(1)}%` : ""
        }`;
  let contextColor = theme.colors.foreground;
  if (percent !== null && percent >= CONTEXT_ERROR) contextColor = theme.colors.statusDanger;
  else if (percent !== null && percent >= CONTEXT_WARNING) contextColor = theme.colors.statusWarning;

  const hit = cacheHitRate(s.provider, s.usage);
  const tokens = s.usage
    ? [
        `输入 ${s.usage.inputTokens !== undefined ? formatCount(s.usage.inputTokens) : "--"}`,
        `缓存 ${s.usage.cachedInputTokens !== undefined ? formatCount(s.usage.cachedInputTokens) : "--"}`,
        `输出 ${s.usage.outputTokens !== undefined ? formatCount(s.usage.outputTokens) : "--"}`,
      ].join(" · ")
    : "--";

  const rows: [string, string, string?][] = [
    [s.running ? "实时速度" : "本轮均速", speedText],
    ["首字时间", s.ttft === null ? "--" : `${formatSeconds(s.ttft)}s`],
    ["上下文", contextText, contextColor],
    ["花费", s.cost === null ? "--" : `$${s.cost.toFixed(3)}`],
    ["缓存命中", hit === null ? "--" : `${Math.round(hit)}%`],
    ["Token", tokens],
  ];

  const notes = [`usage 口径：${usageScope(s.provider)}。速度只计生成时间，实时值按字符估算。`];
  if (!s.running && s.speedUnmeasurable) {
    notes.push("上一轮的输出是整段一次到达的，provider 没有逐字流式输出，无法测速。");
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>会话统计</Text>
        <Text style={styles.muted} numberOfLines={1}>
          {[s.provider, s.model].filter(Boolean).join(" · ")}
        </Text>
      </View>

      {rows.map(([label, value, color]) => (
        <View key={label} style={styles.row}>
          <Text style={styles.label}>{label}</Text>
          <Text style={[styles.value, color ? { color } : null]}>{value}</Text>
        </View>
      ))}

      {notes.map((note) => (
        <Text key={note} style={styles.note}>
          {note}
        </Text>
      ))}
    </View>
  );
}

function createStyles(theme: Theme) {
  const { colors } = theme;
  return {
    container: { minWidth: 260, gap: 6 },
    header: { marginBottom: 6, gap: 2 },
    title: { color: colors.foreground, fontSize: 15, fontWeight: "600" as const },
    row: { flexDirection: "row" as const, justifyContent: "space-between" as const, gap: 16 },
    label: { color: colors.foregroundMuted, fontSize: 13 },
    value: { color: colors.foreground, fontSize: 13, fontVariant: ["tabular-nums" as const] },
    muted: { color: colors.foregroundMuted, fontSize: 12 },
    note: { color: colors.foregroundMuted, fontSize: 11, marginTop: 4 },
  };
}
