import { stat } from "node:fs/promises";
import path from "node:path";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { execCommand } from "@getpaseo/plugin/server";
import type { repoInfoRpc } from "../shared/rpc";

// git 不可用、目录不存在或不在仓库内时都按不在仓库处理
export async function readRepoInfo({ cwd }: RpcInput<typeof repoInfoRpc>): Promise<RpcOutput<typeof repoInfoRpc>> {
  try {
    const { stdout } = await execCommand("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 5000 });
    const root = stdout.trim();
    if (!root) return { git: false, publish: false };
    const notes = await stat(path.join(root, "release-notes", "README.md")).catch(() => null);
    return { git: true, publish: notes?.isFile() ?? false };
  } catch {
    return { git: false, publish: false };
  }
}
