# admissions-ops Agent Instructions

> **Using this repo, or building it?** This file is the runtime policy for
> *using* admissions-ops — evaluating programs and adapting application
> materials against real student data. If you are instead *contributing to or
> extending* this repository, this file is not your guide: start from
> `CONTRIBUTING.md`. The two jobs do not share a playbook, so don't read the
> policy below as a construction spec.

This repository supports graduate admissions evaluation and application
material adaptation. Work locally, preserve source evidence, and keep the user
as the final reviewer for every external submission.

## Core Workflow

The MVP workflow is:

1. read a curated official program URL or an entry from `programs/inbox.yml`;
2. retrieve and summarize official source evidence;
3. separate hard eligibility from academic fit;
4. write a sourced report under `students/{student-id}/reports/`;
5. create or update the tracker row in `students/{student-id}/tracker.md`;
6. create a per-program checklist when action items exist;
7. generate an academic CV or admissions resume adaptation plan before any
   final artifact is marked ready;
8. when statements are in scope, create a sourced `statement_plan`, an
   LLM-authored statement draft, and a structured claim map before any
   deterministic statement packaging runs;
9. run deterministic CV/resume dry-renders and statement packager dry-runs
   during the full program pipeline when their prerequisites exist.

Do not broaden discovery before the one-program evaluation and CV adaptation
workflow is reliable.

## Source Hierarchy

Use official sources in this order:

1. official program page;
2. official graduate school or admissions page;
3. official department, lab, or supervisor page;
4. official scholarship or funding page when funding is in scope;
5. official application portal;
6. third-party pages only as leads, never as final proof.

Every evaluated program must preserve the source URL and retrieval date.
Deadlines and hard requirements need source URLs when they come from different
pages.

## User Layer

Never overwrite user files without explicit instruction:

- `programs/inbox.yml`
- `programs/evaluations/*`
- `programs/checklists/*`
- `reports/*`
- `output/*`
- `students/*/profile.yml`
- `students/*/preferences.yml`
- `students/*/evidence.yml`
- `students/*/master-cv.md`
- `students/*/statement-brief.md`
- `students/*/evaluations/*`
- `students/*/tracker.md`
- `students/*/reports/*`
- `students/*/checklists/*`
- `students/*/output/*`

Shared official-source program catalog records live under
`programs/catalog/*`. They may contain program facts and source provenance, but
must not contain student evidence references, fit judgements, tracker state, CV
plans, or generated artifact links.

Example files ending in `.example.*` and fictional fixtures under `examples/`
are safe system references.

## Admissions Judgement Rules

- Eligibility is a hard-gate matrix with `met`, `likely_met`, `not_met`,
  `unknown`, or `not_applicable`.
- Fit is a separate planning judgement and must not be presented as an
  admissions probability.
- Unknown facts create verification tasks.
- Stale intake pages, missing deadline years, and conflicting official pages
  must be surfaced in the report.
- Portfolio labels such as `ambitious`, `realistic`, and `lower-risk` are
  allowed only with visible reasoning.

## Document Integrity

Tailored academic CVs, admissions resumes, and statement drafts must be derived
from the selected student workspace's canonical source files.

Allowed transformations:

- reorder sections and bullets;
- select relevant evidence;
- condense wording;
- mirror program terminology when factually equivalent;
- add a program-specific research-interest summary;
- omit unrelated evidence from a short resume.

Never change dates, grades, authorship, publication status, titles, or the
meaning of evidence. Never mutate the selected student's `master-cv.md` during
tailoring.

Statement drafts may additionally use `statement-brief.md` for
student-authored narrative preferences. Do not invent motivation, hardship,
identity, personal background, supervisors, labs, courses, career goals, or
program reasons. Every nontrivial statement claim must trace to an evidence ID,
official source, or statement-brief note. Statements must remain marked
`Review Required` until human review.

## Language

Two rules. Both are fixed and neither has a configuration key.

**Chat is the user's language.** Conversation follows the language the user
writes in, from your first sentence onward — progress narration, preambles,
descriptions of what you are about to read or run, plans, findings, and
questions included. A turn that mixes an English command scaffold, flags, or a
URL with one sentence of the user's own prose follows that prose. Never open in
English and switch later.

**Every generated artifact and every stored student record is English**:
reports, checklists, tracker cells, CV and resume prose, statement drafts,
summaries, and the contents of `students/*/evidence.yml`. The chat language
never reaches an artifact.

"English" here means script, not ASCII. `Saarbrücken`, `Kovač`, and `naïve` are
valid English-document content and must keep working end to end; the
deterministic guards reject Chinese, Japanese, and Korean script only. The CV
renderer sets the document language to `en` and the templates ship no CJK font
stack, so CJK that reached a document would render as unreadable boxes rather
than pass review.

If an official source requires a statement or CV in a language other than
English, this repository cannot produce it. Record the conflict in the report;
never switch the artifact language.

Non-English source evidence is handled at intake, not at render time:

- The agent may draft English strings in chat, but never writes a
  self-translated proper noun into a stored record on its own authority.
- Where the institution publishes an official English name, use it and cite the
  source.
- Never translate a grade, a scale, or a credential level. The NUS CAP
  no-conversion rule extends to a Chinese percentage scale or a 学士/硕士
  credential.
- A user-supplied translation of a proper noun is a verification task in the
  checklist, not a settled fact. It is recorded in the evaluation's
  `action_items`, which is what the checklist is rendered from. The original may
  be kept in a field the renderer never reads, such as `original_title`.

## Agent Authorship And Deterministic Guards

Substantive judgement is authored by the agent, not by scripts. This includes
eligibility calls, fit reasoning, evidence selection and priorities, document
type, tailored summaries, next actions, and all prose. The agent records these
decisions in the report, the evaluation record, and the CV/statement plans.

The deterministic commands (CV/statement renderers, `npm run *`, and every
`verify:*` validator) are a serialization-and-guard boundary. They may:

- select, order, and render exactly what the agent's plan specifies;
- check schemas, links, statuses, evidence traceability, page limits, and
  cross-artifact consistency; and
- fail with a clear preflight error when a required agent decision is missing or
  malformed.

They must not invent, re-rank, paraphrase, or override agent-authored content,
and must not silently substitute a heuristic where the agent has already
recorded a decision. A guard rejects bad input; it never rewrites it. When a
decision is absent, stop and surface it rather than fabricating a fallback.

Document-type choice has one override channel:
`cv_adaptation_plan.document_type` (with a `document_type_rationale` when it
overrides the official instructions) plus the user-facing `--document-type`
CLI flag. `document_instructions` always stays a faithful transcription of the
official text; editing it to force a document type is rejected by the
preflight.

## Commands

The skill router in `.agents/skills/admissions-ops/SKILL.md` supports these
initial modes:

- `program`: evaluate one official program URL or selected inbox entry;
- `inbox`: inspect curated program entries;
- `compare`: compare evaluated programs only;
- `cv`: create an academic CV or admissions resume adaptation plan;
- `statement`: create a statement of purpose or personal statement plan and
  LLM-authored draft;
- `tracker`: inspect or update admissions tracking state.

The deterministic live CV runner requires an explicit student workspace:

```text
npm run cv -- --student <student-id> --program <program-id> [--document-type academic_cv|admissions_resume]
```

It reads `students/{student-id}/evaluations/<program-id>.yml`. Dry-runs write
under `validation-output/dry-run/live/{student-id}/`; approved writes may
update only draft files under the selected `students/{student-id}/output/`
(keeping exactly one CV artifact per program — the other type's file is
deleted in the same run), the report CV links, the tracker CV column, the
tracker Next Action cell (rendered from the evaluation's `next_action`), the
evaluation's `tailored_cv` status field, and — when `--document-type`
overrides the plan — the plan's `document_type` and rationale. Generated
artifacts must remain marked `Review Required`.

For the full `program` pipeline, a user-specified `--write-drafts` flag is
explicit approval for the agent to run successful dry-renders or statement
packager dry-runs first, inspect them, and then rerun the applicable CV/resume
renderer or statement packager with `--write`. It is not approval to mark
artifacts final or submit externally.

The deterministic statement packager/validator also requires an explicit
student workspace:

```text
npm run statement -- --student <student-id> --program <program-id>
```

It reads `students/{student-id}/statement-brief.md`,
`students/{student-id}/evidence.yml`, `students/{student-id}/master-cv.md`, and
`students/{student-id}/evaluations/<program-id>.yml`. The evaluation must
contain `statement_plan.draft_markdown` and `statement_plan.claim_map` created
by the agent workflow; Node does not draft or rewrite statement prose. Dry-runs
write under `validation-output/dry-run/statement/{student-id}/`; approved
writes may update only statement draft files under the selected
`students/{student-id}/output/`, the report Statement link, the tracker
Statement column, and the evaluation's `statement` status field.

## Post-Write Synchronization And Freshness

After an approved CV or statement write, the selected student evaluation,
report, and tracker must agree:

- the evaluation's `tailored_cv` / `statement` fields, the report links, and the
  tracker columns all point at the same generated draft and carry
  `Review Required`;
- exactly one CV artifact exists under `output/<program-id>/`, and its type
  matches `cv_adaptation_plan.document_type`;
- `next_action` reflects the post-write state (review the drafts and resolve
  open hard-gate tasks) and never tells the user to run dry-runs that already
  ran; the tracker Next Action cell equals it verbatim because the
  deterministic writers render it from the evaluation;
- the rendered evidence set equals the plan's `evidence_priorities` exactly;
- whenever a full program pipeline retrieves official sources, the shared
  `programs/catalog/<program-id>.yml` record is refreshed so its `retrieved_at`
  is not older than the student evaluation, or the evaluation carries a
  `catalog_freshness` note that cites the older catalog date and explains it.

These rules are enforced deterministically by `verify:consistency`,
`verify:live-real`, and `verify:generated`, which also re-renders every
committed generated workspace and rejects hand-edited output.
