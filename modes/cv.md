# Academic CV And Admissions Resume Mode

Use this mode to create or revise the LLM-authored document adaptation plan
that the deterministic CV runner renders and validates.

## Inputs

Required:

- evaluated program report;
- normalized evaluated-program YAML record at
  `students/{student-id}/evaluations/<program-id>.yml`;
- `students/{student-id}/profile.yml` for identity and contact details only;
- `students/{student-id}/evidence.yml`;
- `students/{student-id}/master-cv.md`;
- document instructions from official program sources.

Student-scoped evaluations may reference `catalog_id`; shared facts come from
`programs/catalog/`, but academic claims must still trace only to the selected
student's `evidence.yml` or `master-cv.md`. Do not use profile details as
academic evidence.

## Document Types

Academic CV:

- multi-page when allowed;
- education and research first;
- includes publications, presentations, thesis, research methods, awards,
  teaching, service, projects, and relevant employment when present.

Graduate admissions resume:

- concise, usually one or two pages;
- selected evidence only;
- used when an institution asks for a resume or imposes a page limit.

## Procedure

1. Read document instructions and choose academic CV or admissions resume.
   `document_instructions` stays a faithful transcription of the official
   text; never record the chosen type inside it. When the chosen type differs
   from what the official text implies, record the choice in
   `cv_adaptation_plan.document_type` with a one-line
   `document_type_rationale`.
2. Map program criteria to evidence IDs from `students/{student-id}/evidence.yml`.
3. Write an adaptation plan before generating any final artifact.
4. Select and order the exact evidence IDs to render in
   `evidence_priorities`; everything not listed is omitted from the artifact.
5. Preserve factual meaning, dates, grades, authorship, titles, and statuses.
6. Write the artifact and change log under `students/{student-id}/output/` when rendering exists.
7. Link draft output paths from the report and tracker with explicit
   `Review Required` wording.
8. Mark an artifact final or ready only after human review.

## Adaptation Plan Contract

The normalized evaluation must contain a substantive `cv_adaptation_plan`
before `npm run cv` renders anything. The runner validates this minimum
contract and fails before output generation when it is missing or thin:

- `document_type` is `academic_cv` or `admissions_resume`;
- `summary` is at least 60 characters and explains the document strategy for
  this program;
- `profile_summary` is an agent-authored applicant summary line of at least
  40 characters; it is rendered verbatim as the document header line on both
  document types, so write it for the reader, not as strategy rationale. The
  renderer never substitutes its own summary when it is missing;
- `evidence_priorities` is an ordered list of at least three evidence IDs
  from the selected student's `evidence.yml`; the rendered artifact contains
  exactly this set, in this order within each section, so list every entry
  the document should carry (including at least one education ID) and nothing
  else. No duplicates. An admissions resume can only render education,
  courses, research, projects, and awards evidence;
- when `document_type` disagrees with the type the official instruction text
  or page limit implies, `document_type_rationale` records why in one line;
  the run then proceeds and the change log records the override. A structured
  `document_type` inside `document_instructions` is rejected outright.

When the runner fails this preflight, run `$admissions-ops cv` or the full
`$admissions-ops program for student <student-id>` pipeline so the agent can
make the adaptation decisions first. The deterministic runner may select,
render, link, and validate from that plan; it must not invent substantive
tailoring choices on its own.

## Document Type Override

The chosen type is, in precedence order: the CLI `--document-type` flag, then
`cv_adaptation_plan.document_type`. The type implied by the official
instruction text is a default to compare against, never a separate decision
channel. When the chosen type differs from that default, the change log
records the override, the instruction-derived type, the faithful official
text, and the rationale. On `--write`, a CLI override is persisted back into
`cv_adaptation_plan.document_type` (plus the rationale when an
instruction-derived override is in effect) so a later flag-less run
reproduces the same artifact.

Exactly one CV artifact exists per `output/<program-id>/`: the renderer
writes the chosen type (`academic-cv.html` or `admissions-resume.html`) and
deletes the other type's file in the same run, so a document-type change can
never leave a stale artifact behind.

## Live Runner

Use:

```text
npm run cv -- --student <student-id> --program <program-id>
```

Default behavior is a dry-run. This reads only `students/{student-id}/` plus shared catalog facts when
referenced, and writes the dry-run under
`validation-output/dry-run/live/{student-id}/<program-id>/`.

Use `--write` only after reviewing the dry-run, or when the full program
pipeline was invoked with `--write-drafts` and the agent has inspected a
successful dry-run:

```text
npm run cv -- --student <student-id> --program <program-id> --write
```

Approved write mode may create or refresh draft artifacts under
the selected student's `output/<program-id>/` (deleting the other CV type's
artifact so exactly one remains) and may update only the report `Tailored CV`
link block, the matching tracker `CV` column, the tracker `Next Action` cell
(rendered verbatim from the evaluation's `next_action`), the evaluation's
`tailored_cv` status field, and — on a CLI document-type override — the
plan's `document_type`/`document_type_rationale`. It must not regenerate the
full report, change other tracker columns, mutate the selected student's
`master-cv.md`, or mark any artifact final.

## Change Log

Every adaptation plan should include:

- target program;
- selected document type;
- the document-type override and its rationale, when the chosen type differs
  from what the official instructions imply;
- section order;
- evidence IDs used;
- evidence omitted;
- terminology changes;
- unresolved document questions;
- human review status.
