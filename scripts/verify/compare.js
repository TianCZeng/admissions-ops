const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const { attachCvArtifactsToEvaluation, renderCvAdaptation, REVIEW_STATUS } = require("../lib/cv-writer");
const { runCompare, ALLOWED_LABELS } = require("../cli/compare");
const {
  parseTracker,
  renderReport,
  renderTracker,
  reportFileName,
  trackerIdentity,
  trackerRowFromEvaluation,
} = require("../lib/program-writer");

const repoRoot = path.resolve(__dirname, "..", "..");
const validationBase = path.join(repoRoot, "validation-output", "verify", "compare");
const sourceRoot = path.join(validationBase, "source");
const dryRunRoot = path.join(validationBase, "dry-run");
const rawRoot = path.join(validationBase, "raw");
const studentId = "compare-fixture";

function main() {
  resetValidationRoot(sourceRoot);
  resetValidationRoot(rawRoot);
  const evaluations = setupSourceWorkspace(sourceRoot);
  const sourceFiles = [
    `students/${studentId}/preferences.yml`,
    `students/${studentId}/tracker.md`,
    `students/${studentId}/evaluations/northbridge-msc-ai-fall-2027.yml`,
    `students/${studentId}/evaluations/lakeside-msc-hci-fall-2027.yml`,
  ];
  const beforeDryRun = hashFiles(sourceRoot, sourceFiles);

  const dryRun = runCompare({
    programs: evaluations.map((evaluation) => evaluation.id),
    workspace: sourceRoot,
    student: studentId,
    dryRunRoot,
    date: "2026-06-26",
    syncTracker: false,
    write: false,
  });
  assertHashes(sourceRoot, sourceFiles, beforeDryRun, "Dry-run mutated source workspace");
  validateCompareResult(dryRun, evaluations, "dry-run");
  validateReport(dryRun, evaluations);
  validateChecklist(dryRun);
  validateLabels(dryRun);
  validateCvLinks(dryRun);
  validateUnknownPreserved(dryRun);

  validateSyncTrackerDryRun(evaluations);
  validateWriteMode(evaluations);
  validateRawInboxRejection();

  console.log(`Comparison fixture verifies in ${path.relative(process.cwd(), dryRunRoot)}`);
}

function setupSourceWorkspace(root) {
  const studentRoot = path.join(root, "students", studentId);
  copyFile("examples/fictional-student/profile.yml", path.join(studentRoot, "profile.yml"));
  copyFile("examples/fictional-student/preferences.yml", path.join(studentRoot, "preferences.yml"));
  copyFile("examples/fictional-student/evidence.yml", path.join(studentRoot, "evidence.yml"));
  copyFile("examples/fictional-student/master-cv.md", path.join(studentRoot, "master-cv.md"));

  const profile = readYaml(path.join(studentRoot, "profile.yml"));
  const evidence = readYaml(path.join(studentRoot, "evidence.yml"));
  const masterCv = fs.readFileSync(path.join(studentRoot, "master-cv.md"), "utf8");
  const evaluations = [
    readYaml(path.join(repoRoot, "examples", "fictional-programs", "northbridge-evaluation.yml")),
    readYaml(path.join(repoRoot, "examples", "fictional-programs", "lakeside-evaluation.yml")),
  ];

  return evaluations.map((evaluation) => {
    const reportName = reportFileName(evaluation);
    writeText(path.join(studentRoot, "reports", reportName), renderReport(evaluation));
    const cvResult = renderCvAdaptation(studentRoot, {
      evaluation,
      profile,
      evidence,
      masterCv,
      documentInstructions: evaluation.document_instructions || {},
      sourceLabels: sourceLabels(),
    });
    const linkedEvaluation = attachCvArtifactsToEvaluation(evaluation, cvResult);
    const row = trackerRowFromEvaluation(linkedEvaluation, reportName);
    row.Report = `[${String(linkedEvaluation.report_number).padStart(3, "0")}](reports/${reportName})`;
    row.CV = String(row.CV || "").replace(/\]\(\.\.\/output\//g, "](output/");
    const trackerPath = path.join(studentRoot, "tracker.md");
    const existing = fs.existsSync(trackerPath) ? parseTracker(fs.readFileSync(trackerPath, "utf8")).rows : [];
    writeText(path.join(studentRoot, "tracker.md"), renderTracker("# Programs Tracker\n\n", [...existing, row]));
    writeYaml(path.join(studentRoot, "evaluations", `${evaluation.id}.yml`), linkedEvaluation);
    return linkedEvaluation;
  });
}

function sourceLabels() {
  const prefix = `students/${studentId}`;
  return {
    profile: `${prefix}/profile.yml for identity and contact only`,
    evidence: `${prefix}/evidence.yml`,
    master_cv: `${prefix}/master-cv.md`,
  };
}

function validateCompareResult(result, evaluations, label) {
  assert(result.programs.length === evaluations.length, `${label} compared the wrong number of programs`);
  assert(result.report === "reports/comparison-2026-06-26.md", `${label} report path mismatch`);
  assert(result.checklist === "checklists/comparison-2026-06-26.md", `${label} checklist path mismatch`);
  assert(fs.existsSync(path.join(result.outputRoot, result.report)), `${label} report missing`);
  assert(fs.existsSync(path.join(result.outputRoot, result.checklist)), `${label} checklist missing`);
}

function validateReport(result, evaluations) {
  const reportPath = path.join(result.outputRoot, result.report);
  const report = fs.readFileSync(reportPath, "utf8");
  assert(report.includes("Planning labels are shorthand"), "Report missing planning-label caveat");
  assert(!/guarantee|guaranteed|chance of admission|probability of admission/i.test(report), "Report overstates certainty");
  for (const evaluation of evaluations) {
    assert(report.includes(evaluation.institution), `Report missing institution: ${evaluation.institution}`);
    assert(report.includes(evaluation.program), `Report missing program: ${evaluation.program}`);
    assert(report.includes(evaluation.eligibility_summary), `Report missing eligibility: ${evaluation.id}`);
    assert(report.includes(`${evaluation.fit_score}/5`), `Report missing fit score: ${evaluation.id}`);
    assert(report.includes(evaluation.evidence_confidence), `Report missing confidence: ${evaluation.id}`);
  }
  assert(report.includes("Deadline page not included in fixture; deadline remains unknown."), "Report lost unknown deadline context");
  assert(report.includes("Funding remains free text"), "Report should keep funding free text");
}

function validateChecklist(result) {
  const checklist = fs.readFileSync(path.join(result.outputRoot, result.checklist), "utf8");
  assert(checklist.includes("| Item | Status | Due | Source | Notes |"), "Checklist header mismatch");
  const rows = checklist.split(/\r?\n/).filter((line) => line.startsWith("| ") && !line.includes("---"));
  assert(rows.length > 1, "Checklist has no task rows");
  for (const line of rows.slice(1)) {
    const cells = splitMarkdownRow(line);
    assert(cells.length === 5, `Checklist row should have five cells: ${line}`);
    assert(cells.every(Boolean), `Checklist row has an empty required cell: ${line}`);
  }
  assert(checklist.includes("Confirm Fall 2027 deadline"), "Checklist missing Northbridge deadline task");
  assert(checklist.includes("Confirm recommendation and statement requirements"), "Checklist missing Lakeside package task");
}

function validateLabels(result) {
  const report = fs.readFileSync(path.join(result.outputRoot, result.report), "utf8");
  const labelMatches = [...report.matchAll(/\| (ambitious|realistic|lower-risk) \|/g)].map((match) => match[1]);
  assert(labelMatches.length >= 2, "Expected at least two planning labels in report");
  for (const label of labelMatches) {
    assert(ALLOWED_LABELS.has(label), `Unsupported planning label: ${label}`);
  }
  assert(report.includes("unresolved hard requirement"), "Ambitious label reasoning should mention unresolved requirements");
  assert(report.includes("formal requirements are mostly resolved"), "Lower-risk label reasoning should be visible");
}

function validateCvLinks(result) {
  const report = fs.readFileSync(path.join(result.outputRoot, result.report), "utf8");
  assert(report.includes(REVIEW_STATUS), "Comparison report should preserve Review Required status");
  const tracker = parseTracker(fs.readFileSync(path.join(result.outputRoot, "tracker.md"), "utf8"));
  assert(tracker.rows.length >= 2, "Dry-run tracker should include both compared programs");
  for (const row of tracker.rows) {
    if (!row.CV.includes(REVIEW_STATUS)) continue;
    assert(resolveMarkdownLink(path.join(result.outputRoot, "tracker.md"), row.CV, result.outputRoot), `Tracker CV link does not resolve: ${row.CV}`);
  }
}

function validateUnknownPreserved(result) {
  const checklist = fs.readFileSync(path.join(result.outputRoot, result.checklist), "utf8");
  assert(checklist.includes("| unknown |"), "Checklist should preserve unknown due dates");
}

function validateSyncTrackerDryRun(evaluations) {
  const syncRoot = path.join(validationBase, "compare-sync-source");
  resetValidationRoot(syncRoot);
  setupSourceWorkspace(syncRoot);
  const trackerPath = path.join(syncRoot, "students", studentId, "tracker.md");
  const tracker = fs.readFileSync(trackerPath, "utf8");
  const parsed = parseTracker(tracker);
  const northbridgeIdentity = trackerIdentity({
    Institution: evaluations[0].institution,
    Program: evaluations[0].program,
    Degree: evaluations[0].degree_type,
    Intake: evaluations[0].intake,
  });
  const onlyLakesideRows = parsed.rows.filter((row) => trackerIdentity(row) !== northbridgeIdentity);
  fs.writeFileSync(trackerPath, renderTracker(parsed.prelude, onlyLakesideRows));
  const before = hashFile(trackerPath);
  const result = runCompare({
    programs: evaluations.map((evaluation) => evaluation.id),
    workspace: syncRoot,
    student: studentId,
    dryRunRoot: path.join(validationBase, "sync-dry-run"),
    date: "2026-06-26",
    syncTracker: true,
    write: false,
  });
  assert(hashFile(trackerPath) === before, "Dry-run --sync-tracker mutated source tracker");
  const dryTracker = parseTracker(fs.readFileSync(path.join(result.outputRoot, "tracker.md"), "utf8"));
  assert(dryTracker.rows.length === 2, "Dry-run --sync-tracker should add missing row to copied tracker");
}

function validateWriteMode(evaluations) {
  const writeRoot = path.join(validationBase, "compare-write-source");
  resetValidationRoot(writeRoot);
  setupSourceWorkspace(writeRoot);
  const result = runCompare({
    programs: evaluations.map((evaluation) => evaluation.id),
    workspace: writeRoot,
    student: studentId,
    date: "2026-06-26",
    syncTracker: true,
    write: true,
  });
  validateCompareResult(result, evaluations, "write");
  assert(result.outputRoot === path.join(writeRoot, "students", studentId), "Write mode should write to selected student workspace");
}

function validateRawInboxRejection() {
  copyFile("examples/fictional-student/preferences.yml", path.join(rawRoot, "students", studentId, "preferences.yml"));
  writeYaml(path.join(rawRoot, "programs", "inbox.yml"), {
    programs: [
      {
        id: "raw-only-program",
        institution: "Raw Only University",
        program: "MSc Raw Entry",
        degree_type: "MSc",
        intake: "Fall 2027",
        official_url: "https://example.test/raw",
      },
    ],
  });
  let failed = false;
  try {
    runCompare({
      programs: ["raw-only-program", "missing-second-program"],
      workspace: rawRoot,
      student: studentId,
      dryRunRoot: path.join(validationBase, "raw-dry-run"),
      date: "2026-06-26",
      write: false,
    });
  } catch (error) {
    failed = /Cannot compare raw inbox entry/.test(error.message);
  }
  assert(failed, "Raw inbox-only entries should be rejected");
}

function resetValidationRoot(rootDir) {
  const resolved = path.resolve(rootDir);
  assert(
    resolved.startsWith(validationBase),
    `Refusing to reset validation output outside ${validationBase}`
  );
  fs.rmSync(resolved, { recursive: true, force: true });
  fs.mkdirSync(resolved, { recursive: true });
}

function copyFile(relativeSource, target) {
  const source = path.join(repoRoot, relativeSource);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function readYaml(file) {
  return yaml.load(fs.readFileSync(file, "utf8"));
}

function writeYaml(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, yaml.dump(value, { lineWidth: 100 }));
}

function writeText(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

function hashFiles(root, files) {
  return Object.fromEntries(files.map((file) => [file, hashFile(path.join(root, file))]));
}

function assertHashes(root, files, expected, message) {
  for (const file of files) {
    assert(hashFile(path.join(root, file)) === expected[file], `${message}: ${file}`);
  }
}

function hashFile(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function resolveMarkdownLink(baseFile, markdownLink, rootDir) {
  const match = markdownLink.match(/\]\(([^)]+)\)/);
  if (!match) return false;
  const resolved = path.resolve(path.dirname(baseFile), match[1]);
  return resolved.startsWith(rootDir) && fs.existsSync(resolved);
}

function splitMarkdownRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

main();
