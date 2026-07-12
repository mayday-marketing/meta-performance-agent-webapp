# Prompt evals

A tiny, dependency-free harness to sanity-check the **Analysis** and **Chat** agents
after you change a prompt (`agents/Analysis_Agent.md`, `agents/Chat_Agent.md`) or a
model. It catches regressions in the things that are cheap to check automatically —
JSON shape, field counts, plain-text formatting, obvious fabrication — so you can
tune prompts on a weaker model without eyeballing every run.

It is **not** an LLM-judge. It runs deterministic assertions and flags anything
fuzzy (e.g. possibly-invented numbers) as a WARN for you to eyeball. See
[`rubric.md`](rubric.md) for what "good" means; the runner encodes the mechanical
subset.

## Run it

Needs Node 18+ (built-in `fetch`). Point it at a deployment where the API is
reachable — **production** or a local `vercel dev`, NOT a preview URL (previews sit
behind Vercel SSO and will redirect the runner to a login page).

```bash
BASE_URL=https://meta-performance-agent-webapp.vercel.app \
CLIENT_ID=spotto \
PASSWORD='the-client-password' \
node evals/run.mjs
```

The runner logs in via `/api/auth` to get a real token, then replays every fixture
in `fixtures/` against `/api/analysis` and `/api/chat` and prints PASS/WARN/FAIL per
check. Exit code is non-zero if anything FAILs.

Filter to one fixture: `node evals/run.mjs realestate-2026-06`.

## Fixtures

Each `fixtures/*.json` is one realistic period:

```json
{ "brandName": "...", "period": { "startDate", "endDate", "days" }, "summary": { … } }
```

`summary` is exactly the object `buildAnalysisSummary()` produces in `app.js`
(kpis, byPlatform, cadence, performanceBreakdown, overperformers, ads, …). To
capture a **real** one: log into the app, load a dashboard, and in the browser
console run `copy(buildAnalysisSummary())`, then paste it as the `summary` of a new
fixture file. Real fixtures are the most valuable — the included one is a
representative hand-built sample. Do not commit a client's sensitive data if the
account is confidential; scrub captions if needed.
