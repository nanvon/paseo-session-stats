import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// 按 agent 工作目录判断所在仓库，决定浮层里显示哪些快捷按钮
export const repoInfoRpc = defineRpc({
  name: "repo.info",
  input: z.object({ cwd: z.string() }),
  output: z.object({
    // 在 git 仓库内：显示 Commit、Commit & Push
    git: z.boolean(),
    // 仓库根目录有 release-notes/README.md（统一发版方案）：显示 Publish
    publish: z.boolean(),
  }),
});
