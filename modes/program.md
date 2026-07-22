# Program Evaluation Mode

Use this mode to run one official program URL or one selected entry from
`programs/inbox.yml` through the full one-program draft pipeline.

## Inputs

Required:

- official program URL or inbox entry;
- `students/{student-id}/profile.yml`;
- `students/{student-id}/preferences.yml`;
- `students/{student-id}/evidence.yml`;
- `students/{student-id}/master-cv.md`.

Optional:

- `students/{student-id}/statement-brief.md` when official instructions require
  a statement of purpose or personal statement;
- `--write-drafts` when the user wants the agent to write draft CV/resume and
  statement artifacts immediately after successful dry-runs.

Student-specific eligibility, fit, evidence references, reports, checklists,
tracker rows, and outputs belong under `students/{student-id}/`. Shared
official program facts belong in `programs/catalog/{program-id}.yml` and must
not contain student evidence references or fit judgements.

If evaluating a fictional fixture, load the matching files under `examples/`.

## Procedure

1. Confirm the unit of work: institution, program, degree type, intake, and
   applicant category when material.
2. Read official sources and record retrieval date.
3. Extract deadline, application URL, requirements, document instructions, and
   source URLs.
4. Build the eligibility matrix using shared eligibility values and the
   judgement rules in `modes/_shared.md`: unverified test sub-scores or
   component minimums create verification tasks (never a bare `met`), and
   deadlines, intake availability, and required-document existence are
   checklist or freshness items, not eligibility rows.
5. Build the fit assessment using shared fit dimensions.
6. Identify stale, missing, or conflicting source evidence.
7. Create manual verification tasks for every unresolved hard requirement.
8. Draft or revise a substantive academic CV or admissions resume adaptation
   plan using the requirements in `modes/cv.md`.
   When official instructions require a statement, draft or revise a
   `statement_plan`, LLM-authored statement draft, and structured claim map
   using `modes/statement.md`; do not package a statement until
   `statement-brief.md` exists.
9. Write the report under `students/{student-id}/reports/{###}-{institution-slug}-{YYYY-MM-DD}.md`.
10. Add or update the row in `students/{student-id}/tracker.md`. Every cell
    derives from the evaluation record; copy `next_action` and
    `eligibility_summary` verbatim into the Next Action and Eligibility cells
    (the deterministic writers rewrite Next Action from the evaluation on
    every run, and `verify:consistency` rejects any difference).
11. Create or update a checklist under `students/{student-id}/checklists/` when action
    items exist.
12. Run `npm run cv -- --student <student-id> --program <program-id>` as the
    deterministic dry-run renderer and validator.
13. Inspect the dry-run artifact, report and tracker links, change log,
    evidence map, evidence used, evidence omitted, review status, and
    validation concerns.
14. If a statement plan, LLM-authored draft, and claim map are in scope and
    `statement-brief.md` exists, run
    `npm run statement -- --student <student-id> --program <program-id>` and
    inspect its packaged dry-run links, evidence map, word/page count, and
    unresolved questions.
15. If the user specified `--write-drafts` and the dry-runs succeeded without
    blockers, rerun the applicable deterministic renderer or packager with
    `--write`:
    `npm run cv -- --student <student-id> --program <program-id> --write` and,
    when statement output is in scope,
    `npm run statement -- --student <student-id> --program <program-id> --write`.
16. Return one final review bundle with official sources, retrieval date,
    eligibility, fit, unknown tasks, generated paths, document type, evidence
    used, evidence omitted, and blockers or questions.

Do not pause between evaluation and CV/resume dry-run unless a truthful draft
is blocked by missing selected-student files, inaccessible official pages,
ambiguous program identity or intake, unresolved official-source conflict, or
the need for explicit approval before writing user-owned output.
`--write-drafts` is explicit approval only for draft artifact writes after
successful dry-runs. It must not be used to skip dry-run inspection, overwrite
source inputs, or mark any artifact final.

After a successful `--write-drafts` run, leave one coherent post-write state:

- the evaluation's `tailored_cv` and `statement` fields, the report CV/Statement
  links, and the tracker CV/Statement columns all point at the same
  `Review Required` drafts (the deterministic writers persist these together);
- exactly one CV artifact exists under `output/<program-id>/` — the renderer
  deletes the other type's file on a document-type change;
- set `next_action` to a review action (for example, review the drafts and
  resolve open hard-gate tasks); never leave it telling the user to run dry-runs
  that already ran; the tracker Next Action cell equals `next_action` verbatim
  because the deterministic writers rewrite it from the evaluation;
- because the pipeline retrieves official sources, refresh the shared
  `programs/catalog/<program-id>.yml` record so its `retrieved_at` is not older
  than this evaluation, or add a `catalog_freshness` note to the evaluation that
  cites the older catalog date and explains it.

`verify:consistency` and `verify:live-real` reject drift in these fields.

## Report Sections

Use exactly these sections:

```text
A. Program and intake summary
B. Source and deadline verification
C. Formal eligibility matrix
D. Academic and research fit
E. Competitiveness, gaps, and mitigation
F. Practical constraints
G. Academic CV adaptation plan
H. Remaining application package and action plan
I. Questions for the university or potential supervisor
```

## Persistence Rules

- Report filenames use a three-digit number, institution slug, and date.
- Tracker rows use one row per institution, program, degree type, and intake.
- Do not duplicate a row when applicant category does not change official
  requirements or deadlines.
- Reports and checklists live under the selected student root; shared catalog
  records remain reusable across students.
- Unknowns must appear both in the report and checklist.
- Human review is the final gate before any generated artifact is marked ready
  or externally submitted.
