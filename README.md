<h1 align="center">Session Stats for Paseo</h1>

<p align="center">
  <b>Paseo 客户端插件：在输入框旁显示 agent 的输出速度、首字时间和缓存命中率</b><br>
  点开统计 pill 查看上下文、花费和 token 明细；OK、Commit、Commit & Push、Publish 快捷按钮也是 pill，一键发送提示词。
</p>

<p align="center">
  <img alt="Paseo" src="https://img.shields.io/badge/Paseo-0.11%2B-111111">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-orange">
</p>

<p align="center">
  <a href="#-核心特性">功能特性</a> ·
  <a href="#-快速安装">安装指南</a> ·
  <a href="#-指标口径">指标口径</a> ·
  <a href="#-数据与隐私">数据与隐私</a> ·
  <a href="#-本地开发">本地开发</a>
</p>

---

## ✨ 核心特性

### 统计 pill

Paseo 把每个 composer pill 限制在 160px 宽、单行显示，所以三项指标各占一个 pill，点任意一个打开同一个详情浮层。

| pill | 示例 | 显示条件 |
| :--- | :--- | :--- |
| 速度 | `实时 42 t/s`、`本轮 38 t/s`、`-- t/s` | 始终显示 |
| 首字时间 | `首字 1.2s` | 轮次进行中，或已有数值 |
| 缓存命中率 | `缓存 92%` | provider 上报了缓存读取 |

- **实时速度** — 轮次进行中约每 0.5 秒刷新，轮次结束后显示本轮均速。
- **只计生成时间** — 每一步从首个流式片段计到最后一个片段，首字等待和工具执行不计入。
- **首字时间** — 按步计算：从 daemon 收到消息或上一个工具结束，到首个 assistant 或 reasoning 片段。第一步包含 provider 的启动耗时。
- **缓存命中率** — 按 provider 最近一次上报的 usage 计算，codex 与其他 provider 分别使用各自口径。
- **按需订阅** — 只在某个 agent 的输入框显示在屏幕上时订阅它的 timeline；不在屏幕上的 agent 只接收快照。

### 详情浮层

- **完整数据** — 速度（标注是否为估算）、首字时间、上下文占用（70% 和 90% 变色）、花费、缓存命中率，以及输入、缓存、输出三项 token 数。
- **无法测速时说明原因** — provider 整段一次输出、没有逐字流式输出时，速度显示 `--` 并注明原因。

### 快捷按钮 pill

发送的提示词与 [Claude Code 的 session-stats mod](#-相关项目) 一致：

| 按钮 | 发送内容 | 显示条件 |
| :--- | :--- | :--- |
| OK | `OK，按你推荐的最佳方案执行` | agent 空闲时 |
| Commit | `提交代码` | 工作目录在 git 仓库内 |
| Commit & Push | `提交代码并推送` | 工作目录在 git 仓库内 |
| Publish | `发版` | 仓库根目录有 `release-notes/README.md` |

- **运行中排队** — agent 运行时按 Commit、Commit & Push 或 Publish 会先排队，本轮结束后再发送，不中断当前轮次。排队期间按钮显示 `Commit · 排队中`，再点一次取消。
- **发送状态** — 发送过程中按钮显示加载状态，发送失败时 Paseo 弹出错误提示。

---

## 📦 快速安装

> **运行环境**：Paseo 0.11.0 或更新版本，Node.js 与 npm（安装开发依赖用）。

1. 克隆仓库并安装依赖。Paseo 编译插件时需要解析 `@getpaseo/plugin` 等包的类型声明，所以 `node_modules` 必须存在：

   ```bash
   git clone <仓库地址> paseo-session-stats
   ```

   ```bash
   cd paseo-session-stats && npm install --legacy-peer-deps
   ```

2. 在 `~/.paseo/config.json` 的 `plugins` 字段里登记为目录插件，`path` 换成你的实际路径：

   ```json
   "session-stats": {
     "source": "directory",
     "path": "/path/to/paseo-session-stats",
     "enabled": true
   }
   ```

3. 重启 Paseo。之后修改代码需要重载插件：

   ```bash
   paseo plugin reload session-stats
   ```

> [!NOTE]
> macOS 上 `paseo` 命令位于 `/Applications/Paseo.app/Contents/Resources/bin/paseo`，默认不在 `PATH` 里。插件出错时可用 `paseo plugin logs session-stats` 查看日志。

---

## 📐 指标口径

Paseo 不在客户端推送流式 token 计数，各 provider 上报 usage 的范围也不同。插件的处理方式如下：

| provider | usage 范围 | 本轮均速 | inputTokens 是否含缓存 |
| :--- | :--- | :--- | :---: |
| **claude** | 整轮汇总 | 精确 output / 生成时间 | 不含 |
| **antigravity** | 整轮汇总 | 精确 output / 生成时间 | 不含 |
| **pi、omp** | 会话累计 | 轮次前后累计值之差 / 生成时间 | 不含 |
| **codex** | 最近一次请求 | 字符估算 | 含 |
| **cursor 等 ACP agent** | 取决于 agent 是否上报 | 字符估算 | 不确定 |

- **实时速度** — 一律按字符估算：CJK 每字约 1 token，其余约 4 字符 1 token。
- **缓存命中率** — codex 按 `cached / input` 计算，其他 provider 按 `cached / (input + cached)` 计算。Claude 没有上报 cache write，所以算出的命中率比把 cache write 计入分母的口径偏高。
- **时间基准** — 使用 daemon 给每个事件打的时间戳，时间差不受客户端时钟和转发延迟影响。

> [!WARNING]
> 在轮次进行中途打开某个 agent 时，这一轮的首字时间显示 `--`，本轮均速改用估算值。流式输出工具参数的时间在 timeline 里不可见，不计入实时速度。

---

## 🔒 数据与隐私

插件只读取 Paseo daemon 已有的数据，不向 Paseo 之外发送任何内容。

| 数据 | 来源 | 权限 | 用途 |
| :--- | :--- | :---: | :--- |
| **agent 快照** | `paseo.agents.list({ subscribe })` | 只读 | 状态、provider、usage、工作目录 |
| **timeline 事件** | `agents.ref(id).timeline.subscribe()` | 只读 | 轮次起止、流式片段、工具调用的时间点 |
| **仓库信息** | 服务端在 agent 工作目录执行 `git rev-parse --show-toplevel`，检查 `release-notes/README.md` 是否存在 | 只读 | 决定显示哪些快捷按钮 |
| **发送提示词** | `agents.ref(id).send(text)` | 写 | 仅在点击快捷按钮时，以你的身份发送 |

---

## 🔧 本地开发

```bash
npm run typecheck
```

插件由 Paseo daemon 用 esbuild 从源码直接打包，不需要构建产物。目录约束：

- 入口文件为根目录的 `index.client.tsx` 和 `index.server.ts`；
- 其余模块只能放在 `client/`、`server/`、`shared/` 下，client 与 server 之间只能通过 `shared/` 共享代码；
- `react`、`react-native`、`zod`、`@getpaseo/plugin/*` 由宿主提供，不打进包里。

| 文件 | 说明 |
| :--- | :--- |
| `client/stats.ts` | 每个 agent 的统计状态、timeline 订阅、速度与首字计算、按钮排队 |
| `client/pill.tsx` | 为每个 agent 注册三个统计 pill 和四个按钮 pill；速度 pill 的图标挂载时订阅 timeline |
| `client/popover.tsx` | 详情浮层 |
| `client/format.ts` | 字符估算、格式化、缓存命中率口径 |
| `client/agents.ts` | agent observation，失败后按退避重开 |
| `server/repo.ts` | `repo.info` RPC 的实现 |

---

## 🔗 相关项目

同名的另外两个实现，功能和提示词以它们为准：

| 项目 | 平台 | 区别 |
| :--- | :--- | :--- |
| **session-stats mod** | Claude Code | 显示在输入框上方，带四个快捷按钮 |
| **session-stats 扩展** | pi | 显示在 footer 状态栏，没有按钮 |

---

## 📄 许可证

本项目基于 [MIT License](LICENSE) 开源。
