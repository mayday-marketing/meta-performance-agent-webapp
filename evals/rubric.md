# Quality rubric — what "good" means

The runner checks the mechanical items automatically (marked ⚙). The rest are for
human review when you're judging a prompt change.

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
