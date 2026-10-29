---
name: Bug report
about: Something in the workflow, a script, or a validator does not behave as documented
title: ""
labels: bug
---

<!--
⚠️ Never paste real applicant data (names, transcripts, scores, statements).
Reproduce with the synthetic demo (students/nus-cs/), the examples/ fixtures,
or invented fake data. Sensitive reports go through SECURITY.md instead.
-->

**What happened** A clear description of the behavior you saw.

**What you expected** What the documented behavior should be.

**Steps to reproduce**
1. Command(s) run (e.g. `npm run cv -- --student <id> --program <id>`)
2. Relevant workspace / fixture used
3. …

**Environment**
- Node version (`node --version`):
- OS:
- Agent environment (Claude Code, other), if relevant:

**`npm run verify` output** Paste the relevant failure if a validator is involved. (Doc changes can trip `verify:layout` on purpose — see CONTRIBUTING.md.)
