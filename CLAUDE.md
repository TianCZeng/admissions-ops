@AGENTS.md

## For Claude Code

The instructions above (`AGENTS.md`) are the single source of truth for product policy. This file only adds Claude Code–specific pointers.

- **Skills** live at `.agents/skills/*` and are symlinked into `.claude/skills/`. Each skill is a single file on disk — edit it under `.agents/skills/<skill>/` and the `.claude/skills/` path reflects the change. There is no second copy to update; never hand-edit both paths or replace a symlink with a real file.
  - `/admissions-ops` — the product router (evaluate, cv, compare, tracker, inbox).
- **Contributing to this repo?** Start from `CONTRIBUTING.md`. `npm run verify` must pass, and some documentation phrases are asserted by `scripts/verify/layout.js`, so doc changes may need matching assertion updates in the same PR.
