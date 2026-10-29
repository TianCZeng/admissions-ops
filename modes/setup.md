# Setup Mode

Use this mode to turn a student's CV or transcript into a workspace the `program` pipeline can run on. After setup, `program` comes next.

## Inputs

- the student ID the user gives (`$admissions-ops setup for student <student-id>`); it must be path-safe, and `npm run init` rejects one that is not;
- the student's source documents in `students/{student-id}/raw/`: a CV, a transcript, a degree certificate. When the user gives a path instead, copy the file into `raw/` first. `raw/` stays gitignored even in a private copy that tracks the workspace, so source documents never go anywhere else in the repository;
- the user, in conversation, for everything the documents do not say.

Nothing else is needed. Do not ask for passports, financial records, recommendation letters, or portal exports.

## May Write

- `students/{student-id}/profile.yml`
- `students/{student-id}/preferences.yml`
- `students/{student-id}/evidence.yml`
- `students/{student-id}/master-cv.md`
- `students/{student-id}/tracker.md`, through `npm run init` only
- `students/{student-id}/statement-brief.md`, only from the student's own words (see Statement Brief below)
- a copy of a source document the user named, into `students/{student-id}/raw/`

Nothing else. Evaluations, reports, checklists, and output belong to `program`.

## Procedure

1. Run `npm run init -- --student <student-id>`. It copies the example inputs and an empty tracker into the workspace and accepts an existing `raw/`. If it refuses because the files already exist, do not work around it: read what is there, fill only the files `npm run check` reports as still holding example content, and change a file the student already wrote only when the user asks for that change.
2. Read the source documents in `raw/` and work out what goes into `profile.yml`, `evidence.yml`, and `master-cv.md`, keeping the keys of the matching `students/*.example.*` file. Write nothing yet:
   - `profile.yml` holds identity and contact (`student.name`, `email`, `location` appear on every generated CV), current education, language-test status, and standardized tests. Ask before putting an email address or a location on it;
   - `evidence.yml` holds one entry per degree, course, research item, project, award, publication, presentation, teaching role, or service role. Every entry gets an `id` that is unique across the file, prefixed by its kind (`edu-`, `course-`, `research-`, `project-`, `award-`, and so on), because CV plans select evidence by ID;
   - `master-cv.md` is the same record as a plain markdown CV. Later tailoring reads it and never changes it.
3. Ask, in one message, for what no document can answer and for everything you could not read word for word: the intended intake term and year, target countries or regions, degree types, target fields, and constraints for `preferences.yml`, plus any illegible line, unstated grading scale, unexplained abbreviation, or translation the user has to commit. Leave an unanswered fact out, or mark it `unknown` where the example shows a status field. A missing fact is a question, never a guessed value. Then end your turn and wait for the reply. Ask in your own message, not through a tool that lets you carry on before the answer arrives.
4. Once the user has answered, write the files and run `npm run check -- --student <student-id>`. It is read-only and names the file and the entry for every problem. Fix the files and run it again until it passes. Never remove true evidence to make it pass.
5. Ask the user to read `evidence.yml` before anything else, because every CV, resume, and statement is built from it and an error there reaches all of them. Then give the `program` prompt with the student ID and, when `preferences.yml` holds one intake, that intake filled in:

   ```text
   $admissions-ops program for student <student-id>:
   <official university or department program URL>

   Run the full one-program admissions pipeline for the intended intake <term/year>.
   ```

## Intake Rules

`AGENTS.md` → Language and `modes/_shared.md` → Evidence Language At Rest apply unchanged:

- Copy dates, grades, titles, authorship, and publication or completion status exactly as the document gives them. A planned or in-progress item keeps that status.
- A date goes in the entry's own `dates` or `date` field, as written, even when the document gives only an end or expected date (`expected May 2027`). The renderer never reads `notes`, so a date kept only there is missing from every CV.
- Never convert a grade, a scale, or a credential level. Record the scale as published, for example in a `grading_context` field.
- Stored records are English. Where the institution publishes an official English name, use it and cite the page in the entry's `notes`. Otherwise propose the English wording in chat and store it only after the user commits it. Never store a proper noun you translated on your own authority.
- The original may stay beside the English string in a field the renderer never reads, such as `original_title`. `npm run check` rejects Chinese, Japanese, or Korean script only in the fields a CV puts on the page.
- A user-committed translation is not a settled fact. Say so in the entry's `notes`, and tell the user the first `program` evaluation carries it into its `action_items`, which is where the checklist comes from.
- Record no evidence the documents or the user did not state: no inferred skills, no rounded dates, no publication the user did not name.
- If reading a document means copying it, such as rendering PDF pages to images or extracting its text to a file, delete that copy before setup ends. `raw/` holds the only copy of the student's documents.

## Statement Brief

Setup does not create `statement-brief.md` by default. Its existence is what lets `program` package a statement, and its content is the student's own narrative direction, which no CV or transcript holds. Write it only when the student volunteers that direction in their own words, using the sections of `students/statement-brief.example.md`. Otherwise tell the user that a program requiring a statement needs one, and that `program` packages no statement until it exists.

## Output

The four input paths, the passing `npm run check` line, the request to read `evidence.yml`, and the filled-in `program` prompt.
