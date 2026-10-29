# Data Contract

This document defines the user-owned data layer and the system-owned workflow layer for `admissions-ops`.

## User Layer

These files contain personal data, decisions, or generated work product. They must not be replaced by automated updates.

Live applicant workspaces are selected with `--student <student-id>`. Student IDs must be path-safe strings. All applicant-specific state lives under one student root:

| Path | Purpose |
|---|---|
| `students/{student-id}/profile.yml` | Identity, education context, language and test status for one student |
| `students/{student-id}/preferences.yml` | Target fields, degree types, countries, intakes, constraints, fit weights |
| `students/{student-id}/evidence.yml` | Structured academic record and evidence for that student only |
| `students/{student-id}/master-cv.md` | Canonical human-reviewed CV source for that student |
| `students/{student-id}/statement-brief.md` | Student-authored narrative direction and allowed personal context for statements |
| `students/{student-id}/evaluations/*` | Student-specific eligibility, fit, evidence references, CV/statement plans, and action items |
| `students/{student-id}/tracker.md` | Student-specific admissions tracker |
| `students/{student-id}/reports/*` | Sourced reports for that student, combining catalog facts and student evaluation |
| `students/{student-id}/checklists/*` | Student-specific document, deadline, and verification tasks |
| `students/{student-id}/output/*` | Student-specific generated CV or resume artifacts and change logs |
| `students/{student-id}/raw/` | Source documents (CV, transcript) that `setup` reads; gitignored even in a private copy that tracks the workspace |

This prevents collisions when two students apply to the same program: their evaluations, reports, trackers, checklists, and generated files are stored under different `students/{student-id}/` roots.

Flat `students/*.example.*` files are setup examples only. Root-level `programs/evaluations/`, `programs/checklists/`, `reports/`, and `output/` contain placeholders only; live applicant records must not be read from or written to those roots.

Shared program facts live outside any student workspace:

| Path | Purpose |
|---|---|
| `programs/catalog/{program-id}.yml` | Official-source program facts shared across students |

Catalog records may contain institution, program, degree type, intake, applicant category when materially distinct, official URLs, retrieved dates, deadlines, requirements, document instructions, sources, freshness warnings, and conflicts. Catalog records must not contain evidence IDs, fit judgements, CV or statement plans, tracker state, tailored output links, or student action items.

The MVP does not require raw transcripts, passports, financial records, recommendation letters, or private application portal exports inside the repo. When the user hands `setup` a CV or transcript, it lives under `students/{student-id}/raw/` and nowhere else in the repository.

## System Layer

These files define reusable workflow behavior, templates, and examples.

| Path | Purpose |
|---|---|
| `AGENTS.md` | Repository-wide agent policy |
| `.agents/skills/*` | User-invocable command router |
| `modes/*` | Workflow prompts and mode contracts |
| `templates/*` | Status and document templates |
| `students/*.example.yml` | Setup examples, not live user data |
| `students/*.example.md` | Setup examples, not live user data |
| `programs/inbox.example.yml` | Curated inbox example |
| `programs/evaluations/.gitkeep` | Placeholder only; real evaluated-program records are user-owned |
| `programs/catalog/*.yml` | Shared official-source program catalog records |
| `examples/*` | Fictional fixtures for development and tests |
| `validation-output/dry-run/*` | Gitignored generated artifacts from user-facing dry-runs |
| `validation-output/verify/*` | Gitignored generated artifacts from deterministic validation |
| `package.json` | Project metadata and deterministic check entry points |

## Boundary Rule

Personal academic history, target preferences, and generated application state belong in the user layer. Shared scoring policy, source hierarchy, report schema, and document generation rules belong in the system layer.

`npm run init -- --student <student-id>` creates a new workspace's inputs only: copies of `students/profile.example.yml`, `preferences.example.yml`, `evidence.example.yml`, and `master-cv.example.md`, plus an empty `tracker.md`. It writes nothing when any of those files already exists, and it never writes `statement-brief.md`, whose existence is what lets `program` package a statement. `npm run check -- --student <student-id>` reads the same four inputs and writes nothing.

When adapting a document for a specific program, write the adaptation plan and artifact under `students/{student-id}/output/` or reference it from the student-scoped program report. Do not edit the selected student's `master-cv.md` as part of tailoring.

The live CV/resume runner requires `--student <student-id>` and reads `students/{student-id}/evaluations/<program-id>.yml`. Student-scoped evaluations may reference `catalog_id` to merge shared official facts from `programs/catalog/`. The evaluation must carry an agent-authored `cv_adaptation_plan` with `document_type`, `summary`, `profile_summary`, and `evidence_priorities` as an ordered list of evidence IDs that is exactly the rendered set; `document_instructions` stays a faithful transcription of the official text and may not carry a structured document type. `npm run cv -- --student <student-id> --program <program-id>` is a dry-run and writes only under `validation-output/dry-run/live/{student-id}/{program-id}/`. An optional `--document-type academic_cv|admissions_resume` overrides the plan's document type; overrides of the instruction-derived default are recorded in the change log with a rationale. `--write` is explicit approval to write draft artifacts under the selected student workspace `output/` (exactly one CV artifact per program; the other type's file is deleted in the same run) and to refresh the CV links in the matching report and tracker row, the tracker Next Action cell (rendered from the evaluation's `next_action`), the evaluation's `tailored_cv` status field, and — on a CLI document-type override — the plan's `document_type` and rationale, keeping all of them in sync.

The full agent-led `program` pipeline may accept a user-specified `--write-drafts` flag. That flag is explicit approval to run the deterministic CV/resume and statement dry-runs first, inspect the generated links, evidence maps, counts, and validation concerns, and then rerun only the applicable CV/resume renderer or statement packager with `--write`. It does not authorize edits to canonical student inputs, broad report regeneration, final-status marking, or external submission.

The comparison runner requires `--student <student-id>` and reads two or more normalized student evaluation records from `students/{student-id}/evaluations/`. Catalog records alone and raw inbox entries are not comparable. `npm run compare -- --student <student-id> --program <program-id> --program <program-id>` is a dry-run and writes only under `validation-output/dry-run/compare/{student-id}/`. `--write` is explicit approval to create or refresh the comparison report and comparison checklist in the selected student workspace. `--sync-tracker` may add missing tracker rows from normalized evaluated records; in dry-run mode this happens only in the copied validation workspace.

The statement packager/validator requires `--student <student-id>` and reads `students/{student-id}/statement-brief.md`, `students/{student-id}/evidence.yml`, `students/{student-id}/master-cv.md`, and `students/{student-id}/evaluations/<program-id>.yml`. Student-scoped evaluations may contain an agent-authored `statement_plan` and may reference catalog facts, but catalog records alone and raw inbox entries cannot be used for statement packaging. The `statement_plan` must include an LLM-authored body-only draft in `draft_markdown` and a structured `claim_map`; `npm run statement` validates and packages that prose without drafting or rewriting it. `npm run statement -- --student <student-id> --program <program-id>` is a dry-run and writes only under `validation-output/dry-run/statement/{student-id}/{program-id}/`. `--write` is explicit approval to write only `statement-plan.md`, `statement-draft.md`, `statement-evidence-map.yml`, and `statement-change-log.md` under the selected student workspace `output/{program-id}/`, plus refresh the report Statement link block, the tracker Statement column, and the evaluation's `statement` status field. Statement artifacts must remain `Review Required`.

After an approved write, the evaluation, report, and tracker agree on the CV and statement link/status fields; the tracker Next Action cell equals the evaluation's `next_action` verbatim; `next_action` moves from running dry-runs to reviewing drafts; exactly one CV artifact exists per program output directory and its rendered evidence set equals the plan's `evidence_priorities`; and the shared catalog `retrieved_at` is refreshed (or an evaluation `catalog_freshness` note explains why it is older). These invariants are checked by `verify:consistency`, `verify:live-real`, and `verify:generated`, which also proves every committed generated workspace re-renders byte-for-byte from the deterministic runners.
