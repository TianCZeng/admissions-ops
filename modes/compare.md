# Compare Mode

Use this mode to compare evaluated normalized programs. Do not compare raw inbox entries that do not yet have normalized records and reports.

## Required Inputs

- two or more normalized records under `students/{student-id}/evaluations/`;
- matching reports under `students/{student-id}/reports/`;
- matching tracker rows in `students/{student-id}/tracker.md`, or explicit `--sync-tracker`;
- student preferences from `students/{student-id}/preferences.yml`.

Read only the selected student's evaluations, reports, tracker, output, and preferences under `students/{student-id}/`. Student evaluations may merge shared facts from `programs/catalog/`, but catalog-only records and raw inbox entries are not comparable.

## Runner

Use:

```text
npm run compare -- --student <student-id> --program <program-id> --program <program-id>
```

Optional flags:

- `--student <student-id>` selects the required live applicant workspace under `students/{student-id}/`.
- `--date YYYY-MM-DD` fixes the comparison report date.
- `--workspace <path>` reads another repo-local or validation workspace.
- `--sync-tracker` adds missing tracker rows from normalized evaluations.
- `--write` explicitly writes comparison files to the selected workspace.

Default behavior is a dry-run. Dry-runs write only under `validation-output/dry-run/compare/{student-id}/`. Write mode may create or refresh:

- the selected student's `reports/comparison-{YYYY-MM-DD}.md`;
- the selected student's comparison checklist;
- missing tracker rows when `--sync-tracker` is present.

## Comparison Dimensions

Compare:

- eligibility result;
- fit score and reasoning;
- source confidence;
- deadline pressure;
- application effort;
- practical constraints;
- unresolved verification tasks;
- CV or resume readiness.

## Labels

Allowed planning labels:

- `ambitious`
- `realistic`
- `lower-risk`

Every label needs visible reasoning. Labels are planning shorthand only and must not imply admissions odds or guaranteed outcomes.

## Checklist

Comparison checklists must include item, status, due date or `unknown`, source, and notes. Preserve unknown requirements and unknown due dates; do not invent dates from deadline pressure.
