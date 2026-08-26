# Shared Admissions Policy

This file contains reusable policy for admissions modes. User-specific academic
history and preferences belong in the selected `students/{student-id}/`
workspace, not here.

## Output Language

Two rules. Both are fixed: there is no configuration key for either, and there
is no way for a user to request a non-English artifact from this repository.

**Artifacts are English.** Reports, checklists, tracker cells, CV/resume prose,
statement drafts, and summaries. The chat language never reaches an artifact.

**Chat is the user's language.** If the user writes to you in Chinese, every
word you address to them is Chinese from your first sentence onward — progress
narration, preambles, `I'll start by…` lines, descriptions of what you are
about to read or run, plans, findings, and questions included. A mixed-language
turn follows the user's own prose, not the command scaffold, the flags, or the
URL: `/admissions-ops program --write-drafts for student x:` followed by one
Chinese sentence is a Chinese turn. Never open in English and switch later.

- **Subagents.** Prepend both rules verbatim to every subagent prompt. A
  worker does not inherit the parent's rule.
- **Program conflict.** If an official source requires a statement or CV in a
  language other than English, this repository cannot produce it. Record the
  conflict in the report and say so. Never switch the artifact language.
- **Diagnostics.** Machine output from `npm run *` stays English in logs and in
  quoted error text. Restate it in the user's language when explaining it in
  chat; do not translate the error string itself.

"English" here means script, not ASCII. `Saarbrücken`, `Kovač`, and `naïve` are
valid English-document content. The deterministic guards reject Chinese,
Japanese, and Korean script only.

## Required Sources

Before evaluating a real program, load only:

- `students/{student-id}/profile.yml`
- `students/{student-id}/preferences.yml`
- `students/{student-id}/evidence.yml`
- `students/{student-id}/master-cv.md`
- `students/{student-id}/statement-brief.md` when statement drafting is in scope
- `students/{student-id}/evaluations/`, reports, tracker, checklists, and
  output for student-specific state
- `programs/catalog/` for shared official-source program facts when the
  student evaluation references `catalog_id`

If user files do not exist, use `.example.*` files only to explain setup or run
fictional fixture checks.

## Official Source Rules

Use official sources in this order:

1. official program page;
2. official graduate school or admissions page;
3. official department, lab, or supervisor page;
4. official scholarship or funding page when relevant;
5. official application portal;
6. third-party pages only as discovery leads.

Every report must preserve:

- official URL;
- retrieval date;
- intended intake;
- applicant category, if material;
- source URL for deadlines and hard requirements when different from the main
  program URL.

## Eligibility Values

Use only these values:

- `met`
- `likely_met`
- `not_met`
- `unknown`
- `not_applicable`

Check at least:

- prior degree level and subject;
- minimum grade or GPA wording;
- prerequisite coursework or credits;
- language-test thresholds and sub-scores;
- standardized tests;
- supervisor confirmation, if required;
- residency or applicant-category restrictions;
- deadline and intake availability;
- required documents.

`unknown` must create a manual verification task.

Judgement rules for the matrix:

- A language or standardized-test gate may be `met` only with cited evidence.
  An unverified sub-score or component minimum (for example an IELTS Writing
  band the program has not confirmed as sufficient) stays `unknown` or
  `likely_met` with a verification task — never a bare `met`. The
  deterministic consistency check rejects a test gate marked `met` with
  `evidence: none`.
- Deadlines, intake availability, and required-document existence are
  logistics: track them in the deadline fields, freshness warnings, and
  checklist action items, not as applicant-side eligibility rows with
  placeholder evidence.
- The evaluation's coarse `eligibility_summary` uses exactly one of
  `eligible`, `likely`, `unclear`, or `ineligible` (the report header and
  tracker Eligibility cell mirror it); the five per-gate values above stay
  row-level.
- [Human required] When one student is evaluated against several programs,
  review the English/test gates across those evaluations for consistent
  judgement; legitimate per-program rules differ, so this is a review step,
  not a mechanical comparison.

## Fit Dimensions

Keep fit separate from eligibility. Score fit from 1.0 to 5.0 with visible
reasoning across:

- academic preparation;
- research or subject fit;
- evidence strength;
- goal alignment;
- admissions feasibility;
- practical constraints;
- application effort.

Weights may come from the selected student's preferences file. Do not present
the score as an admissions probability.

## Confidence And Freshness

Track:

- source confidence: `high`, `medium`, or `low`;
- retrieval date;
- whether the deadline belongs to the intended intake;
- conflicting official sources;
- requirements needing manual confirmation.

Stale pages, missing deadline years, and conflicting official pages must be
called out directly.

## Report Header

Use this header for program reports:

```markdown
# Program Evaluation: {Institution} - {Program}

**Intake:** {term/year}
**Applicant category:** {category or not applicable}
**Official URL:** {url}
**Retrieved:** {YYYY-MM-DD}
**Deadline:** {date/state}
**Eligibility:** {eligible/likely/unclear/ineligible}
**Fit score:** {X/5}
**Evidence confidence:** {high/medium/low}
**Tailored CV:** {path or pending}
**Statement:** {path or pending}
```

## Document Integrity

Academic CV and admissions resume generation must use only the selected
student's `evidence.yml` and `master-cv.md`.

Never change dates, grades, authorship, publication status, titles, or the
substantive meaning of evidence. Tailoring may select, reorder, condense, and
mirror program terminology when factually equivalent.

Statement drafting must use only `evidence.yml`, `master-cv.md`, official
program facts, and the student's `statement-brief.md`. The agent authors the
statement prose and claim map; the deterministic statement command only
packages and validates them. Do not invent personal background, motivation,
hardship, supervisors, labs, courses, career goals, or program reasons. Every
nontrivial statement claim must trace to an evidence ID, official source, or
statement-brief note.

## Evidence Language At Rest

`students/{student-id}/evidence.yml` holds English. This is a refinement of the
Document Integrity rule above: a translated course title *is* a changed title,
and a free translation of an award name is an unsourced factual claim about a
transcript the reviewer may hold in the original.

1. The agent may draft the English strings in chat — that is what chat is for —
   but never writes a self-translated proper noun into a stored record on its
   own authority. Propose the wording, let the user commit it.
2. Where the institution publishes an official English name, use that name and
   cite the source. This is the same official-source rule the repository already
   applies to program facts.
3. Never translate a grade, a scale, or a credential level. The NUS CAP
   no-conversion rule in `students/nus-cs/preferences.yml` extends to a Chinese
   percentage scale or a 学士/硕士 credential. Record the local scale as
   published and let the program apply its own equivalence rules.
4. A user-supplied translation of a proper noun is a verification task in the
   program checklist, not a settled fact. The checklist is rendered from the
   evaluation's `action_items`, so the task belongs there; an
   `unresolved_questions` entry in a CV or statement plan does not reach the
   checklist. When intake happens before any program is evaluated, carry the
   task into the first evaluation's `action_items`.

The original may be preserved next to the English string in a field the renderer
never reads — `original_title`, `original_name`, `original_issuer` — so a
reviewer can check the translation. The CV preflight gates only the fields that
reach a generated document, so those keys are safe.
