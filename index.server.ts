import type { PluginServerContext } from "@getpaseo/plugin/server";
import { readRepoInfo } from "./server/repo";
import { repoInfoRpc } from "./shared/rpc";

export default function contribute(server: PluginServerContext) {
  server.handle(repoInfoRpc, readRepoInfo);
  return () => {};
}
