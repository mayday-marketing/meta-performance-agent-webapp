# Quality rubric — what "good" means

The runner checks the mechanical items automatically (marked ⚙). The rest are for
human review when you're judging a prompt change.

## Analysis agent (`agents/Analysis_Agent.md`)

Output contract (⚙ automated):
- Valid JSON, no prose/fences around it.
- `summary` is a non-empty string.
- `winners` and `losers` are arrays of 3–6 items; each item has `delta`, `heading`,
  `body`, `tag`.
- `recs` is an array of 2–3 items; each has `heading`, `body`, `tag`.
- `tag` values come from the allowed sets in the prompt.

Substance (human review, ⚙ partial):
- **No fabricated numbers** — every figure in a body should trace to the input
  `summary`. ⚙ The runner extracts numbers from bodies and WARNs on any that don't
  appear in the input (percentages/ratios are often derived, so this is a WARN, not
  a FAIL — you confirm).
- **Null-discipline** — no ROAS/CAC/retention claims unless those fields are
  non-null in the input; posts with `performance: null` are not rated against a
  benchmark.
- **Sample-size honesty** — claims on <3 posts carry an explicit caveat; no strong
  conclusion from a single post without saying so.
- **Specificity** — recs name a concrete action with numbers, not "post more Reels".
- **Dimensional spread** — winners/losers span format/platform/cadence/paid, not one
  angle five times.

## Chat agent (`agents/Chat_Agent.md`)

⚙ automated:
- Non-empty answer.
- **Plain text only** — no `**bold**`, no `#` headings, no `](` markdown links (the
  chat window renders escaped text, so markdown shows literally). FAIL if present.
- Cites at least one concrete number when the question is about performance.

Human review:
- Numbers match the dashboard that was passed in; nothing invented.
- No tool-pretense ("let me open your Drive"), no onboarding, no "shall I continue?".
- Answers in Dutch, direct, actionable; length fits the question.
- Uses brand context (pillars/tone) when it sharpens the answer.
