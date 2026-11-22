# Claude orchestration metrics

The local installation is under **state/claude-orchestration/**. Installation files and runtime evidence there are ignored by Git. The existing **Claude RVM Autopilot** Windows task launches the hidden Python/Node process at sign-in. Its internal metrics timer starts immediately and runs every five minutes; no additional service or scheduler task is required.

## Configuration

Edit **state/claude-orchestration/audit/metrics-config.json**. The collector reloads configuration every cycle. Timer changes take effect at the next already scheduled cycle. Keep maxTickGapMs greater than the collection interval.

| Setting | Default | Meaning |
| --- | ---: | --- |
| intervalMs | 300000 | AI-free measurement interval, five minutes |
| regularAuditMs | 21600000 | Periodic LLM audit interval, six hours |
| stalledMs | 7200000 | Active owner with unchanged closed headings and integrated units |
| noWorkersMs | 3600000 | Zero reported workers while dependency-ready actions remain |
| contextLimit | 150000 | Average model input tokens over the trailing hour |
| pinReadbackLimit | 30 | Pin/readback calls over the trailing hour |
| expensiveTicks | 2 | Consecutive high-context or high-pin samples |
| repeatedReasonTicks | 3 | Consecutive identical error/blocked reasons |
| maxTickGapMs | 900000 | Gap after which continuous observations restart |
| maxTailBytes | 8388608 | Maximum rollout bytes read per measurement |
| metricsTailBytes | 8388608 | Maximum metrics history read for aggregation |
| recentTicks | 12 | Samples attached to an anomaly audit |
| weeklyDailyBudgetPct | 14.285714 | Sustainable daily increase in weekly usage percentage points |
| timezone | Asia/Tokyo | Daily report date boundary |

The inherited November burn-plan override is **30 percentage points/day**, November 21 through November 30, 2026 (Japan time). weeklyBudgetOverrides holds its start, exclusive end, value and reason. This controls alerts only; it never buys credits, resets limits, or changes permissions. The base budget applies after expiry.

## Collection and audit behavior

metrics-tick.mjs reads CURRENT counts/status/updatedAt, closed headings, the existing action dependency table, canonical owner status and rollout, the actual seven-day account usage window, available RAM and workspace-volume free space (additional volumes may be configured with diskRoots). It only uses read RPCs. Memory collection uses the Windows Memory Available MBytes counter with an identified OS fallback after a ten-second counter deadline. Disk space uses native filesystem statistics without CIM. Account identifiers and credit balances are not persisted.

The initial rollout read is bounded to 8 MiB. Subsequent cycles read append bytes and retain compact events for the trailing hour. Incomplete lines wait for the next append; repeated token-count updates are deduplicated; truncation/replacement resets the cursor. Coverage is explicit. Tool-wall time sums available tool-reported durations and does not measure the owner's elapsed working time.

The timer runs independently of the ordinary watch and handler. A newly satisfied anomaly is queued and dispatched immediately after collection through headless **Sonnet / --effort low**. New anomaly batches start even if an ordinary handler or an earlier audit is still running. Durable claims and anomaly-state suppression prevent duplicate launches. Existing needs-opus escalation remains available. There is no one-hour cooldown.

Continuing anomalies are suppressed while meaningful state stays the same. Progress, operating status, relevant action set, reason or threshold-breach category changes permit a fresh notice; recovery also rearms it. Numeric context changes or tick-counter increments alone do not create repeat notices.

The six-hour LLM audit remains enabled in the metrics coordinator. It receives precomputed measurements, trends, anomaly history and daily reports, and focuses on causes, critical path, parallel work, wasted rituals and policy. The ordinary watcher no longer schedules a duplicate periodic audit. Targeted evidence reads remain available when judgment requires them; gathering the numbers again is unnecessary.

CURRENT worker counts carry their own observation timestamp. Dependency-ready actions are candidates from the existing table; they do not prove that every runtime worker is absent or that all genuine inputs are available. Audits must judge those limits against current evidence.

## Outputs and operation

- **audit/metrics.jsonl**: append-only samples, anomalies, new notices, read errors and source paths.
- **audit/daily-YYYYMMDD.md**: AI-free reports in the configured timezone. The current and preceding observed days are refreshed. Hourly windows overlap and are never summed across ticks.
- **audit/metrics-state.json**: incremental cursor, consecutive observations, suppression state, periodic timestamp and durable outbox.
- **audit/events/*.json**: pending, dispatching, completed, failed or unknown deliveries. A claim precedes Claude execution. Claimed/uncertain deliveries are never blindly retried after restart.
- **autopilot-log.jsonl**: timer registration, measurement results, dispatch IDs and existing model results.

For source restart, create STOP, allow existing handlers/audits to finish, verify the recorded autopilot process exited, remove STOP and start the existing **Claude RVM Autopilot** task once. Verify the exact new process, startup/timer logs and measurements. Do not force-stop an active handler or change owner/worker/RVM state. The watcher checks STOP between its existing polls; the timer stops collecting and claiming new work when STOP is present.

Run **node --test state/claude-orchestration/audit/metrics.test.mjs** for independent behavioral fixtures covering detection thresholds, suppression/rearming, incremental parsing, aggregation, periodic scheduling and claim-once dispatch. A live route check may inject one explicitly read-only synthetic event; archive it after completion and preserve its evidence outside the active queue.
