Session stats adds pills next to each agent's composer that show how fast the agent is writing, how long it took to start, and how much of its input was served from the prompt cache, plus quick-send buttons. Labels are in Chinese.

Each metric has its own pill: speed (`实时 42 t/s` while a turn runs, `本轮 38 t/s` for the finished turn), time to first token (`首字 1.2s`) and cache hit rate (`缓存 92%`). The speed pill is always shown; the other two appear when they have data.

## How it works

The plugin listens to the agent's live timeline only while that agent's composer is on screen. Speed counts generation time only: each step is measured from its first streamed text to its last, so waiting for the first token and running tools are excluded. Live speed is estimated from characters (about one token per CJK character, four characters per token otherwise). When a turn ends, providers that report the turn's exact output tokens (Claude, Antigravity, Pi, OMP) replace the estimate with the exact figure. Time to first token is measured per step, from when the daemon receives your message (or when the previous tool call ends) to the first streamed text, so the first step includes the provider's startup time. When a provider delivers its whole answer at once instead of streaming it, speed shows `--` and the popover explains why.

The cache hit rate is cached input divided by total input from the provider's latest usage report. Codex counts cached tokens inside its input total and the other providers do not, so the plugin uses a different formula for Codex.

## Popover

Clicking any metric pill opens a popover with speed, time to first token, context usage, cost, cache hit rate, and raw input, cached and output token counts. It also shows the scope of the provider's usage figures, which differs by provider: a whole turn for Claude and Antigravity, the last request for Codex, and the whole session for Pi and OMP.

## Quick-send buttons

Four more pills send a prompt as you:

- OK sends "OK，按你推荐的最佳方案执行" and appears only when the agent is idle.
- Commit sends "提交代码" and Commit & Push sends "提交代码并推送". Both appear when the agent's working directory is inside a git repository.
- Publish sends "发版" and appears when the repository root contains `release-notes/README.md`.

Pressing Commit, Commit & Push or Publish while the agent is running queues the prompt and sends it when the turn ends, instead of interrupting the turn. While queued the button reads `Commit · 排队中`; pressing it again cancels.

## What it reads

The plugin reads agent snapshots and timeline events from the Paseo daemon. To decide which buttons to show, its server side runs `git rev-parse --show-toplevel` in the agent's working directory and checks whether `release-notes/README.md` exists. It sends nothing outside Paseo.

## Known limits

- Live speed is an estimate. Time spent streaming tool arguments is not visible in the timeline, so it is not counted.
- When you open an agent in the middle of a turn, that turn shows no time to first token and its average uses the estimate.
- Providers that do not report usage show no cache hit rate or token counts. Cursor and other ACP agents report usage only if the agent itself does.
- Claude does not report cache writes, so its cache hit rate is higher than a figure that includes them in the total.

Requires Paseo 0.11.0 or later.
