---
name: admissions-ops
description: Graduate admissions command center -- evaluate programs, adapt academic CVs, compare options, and track applications
arguments: mode
user_invocable: true
user-invocable: true
argument-hint: "[program | inbox | compare | cv | statement | tracker] [--write-drafts]"
license: MIT
---

# admissions-ops Router

## Mode Routing

Determine the mode from `$mode`:

| Input | Mode |
|---|---|
| empty | `discovery` |
| official program URL | `program` |
| `program` | `program` |
| input beginning with `program`, including `--write-drafts` | `program` |
| `inbox` | `inbox` |
| `compare` | `compare` |
| `cv` | `cv` |
| `statement` | `statement` |
| `tracker` | `tracker` |

If `$mode` is not recognized but contains an official university or department
program URL, route to `program`.

## Discovery Mode

Show this menu:

```text
admissions-ops

Available commands:
  /admissions-ops {official URL}  Run the one-program draft pipeline
  /admissions-ops program         Run one URL or selected inbox entry through the draft pipeline
  /admissions-ops inbox           Review curated entries in programs/inbox.yml
  /admissions-ops compare         Compare evaluated programs only
  /admissions-ops cv              Create an academic CV or resume adaptation plan
  /admissions-ops statement       Create a statement plan and draft for a reviewed program
  /admissions-ops tracker         Review tracker and checklist state
```

Runtime commands that read or write applicant-specific live state require
`--student <student-id>` and use `students/{student-id}/`.
For the `program` workflow, `--write-drafts` is explicit user approval to write
`Review Required` CV/resume and statement draft artifacts after successful
dry-runs; it is not approval to mark anything final or externally ready.

## Full Pipeline Default

The default `program` workflow is one agent-led draft pipeline:

1. read the selected `students/{student-id}/` workspace;
2. retrieve and cite official sources for the selected program only;
3. write or update shared catalog facts and the student-scoped evaluation,
   report, checklist, and tracker row;
4. create or revise the LLM-authored CV/resume adaptation plan and, when
   official instructions require a statement and `statement-brief.md` exists,
   the LLM-authored `statement_plan`, statement draft, and claim map;
5. run `npm run cv -- --student <student-id> --program <program-id>` as the
   deterministic dry-run renderer and validator (append
   `--document-type academic_cv|admissions_resume` when the user explicitly
   overrides the plan's document type; the override is logged and, on write,
   persisted into the plan);
6. when a statement plan, LLM-authored draft, and claim map are in scope and
   `statement-brief.md` exists, run
   `npm run statement -- --student <student-id> --program <program-id>` as the
   deterministic dry-run packager and validator;
7. inspect the dry-run artifacts, links, evidence maps, and validation
   concerns;
8. if the user specified `--write-drafts` and the dry-runs succeeded without
   blockers, rerun the applicable deterministic renderer or packager with
   `--write` to refresh only `Review Required` draft artifacts and
   report/tracker links;
9. return one final review bundle.

Stop mid-pipeline only for a real blocker: missing selected-student files,
inaccessible official sources, ambiguous program identity or intake,
conflicting official requirements that prevent a truthful draft, or explicit
approval before any `--write` operation. A user-specified `--write-drafts`
flag is that approval only for post-dry-run draft artifact writes.

## Context Loading

For `program`, `compare`, `cv`, `statement`, and `tracker`, read:

- `AGENTS.md`
- `DATA_CONTRACT.md`
- `modes/_shared.md`
- `modes/{mode}.md`

For `inbox`, read:

- `AGENTS.md`
- `modes/inbox.md`
- `programs/inbox.yml` if it exists, otherwise `programs/inbox.example.yml`

Execute the selected mode instructions. Do not run broad discovery unless a
future mode explicitly implements it.
