# Inbox Mode

Use this mode to inspect curated official program entries.

## Sources

Read `programs/inbox.yml` when it exists. If it does not exist, read `programs/inbox.example.yml` and explain that the user should create `programs/inbox.yml` for real entries.

## Entry Contract

Each entry should include:

- `id`
- `institution`
- `program`
- `degree_type`
- `intake`
- `official_url`
- `enabled`
- `notes`

Optional fields:

- `country`
- `department`
- `applicant_category`
- `application_url`
- `retrieved_at`
- `source_confidence`

## Procedure

1. List enabled entries first.
2. Flag missing required fields.
3. Flag duplicate identities.
4. Recommend the next unevaluated enabled entry.
5. Do not evaluate programs in this mode unless the user explicitly asks to run `program`.
