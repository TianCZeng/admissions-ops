const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const { runLiveCv } = require("../cli/cv");
const { runLiveStatement } = require("../cli/statement");
const { resolveWorkspace } = require("../lib/workspace");
const { validateProgramArtifacts } = require("../lib/consistency");
const { parseTracker, renderTracker } = require("../lib/program-writer");
const {
  setupSourceWorkspace,
  STATEMENT_FIXTURE_STUDENT: studentId,
  STATEMENT_FIXTURE_PROGRAM: programId,
} = require("./statement");

const repoRoot = path.resolve(__dirname, "..", "..");
const validationRoot = path.join(repoRoot, "validation-output", "verify", "consistency");

function main() {
  resetValidationRoot();
  validatePositiveCase();
  validateNegativeCases();
  console.log(`Artifact consistency verifies in ${path.relative(process.cwd(), validationRoot)}`);
}

function resetValidationRoot() {
  assert(
    validationRoot.startsWith(path.join(repoRoot, "validation-output")),
    `Refusing reset outside validation-output: ${validationRoot}`
  );
  fs.rmSync(validationRoot, { recursive: true, force: true });
  fs.mkdirSync(validationRoot, { recursive: true });
}

// Build a real post-write workspace: a fictional student evaluation that carries
// both a cv_adaptation_plan and a statement_plan, run through the live CV and
// statement writers exactly as the full pipeline would.
function buildPostWriteWorkspace(name) {
  const root = path.join(validationRoot, name);
  setupSourceWorkspace(root, "statement_of_purpose");
  // The live CV runner also reads profile.yml; the statement fixture omits it.
  copyFile("examples/fictional-student/profile.yml", path.join(root, "students", studentId, "profile.yml"));
  runLiveCv({ program: programId, student: studentId, workspace: root, write: true });
  runLiveStatement({ program: programId, student: studentId, workspace: root, write: true });
  return { root, workspace: resolveWorkspace({ workspace: root, student: studentId }) };
}

function validatePositiveCase() {
  const { root, workspace } = buildPostWriteWorkspace("good");
  const evalText = fs.readFileSync(evalPath(root), "utf8");
  assert(/^tailored_cv: ".*Review Required.*"$/m.test(evalText), "Write did not persist tailored_cv into the evaluation");
  assert(/^statement: ".*Review Required.*"$/m.test(evalText), "Write did not persist statement into the evaluation");
  // A consistent post-write workspace must validate without throwing.
  validateProgramArtifacts(workspace, programId);
}

function validateNegativeCases() {
  expectRejected(
    "eval-cv-pending",
    (root) => rewriteEvalLine(root, "tailored_cv", "tailored_cv: pending"),
    /tailored_cv is 'pending'/
  );
  expectRejected(
    "eval-statement-pending",
    (root) => rewriteEvalLine(root, "statement", "statement: pending"),
    /statement is 'pending'/
  );
  expectRejected(
    "broken-report-link",
    (root) => {
      const reportFile = onlyReport(root);
      const text = fs.readFileSync(reportFile, "utf8");
      const mutated = text.replace(
        /^(\*\*Tailored CV:\*\* \[[^\]]*\]\()([^)]+)(\).*)$/m,
        "$1../output/wrong/wrong-artifact.html$3"
      );
      assert(mutated !== text, "broken-report-link mutation did not change the report");
      fs.writeFileSync(reportFile, mutated);
    },
    /Report Tailored CV link target does not match/
  );
  expectRejected(
    "stale-dry-run-next-action",
    (root) => {
      const phrase = "Review drafts, then run the CV and statement dry-runs again";
      rewriteEvalLine(root, "next_action", `next_action: ${phrase}`);
      rewriteTrackerNextAction(root, phrase);
    },
    /run dry-runs that already ran/
  );
  expectRejected(
    "stale-catalog",
    (root) => writeOlderCatalog(root),
    /newer than catalog/
  );
  expectRejected(
    "evidence-priorities-drift",
    (root) => mutateEvalYaml(root, (evaluation) => {
      evaluation.cv_adaptation_plan.evidence_priorities.pop();
    }),
    /Rendered evidence set differs from cv_adaptation_plan.evidence_priorities/
  );
  expectRejected(
    "lingering-second-artifact",
    (root) => {
      const outputDir = path.join(root, "students", studentId, "output", programId);
      fs.writeFileSync(path.join(outputDir, "admissions-resume.html"), "<html><body>stale artifact</body></html>");
    },
    /more than one CV artifact/
  );
  expectRejected(
    "test-gate-met-without-evidence",
    (root) => mutateEvalYaml(root, (evaluation) => {
      evaluation.eligibility.push({
        requirement: "English language test sub-scores",
        status: "met",
        evidence: "none",
        source: "https://example.edu/injected",
        notes: "Injected drift case.",
      });
    }),
    /Language\/standardized-test gate is 'met' with no evidence/
  );
  expectRejected(
    "bad-eligibility-summary",
    (root) => mutateEvalYaml(root, (evaluation) => {
      evaluation.eligibility_summary = "borderline";
    }),
    /eligibility_summary 'borderline' is not one of eligible, likely, unclear, ineligible/
  );
}

function expectRejected(name, mutate, pattern) {
  const { root, workspace } = buildPostWriteWorkspace(name);
  mutate(root);
  let failed = false;
  let message = "";
  try {
    validateProgramArtifacts(workspace, programId);
  } catch (error) {
    failed = true;
    message = error.message;
  }
  assert(failed, `Expected consistency check to reject drift case: ${name}`);
  assert(pattern.test(message), `Drift case ${name} threw an unexpected message:\n${message}`);
}

// --- mutation helpers ------------------------------------------------------

function mutateEvalYaml(root, mutate) {
  const file = evalPath(root);
  const evaluation = yaml.load(fs.readFileSync(file, "utf8"));
  mutate(evaluation);
  fs.writeFileSync(file, yaml.dump(evaluation, { lineWidth: 100 }));
}

function rewriteEvalLine(root, field, newLine) {
  const file = evalPath(root);
  const text = fs.readFileSync(file, "utf8");
  const pattern = new RegExp(`^${field}:.*$`, "m");
  assert(pattern.test(text), `Fixture evaluation missing ${field} line`);
  fs.writeFileSync(file, text.replace(pattern, newLine));
}

function rewriteTrackerNextAction(root, value) {
  const trackerPath = path.join(root, "students", studentId, "tracker.md");
  const parsed = parseTracker(fs.readFileSync(trackerPath, "utf8"));
  const rows = parsed.rows.map((row) => ({ ...row, "Next Action": value }));
  fs.writeFileSync(trackerPath, renderTracker(parsed.prelude, rows));
}

function writeOlderCatalog(root) {
  const catalogDir = path.join(root, "programs", "catalog");
  fs.mkdirSync(catalogDir, { recursive: true });
  fs.writeFileSync(
    path.join(catalogDir, `${programId}.yml`),
    yaml.dump({ id: programId, retrieved_at: "2026-06-10" })
  );
}

function onlyReport(root) {
  const reportsDir = path.join(root, "students", studentId, "reports");
  const files = fs.readdirSync(reportsDir).filter((entry) => entry.endsWith(".md"));
  assert(files.length === 1, `Expected exactly one report in fixture, found ${files.length}`);
  return path.join(reportsDir, files[0]);
}

function evalPath(root) {
  return path.join(root, "students", studentId, "evaluations", `${programId}.yml`);
}

function copyFile(relativeSource, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, relativeSource), destination);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

main();
