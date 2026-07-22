const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const {
  REPORT_SECTIONS,
  parseTracker,
  reportFileName,
  trackerIdentity,
  writeProgramEvaluation,
} = require("../lib/program-writer");

const allowedEligibility = new Set(["met", "likely_met", "not_met", "unknown", "not_applicable"]);

function readYaml(file) {
  return yaml.load(fs.readFileSync(file, "utf8"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function main() {
  const evaluation = readYaml("examples/fictional-programs/northbridge-evaluation.yml");
  const states = readYaml("templates/states.yml");
  const allowedTrackerStatuses = new Set(states.states.map((state) => state.label));
  const validationRoot = path.join(__dirname, "..", "..", "validation-output", "verify", "program");

  resetValidationRoot(validationRoot);

  const output = writeProgramEvaluation(validationRoot, evaluation);
  writeProgramEvaluation(validationRoot, evaluation);

  validateReport(validationRoot, evaluation, output.reportFileName);
  validateTracker(validationRoot, evaluation, output.reportFileName, allowedTrackerStatuses);
  validateChecklist(validationRoot, evaluation);
  validateDuplicateDetection(validationRoot);

  console.log(`Program evaluation fixture verifies in ${path.relative(process.cwd(), validationRoot)}`);
}

function resetValidationRoot(rootDir) {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const validationBase = path.join(repoRoot, "validation-output");
  const resolved = path.resolve(rootDir);
  assert(
    resolved === validationBase || resolved.startsWith(`${validationBase}${path.sep}`),
    `Refusing to reset validation output outside ${validationBase}`
  );
  fs.rmSync(resolved, { recursive: true, force: true });
  fs.mkdirSync(resolved, { recursive: true });
}

function validateReport(rootDir, evaluation, fileName) {
  const expectedFileName = "001-northbridge-university-2026-06-18.md";
  assert(fileName === expectedFileName, `Expected ${expectedFileName}, got ${fileName}`);
  assert(reportFileName(evaluation) === expectedFileName, "Report filename is not deterministic");
  assert(/^\d{3}-[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.md$/.test(fileName), "Report filename shape is invalid");

  const reportPath = path.join(rootDir, "reports", fileName);
  assert(fs.existsSync(reportPath), "Report file was not written");
  const report = fs.readFileSync(reportPath, "utf8");

  [
    `# Program Evaluation: ${evaluation.institution} - ${evaluation.program}`,
    `**Intake:** ${evaluation.intake}`,
    `**Applicant category:** ${evaluation.applicant_category}`,
    `**Official URL:** ${evaluation.official_url}`,
    `**Retrieved:** ${evaluation.retrieved_at}`,
    "**Deadline:** unknown -",
    `**Eligibility:** ${evaluation.eligibility_summary}`,
    `**Fit score:** ${evaluation.fit_score}/5`,
    `**Evidence confidence:** ${evaluation.evidence_confidence}`,
    `**Tailored CV:** ${evaluation.tailored_cv}`,
  ].forEach((header) => assert(report.includes(header), `Missing report header: ${header}`));

  let cursor = -1;
  for (const section of REPORT_SECTIONS) {
    const index = report.indexOf(`## ${section}`);
    assert(index > cursor, `Missing or out-of-order report section: ${section}`);
    cursor = index;
  }

  for (const row of evaluation.eligibility) {
    assert(allowedEligibility.has(row.status), `Unsupported eligibility status: ${row.status}`);
  }

  assert(report.includes("## C. Formal eligibility matrix"), "Eligibility section missing");
  assert(report.includes("## D. Academic and research fit"), "Fit section missing");
  assert(report.indexOf("## C. Formal eligibility matrix") < report.indexOf("## D. Academic and research fit"), "Eligibility and fit are not separate sections");
  assert(report.includes("Deadline page not included in fixture; deadline remains unknown."), "Deadline unknown warning missing");

  const unknownRows = evaluation.eligibility.filter((row) => row.status === "unknown");
  for (const row of unknownRows) {
    assert(report.includes(row.requirement), `Unknown requirement missing from report: ${row.requirement}`);
  }
}

function validateTracker(rootDir, evaluation, fileName, allowedTrackerStatuses) {
  const trackerPath = path.join(rootDir, "programs", "tracker.md");
  const tracker = fs.readFileSync(trackerPath, "utf8");
  const parsed = parseTracker(tracker);
  assert(parsed.rows.length === 1, `Expected one tracker row after idempotent merge, got ${parsed.rows.length}`);

  const row = parsed.rows[0];
  assert(row.Institution === evaluation.institution, "Tracker institution mismatch");
  assert(row.Program === evaluation.program, "Tracker program mismatch");
  assert(row.Degree === evaluation.degree_type, "Tracker degree mismatch");
  assert(row.Intake === evaluation.intake, "Tracker intake mismatch");
  assert(row.Deadline.startsWith("unknown -"), "Tracker deadline should preserve unknown state");
  assert(allowedTrackerStatuses.has(row.Status), `Tracker status is not canonical: ${row.Status}`);
  assert(row.Eligibility === evaluation.eligibility_summary, "Tracker eligibility mismatch");
  assert(row.Fit === `${evaluation.fit_score}/5`, "Tracker fit mismatch");

  const link = row.Report.match(/\]\(([^)]+)\)/);
  assert(link, "Tracker report link missing");
  const resolved = path.resolve(path.dirname(trackerPath), link[1]);
  assert(resolved === path.join(rootDir, "reports", fileName), "Tracker report link resolves to the wrong path");
  assert(fs.existsSync(resolved), "Tracker report link target does not exist");
}

function validateChecklist(rootDir, evaluation) {
  const checklistDir = path.join(rootDir, "programs", "checklists");
  const files = fs.readdirSync(checklistDir).filter((file) => file.endsWith(".md"));
  assert(files.length === 1, "Expected one checklist file");
  const checklist = fs.readFileSync(path.join(checklistDir, files[0]), "utf8");
  const unknownRows = evaluation.eligibility.filter((row) => row.status === "unknown");
  for (const row of unknownRows) {
    const matchingTask = evaluation.action_items.find((item) =>
      item.item.toLowerCase().includes(row.requirement.replace(/^Deadline for /, "").toLowerCase()) ||
      item.notes.toLowerCase().includes("manual verification")
    );
    assert(matchingTask, `Unknown requirement lacks an action item: ${row.requirement}`);
    assert(checklist.includes(matchingTask.item), `Checklist missing action item: ${matchingTask.item}`);
  }
}

function validateDuplicateDetection(rootDir) {
  const trackerPath = path.join(rootDir, "programs", "tracker.md");
  const tracker = fs.readFileSync(trackerPath, "utf8");
  const parsed = parseTracker(tracker);
  const duplicated = [...parsed.rows, { ...parsed.rows[0], "#": "999" }];
  const seen = new Set();
  let duplicateFound = false;
  for (const row of duplicated) {
    const identity = trackerIdentity(row);
    if (seen.has(identity)) duplicateFound = true;
    seen.add(identity);
  }
  assert(duplicateFound, "Duplicate tracker identity check did not detect a duplicate");
}

main();
