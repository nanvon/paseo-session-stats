import type { PluginButtonIconProps, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect } from "react";
import { repoInfoRpc } from "../shared/rpc";
import { followAgents, type AgentList, type AgentUpdate } from "./agents";
import { cacheLabel, speedLabel, ttftLabel } from "./format";
import { createStatsPopover } from "./popover";
import { createStatsStore, type Stats, type StatsStore } from "./stats";

type Repo = { git: boolean; publish: boolean };

// 快捷按钮发送的提示词，与 Claude mod 一致
const PROMPT_OK = "OK，按你推荐的最佳方案执行";
const PROMPT_COMMIT = "提交代码";
const PROMPT_COMMIT_PUSH = "提交代码并推送";
const PROMPT_PUBLISH = "发版";

type PillSpec = {
  id: string;
  title: string;
  icon: string;
  // 返回 null 表示隐藏
  label(s: Stats, repo: Repo): string | null;
  // 快捷按钮：点击发送的提示词；统计 pill 没有，点开是详情浮层
  prompt?: string;
};

// 按钮 label：排队中时标出来，再点一次取消
function buttonLabel(s: Stats, label: string, visible: boolean): string | null {
  if (s.queued === label) return `${label} · 排队中`;
  return visible ? label : null;
}

// 注册顺序即显示顺序。速度 pill 的图标单独处理，见 createSpeedIcon
const PILLS: PillSpec[] = [
  { id: "session-stats-speed", title: "输出速度", icon: "Gauge", label: speedLabel },
  { id: "session-stats-ttft", title: "首字时间", icon: "Timer", label: ttftLabel },
  { id: "session-stats-cache", title: "缓存命中率", icon: "Database", label: cacheLabel },
  // OK 只在空闲时显示，避免排队后答复的已是另一条回复
  { id: "session-stats-ok", title: "OK", icon: "Check", prompt: PROMPT_OK, label: (s) => (s.running ? null : "OK") },
  {
    id: "session-stats-commit",
    title: "Commit",
    icon: "GitCommitHorizontal",
    prompt: PROMPT_COMMIT,
    label: (s, repo) => buttonLabel(s, "Commit", repo.git),
  },
  {
    id: "session-stats-commit-push",
    title: "Commit & Push",
    icon: "ArrowUpFromLine",
    prompt: PROMPT_COMMIT_PUSH,
    label: (s, repo) => buttonLabel(s, "Commit & Push", repo.git),
  },
  {
    id: "session-stats-publish",
    title: "Publish",
    icon: "Rocket",
    prompt: PROMPT_PUBLISH,
    label: (s, repo) => buttonLabel(s, "Publish", repo.publish),
  },
];

/**
 * pill 由一份纯描述（图标、文字、点击行为）绘制，图标是其中唯一的组件。
 * 宿主只在该 agent 的输入框显示时挂载它，所以由速度 pill 的图标订阅 timeline，
 * 统计只覆盖屏幕上的 agent。速度 pill 因此始终可见，隐藏的 pill 不会挂载图标。
 */
function createSpeedIcon(store: StatsStore, agentId: string) {
  return function SpeedPillIcon({ size, color }: PluginButtonIconProps) {
    useEffect(() => store.watch(agentId), []);
    return <Icon name="Gauge" size={size} color={color} />;
  };
}

type Group = {
  workspaceId: string;
  registrations: Map<string, PluginButtonRegistration>;
  // 已推给宿主的 label，null 为隐藏；只在变化时调用 update
  shown: Map<string, string | null>;
  repo: Repo;
  repoCwd: string | null;
  running: boolean;
  unsubscribe: () => void;
};

/**
 * 每个 agent 一组 pill：三个统计（点开是详情浮层）和四个快捷按钮。
 * 客户端入口每个连接的 app 运行一次，这里管理全部注册：先按快照建，再跟随增量，退出时全部移除。
 */
export function contributePills(client: PluginClientContext) {
  const store = createStatsStore(client.paseo);
  const groups = new Map<string, Group>();
  const Popover = createStatsPopover(store);
  let stopped = false;

  async function press(agentId: string, label: string, prompt: string) {
    // 排队中的按钮再点一次是取消
    if (store.get(agentId).queued === label) {
      store.cancelQueued(agentId);
      return;
    }
    // 发送失败时抛出，宿主会弹出错误提示
    await store.submit(agentId, label, prompt);
  }

  // 按 agent 工作目录判断仓库，决定显示哪些按钮；git 不可用时按不在仓库处理
  function refreshRepo(agentId: string, group: Group, cwd: string) {
    client
      .rpc(repoInfoRpc, { cwd })
      .then((repo) => {
        if (groups.get(agentId) !== group || group.repoCwd !== cwd) return;
        group.repo = repo;
        sync(agentId);
      })
      .catch((error: unknown) => console.warn("session-stats: could not read repo info", error));
  }

  function sync(agentId: string) {
    const group = groups.get(agentId);
    if (!group) return;
    const s = store.get(agentId);

    // 工作目录变化或一轮结束时重新判断：本轮可能切换了目录、新建了仓库或发版方案
    if (s.cwd && (s.cwd !== group.repoCwd || (group.running && !s.running))) {
      group.repoCwd = s.cwd;
      refreshRepo(agentId, group, s.cwd);
    }
    group.running = s.running;

    PILLS.forEach((spec) => {
      const label = spec.label(s, group.repo);
      if (group.shown.get(spec.id) === label) return;
      group.shown.set(spec.id, label);
      group.registrations.get(spec.id)?.update(label === null ? { visible: false } : { visible: true, label });
    });
  }

  function addGroup(agentId: string, workspaceId: string) {
    if (stopped) return;
    // agent 每轮都会推更新；重新注册会让图标重新挂载、timeline 重新订阅，Paseo 也拒绝重复 id。
    // 只有换了 workspace 才需要重建，因为它写在注册里
    const current = groups.get(agentId);
    if (current?.workspaceId === workspaceId) return;
    if (current) removeGroup(agentId);

    const registrations = new Map<string, PluginButtonRegistration>();
    PILLS.forEach((spec) => {
      const isSpeed = spec.id === "session-stats-speed";
      const prompt = spec.prompt;
      registrations.set(
        spec.id,
        client.addComposerPill({
          id: spec.id,
          workspaceId,
          agentId,
          button: {
            title: spec.title,
            label: isSpeed ? "-- t/s" : spec.title,
            icon: isSpeed ? createSpeedIcon(store, agentId) : spec.icon,
            // 先隐藏，由 sync 按数据决定显示
            visible: isSpeed,
            behavior:
              prompt === undefined
                ? { kind: "popover", Content: Popover }
                : { kind: "action", onPress: () => press(agentId, spec.title, prompt) },
          },
        }),
      );
    });

    const group: Group = {
      workspaceId,
      registrations,
      shown: new Map(),
      repo: { git: false, publish: false },
      repoCwd: null,
      running: false,
      unsubscribe: store.subscribe(agentId, () => sync(agentId)),
    };
    groups.set(agentId, group);
    sync(agentId);
  }

  function removeGroup(agentId: string) {
    const group = groups.get(agentId);
    if (!group) return;
    group.unsubscribe();
    group.registrations.forEach((registration) => registration.remove());
    groups.delete(agentId);
  }

  function applyUpdate(update: AgentUpdate) {
    if (update.kind === "remove") {
      removeGroup(update.agentId);
      store.remove(update.agentId);
      return;
    }
    const { agent } = update;
    store.applySnapshot(agent);
    if (agent.workspaceId) addGroup(agent.id, agent.workspaceId);
  }

  // 快照在首次和每次重连后到达，替换整个集合
  function applySnapshot(list: AgentList) {
    if (stopped) return;
    const listed = new Set<string>();
    list.entries.forEach(({ agent }) => {
      listed.add(agent.id);
      store.applySnapshot(agent);
      if (agent.workspaceId) addGroup(agent.id, agent.workspaceId);
    });
    [...groups.keys()].forEach((agentId) => {
      if (!listed.has(agentId)) removeGroup(agentId);
    });
    store.retain(listed);
  }

  const unfollow = followAgents(client.paseo, { snapshot: applySnapshot, update: applyUpdate });

  return () => {
    stopped = true;
    unfollow();
    [...groups.keys()].forEach(removeGroup);
    store.dispose();
  };
}
