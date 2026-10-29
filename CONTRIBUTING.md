# Contributing to admissions-ops

Thanks for your interest. This project is deliberately narrow: one-program evaluation, evidence-grounded CV/resume and statement adaptation, and deterministic validation. Contributions that keep that shape are the easiest to accept.

## Ground rules

- **Read `AGENTS.md` first.** It is the product policy: eligibility and fit stay separate, official pages are the only proof source, generated artifacts stay `Review Required`, and the deterministic layer guards but never authors judgement. Changes that weaken these invariants will not be merged.
- **Never include real applicant data.** All committed student content must be fictional and labeled as such (see `students/nus-cs/` and `examples/`). PRs containing real names, transcripts, test scores, or personal documents will be closed.
- **`npm run verify` must pass.** CI runs the full deterministic suite. If you change a contract, extend the matching `verify:*` script in the same PR so the new invariant is enforced, not just documented.
- **Generated artifacts are rendered, not edited.** `verify:generated` re-renders every committed workspace and rejects hand-edited output. To change a generated file, change its plan or the renderer and re-run the deterministic command.
- **Doc changes can trip CI on purpose.** `scripts/verify/layout.js` asserts specific phrases and sections in `README.md`, `README.zh-CN.md`, `AGENTS.md`, and the mode docs as policy guards. If your documentation change fails `verify:layout`, update the matching assertion in the same PR — keep it as a structural check on the new wording rather than deleting it.

## Good first contributions

- New `verify:*` checks for invariants that are documented but not yet enforced.
- Additional fictional fixtures that exercise edge cases (unusual grading scales, rolling deadlines, conflicting official pages).
- Documentation fixes and setup-experience improvements.
- Support for loading the `.agents/skills/` router in additional agent environments.

## Larger changes

Open an issue before building: batch evaluation, discovery, dashboards, and funding models are on the roadmap but sequenced deliberately. Proposals that broaden discovery before the one-program workflow is airtight are out of scope by policy.

## Workflow

1. Fork, branch from `main`.
2. Make the change; keep diffs focused.
3. Run `npm run verify` locally.
4. Open a PR describing what invariant or workflow the change serves.
