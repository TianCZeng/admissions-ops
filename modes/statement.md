# Statement Mode

Use this mode to create or revise the LLM-authored `statement_plan`, statement
draft, and claim map consumed by the deterministic statement packager. The
agent authors the prose and strategy; `npm run statement` only validates,
packages, links, and preserves review status.

## Inputs

Required:

- evaluated program report;
- normalized student evaluation at
  `students/{student-id}/evaluations/<program-id>.yml`;
- `students/{student-id}/statement-brief.md`;
- `students/{student-id}/evidence.yml`;
- `students/{student-id}/master-cv.md`;
- official document instructions from the evaluated record and referenced
  catalog facts.

Catalog-only records and raw inbox entries are not valid statement inputs.
The tailored CV/resume artifact is not a factual input.

## Supported Statement Types

- `statement_of_purpose`
- `personal_statement`

Select `statement_of_purpose` when official instructions ask for a statement of
purpose, statement of objectives, academic statement, research statement, or
equivalent purpose-focused document.

Select `personal_statement` when official instructions ask for a personal
statement, personal history, autobiographical statement, motivation statement
centered on background, or equivalent personal-context document.

If official instructions are missing, ambiguous, or conflicting, record an
unresolved question and do not choose a type silently.

## Integrity Rules

- Do not invent motivation, hardship, identity, personal background, faculty
  interest, career goals, or program reasons.
- Do not change dates, grades, authorship, titles, publication status, roles,
  or ownership of work.
- Do not turn academic fit into an admissions probability.
- Do not present generic program praise as program-specific fit.
- Do not mention supervisors, labs, centers, or courses unless they come from
  official sources or the student brief and are marked for review.
- Every nontrivial claim in the plan and draft must trace to an evidence ID,
  official source, or student-brief note through `claim_map`.
- Do not use `npm run statement` as a drafting engine. It must fail when
  `draft_markdown` or `claim_map` is missing.

## Statement Plan Contract

The normalized evaluation must contain a substantive `statement_plan`,
body-only LLM-authored draft, and claim map before `npm run statement`
packages anything:

```yaml
statement_plan:
  statement_type: statement_of_purpose
  prompt_source_url: https://example.edu/program/documents
  prompt_text: "Upload a statement of purpose..."
  word_limit: 1000
  page_limit: null
  strategy_summary: "Program-specific strategy grounded in evidence and brief."
  core_argument: "Central truthful argument for this program and applicant."
  paragraph_plan:
    - purpose: "Academic preparation for the target field"
      evidence_ids:
        - research-example-1
      program_sources: []
      brief_inputs:
        - "Why graduate study now"
    - purpose: "Program-specific fit"
      evidence_ids:
        - project-example-1
      program_sources:
        - https://example.edu/program/research
      brief_inputs:
        - "Program-Specific Notes"
  required_program_terms:
    - "human-computer interaction"
  claims_to_avoid:
    - "Do not describe unpublished work as published."
  unresolved_questions:
    - "Confirm whether the portal expects SOP or PS wording."
  review_status: Review Required
  draft_markdown: |
    Body-only applicant statement prose authored by the agent. Do not include
    packaging metadata here; the deterministic packager adds title, review
    status, and the final review disclaimer.
  claim_map:
    - claim_id: claim-research-1
      claim_summary: "Draft describes the student's research preparation."
      source_type: evidence
      evidence_id: research-example-1
      protected_facts:
        - "Exact project title from evidence.yml"
        - "Exact date or status when mentioned"
    - claim_id: claim-program-1
      claim_summary: "Draft references an official program research area."
      source_type: official_program_source
      source_url: https://example.edu/program/research
    - claim_id: claim-brief-1
      claim_summary: "Draft uses the student's stated goal."
      source_type: student_brief
      brief_section: "Why graduate study now"
```

Minimum requirements:

- `statement_type` is supported and matches official instructions;
- `prompt_source_url` exists, or unresolved questions explain why it cannot be
  preserved yet;
- `prompt_text` or `prompt_summary` exists;
- official word/page limits are captured when provided;
- `strategy_summary` and `core_argument` are program-specific and substantive;
- `paragraph_plan` has at least three entries and at least one program-specific
  entry;
- all `evidence_ids` exist in the selected student's `evidence.yml`;
- `draft_markdown` contains the LLM-authored statement body and must not claim
  final, ready, submitted, or externally safe status;
- `claim_map` has one entry per nontrivial draft claim and uses only
  `evidence`, `official_program_source`, or `student_brief` source types;
- evidence claims use existing evidence IDs, official-source claims use URLs
  present in the evaluated official sources, and brief claims use real
  `statement-brief.md` sections;
- protected facts listed in mapped claims must appear exactly as written in the
  draft;
- `review_status` is exactly `Review Required`.

## Deterministic Packager/Validator

Use:

```text
npm run statement -- --student <student-id> --program <program-id>
```

Default behavior is a dry-run under:

```text
validation-output/dry-run/statement/{student-id}/{program-id}/
```

Use `--write` only after reviewing the dry-run, or when the full program
pipeline was invoked with `--write-drafts` and the agent has inspected a
successful dry-run:

```text
npm run statement -- --student <student-id> --program <program-id> --write
```

Approved write mode may create or refresh only:

```text
students/{student-id}/output/{program-id}/statement-plan.md
students/{student-id}/output/{program-id}/statement-draft.md
students/{student-id}/output/{program-id}/statement-evidence-map.yml
students/{student-id}/output/{program-id}/statement-change-log.md
```

and may refresh only the report `Statement` link block and tracker `Statement`
column. It must not mutate `statement-brief.md`, `master-cv.md`, `evidence.yml`,
eligibility/fit/CV fields, or mark any statement final.

The packager preserves `statement_plan.draft_markdown` prose except for
controlled wrappers: title, `Review Required` metadata, and the review-required
disclaimer. It rejects missing drafts, missing claim maps, unsupported source
types, broken evidence/source/brief references, protected-fact mismatches,
official word/page overflows, unsafe readiness language, and retired
deterministic-renderer phrases.

## Review Bundle

Return:

- official prompt source and retrieval context;
- selected statement type and why;
- statement plan summary;
- confirmation that the LLM-authored draft was packaged without prose rewrite;
- evidence IDs used and omitted;
- brief sections used;
- generated dry-run paths;
- word/page count;
- unresolved questions and claims to avoid;
- confirmation that every artifact remains `Review Required`.
