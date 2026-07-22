# Tracker Mode

Use this mode to inspect or update `students/{student-id}/tracker.md` and
per-program checklists in `students/{student-id}/checklists/`.

## Tracker Columns

Use this table shape:

```markdown
| # | Institution | Program | Degree | Intake | Deadline | Eligibility | Fit | Status | CV | Report | Next Action | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
```

## Status Values

Use statuses from `templates/states.yml`.

## Checklist Shape

Per-program checklists live under `students/{student-id}/checklists/` and use:

```markdown
# Checklist: {Institution} - {Program} - {Intake}

| Item | Status | Due | Source | Notes |
|---|---|---|---|---|
```

## Procedure

1. Parse tracker rows by header name.
2. Flag invalid statuses.
3. Flag missing report links for evaluated rows.
4. Flag missing CV links for rows marked ready for review.
5. Flag duplicate program identities.
6. Summarize next actions by deadline pressure.
