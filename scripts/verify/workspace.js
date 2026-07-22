const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const { REVIEW_STATUS } = require("../lib/cv-writer");
const { runCompare } = require("../cli/compare");
const { runLiveCv } = require("../cli/cv");
const {
  emptyTracker,
  renderReport,
  renderTracker,
  reportFileName,
  trackerRowFromEvaluation,
} = require("../lib/program-writer");

const repoRoot = path.resolve(__dirname, "..", "..");
const validationRoot = path.join(repoRoot, "validation-output", "verify", "workspace");
const sourceRoot = path.join(validationRoot, "source");
const studentsPath = path.join(repoRoot, "examples", "stress-benchmark", "students.yml");
const programsPath = path.join(repoRoot, "examples", "stress-benchmark", "programs.yml");

const STUDENT_CASES = [
  { id: "ari", fixture: "vision_ml_researcher" },
  { id: "noor", fixture: "hci_design_researcher" },
];
const PROGRAM_IDS = ["cmu-mscv-fall-2027", "ucl-msc-hci-fall-2027"];

// Evidence priorities are per-student evidence IDs; the cmu program record
// carries the canonical vision-researcher (ari) plan, so noor's rendered
// evaluation supplies her own plan built from her evidence.
const PLAN_OVERRIDES = {
  noor: {
    "cmu-mscv-fall-2027": {
      document_type: "admissions_resume",
      summary:
        "Workspace-isolation plan: render a concise resume from Noor's own HCI evidence for this program without borrowing another student's records.",
      profile_summary:
        "HCI-trained applicant presenting accessibility research, usability methods, and prototyping coursework.",
      evidence_priorities: [
        "edu-noor-ba-cogsci",
        "research-noor-accessibility-study",
        "project-noor-prototype",
        "course-noor-hci",
        "course-noor-statistics",
        "course-noor-python",
        "award-noor-design-prize",
      ],
    },
  },
};

function main() {
  resetValidationRoot();
  const students = readYaml(studentsPath).students;
  const programs = new Map(readYaml(programsPath).programs.map((program) => [program.id, program]));
  writeCatalogs(programs);
  for (const studentCase of STUDENT_CASES) {
    setupStudentWorkspace(studentCase, students[studentCase.fixture], programs);
  }

  const before = hashStudentInputs();
  STUDENT_CASES.forEach((studentCase) => validateStudentCvDryRun(studentCase));
  validateNoSourceMutation(before, "student-scoped CV dry-runs");
  const results = STUDENT_CASES.map((studentCase) => validateStudentCvWrite(studentCase));
  validateDistinctStudentOutputs(results);
  validateStudentCompareFlow();
  validateStudentRequiredFailure();

  console.log(`Student workspace layout verifies in ${path.relative(process.cwd(), validationRoot)}`);
}

function resetValidationRoot() {
  assert(
    validationRoot.startsWith(path.join(repoRoot, "validation-output")),
    `Refusing to reset outside validation-output: ${validationRoot}`
  );
  fs.rmSync(validationRoot, { recursive: true, force: true });
  fs.mkdirSync(validationRoot, { recursive: true });
}

function setupStudentWorkspace(studentCase, student, programs) {
  const studentRoot = path.join(sourceRoot, "students", studentCase.id);
  writeYaml(path.join(studentRoot, "profile.yml"), student.profile);
  writeYaml(path.join(studentRoot, "preferences.yml"), {
    target_fields: ["computer vision", "human-computer interaction"],
    countries: ["United States", "United Kingdom"],
    intakes: ["Fall 2027"],
    constraints: ["Synthetic validation workspace."],
  });
  writeYaml(path.join(studentRoot, "evidence.yml"), student.evidence);
  writeText(path.join(studentRoot, "master-cv.md"), student.master_cv);

  const rows = [];
  PROGRAM_IDS.forEach((programId, index) => {
    const fullEvaluation = {
      ...clone(programs.get(programId)),
      report_number: index + 1,
      catalog_id: programId,
    };
    const evaluation = studentEvaluationFromProgram(fullEvaluation);
    const planOverride = (PLAN_OVERRIDES[studentCase.id] || {})[programId];
    if (planOverride) evaluation.cv_adaptation_plan = clone(planOverride);
    writeYaml(path.join(studentRoot, "evaluations", `${programId}.yml`), evaluation);
    const reportName = reportFileName(fullEvaluation);
    writeText(path.join(studentRoot, "reports", reportName), renderReport(fullEvaluation));
    const row = trackerRowFromEvaluation(fullEvaluation, reportName);
    row.Report = `[${String(evaluation.report_number).padStart(3, "0")}](reports/${reportName})`;
    rows.push(row);
  });
  writeText(path.join(studentRoot, "tracker.md"), renderTracker("# Programs Tracker\n\n", rows));
}

function writeCatalogs(programs) {
  for (const programId of PROGRAM_IDS) {
    writeYaml(path.join(sourceRoot, "programs", "catalog", `${programId}.yml`), catalogFromProgram(programs.get(programId)));
  }
}

function catalogFromProgram(program) {
  const allowed = [
    "id",
    "institution",
    "program",
    "degree_type",
    "department",
    "intake",
    "applicant_category",
    "country",
    "campus",
    "delivery",
    "official_url",
    "application_url",
    "retrieved_at",
    "deadline",
    "document_instructions",
    "sources",
    "freshness_warnings",
    "conflicts",
  ];
  return Object.fromEntries(allowed.filter((key) => key in program).map((key) => [key, clone(program[key])]));
}

function studentEvaluationFromProgram(program) {
  const studentKeys = [
    "id",
    "catalog_id",
    "report_number",
    "eligibility_summary",
    "fit_score",
    "evidence_confidence",
    "tailored_cv",
    "status",
    "next_action",
    "notes",
    "eligibility",
    "fit",
    "competitiveness_gaps",
    "practical_constraints",
    "cv_adaptation_plan",
    "action_items",
    "questions",
  ];
  return Object.fromEntries(studentKeys.filter((key) => key in program).map((key) => [key, clone(program[key])]));
}

function validateStudentCvDryRun(studentCase) {
  const programId = PROGRAM_IDS[0];
  const dryRun = runLiveCv({
    program: programId,
    workspace: sourceRoot,
    student: studentCase.id,
    dryRunRoot: path.join(validationRoot, "dry-run", "live", studentCase.id, programId),
    write: false,
  });
  assert(
    dryRun.outputRoot === path.join(validationRoot, "dry-run", "live", studentCase.id, programId),
    `Dry-run output root is not student-scoped for ${studentCase.id}`
  );
  validateCvResult(studentCase, dryRun, "dry-run");
  assert(
    !fs.existsSync(path.join(sourceRoot, "students", studentCase.id, "output", programId)),
    `Dry-run wrote into source student output for ${studentCase.id}`
  );
}

function validateStudentCvWrite(studentCase) {
  const programId = PROGRAM_IDS[0];
  const beforeMasterCv = hashFile(path.join(sourceRoot, "students", studentCase.id, "master-cv.md"));
  const writeResult = runLiveCv({
    program: programId,
    workspace: sourceRoot,
    student: studentCase.id,
    write: true,
  });
  validateCvResult(studentCase, writeResult, "write");
  assert(
    hashFile(path.join(sourceRoot, "students", studentCase.id, "master-cv.md")) === beforeMasterCv,
    `Write mode mutated master CV for ${studentCase.id}`
  );
  assert(
    writeResult.outputRoot === path.join(sourceRoot, "students", studentCase.id),
    `Write mode escaped selected student workspace for ${studentCase.id}`
  );
  return writeResult;
}

function validateCvResult(studentCase, result, label) {
  assert(result.reviewStatus === REVIEW_STATUS, `${label} missing Review Required status for ${studentCase.id}`);
  assert(result.reportPath.includes(`${path.sep}${studentCase.id}${path.sep}`), `${label} report path is not student-scoped`);
  assert(result.trackerPath.endsWith(`${path.sep}tracker.md`), `${label} tracker path should be student tracker`);
  const artifactPath = path.join(result.outputRoot, result.artifacts.artifact);
  const evidenceMapPath = path.join(result.outputRoot, result.artifacts.evidence_map);
  assert(fs.existsSync(artifactPath), `${label} missing artifact for ${studentCase.id}`);
  assert(fs.existsSync(evidenceMapPath), `${label} missing evidence map for ${studentCase.id}`);
  const html = fs.readFileSync(artifactPath, "utf8");
  const expectedName = studentCase.id === "ari" ? "Ari Lim" : "Noor Patel";
  const forbiddenName = studentCase.id === "ari" ? "Noor Patel" : "Ari Lim";
  assert(html.includes(expectedName), `${label} artifact did not use selected student profile for ${studentCase.id}`);
  assert(!html.includes(forbiddenName), `${label} artifact leaked another student's profile for ${studentCase.id}`);
  const evidenceMap = readYaml(evidenceMapPath);
  const prefix = studentCase.id === "ari" ? "-ari-" : "-noor-";
  for (const claim of evidenceMap.generated_claims || []) {
    assert(
      claim.evidence_id.includes(prefix),
      `${label} evidence claim ${claim.evidence_id} did not come from ${studentCase.id}`
    );
  }
}

function validateDistinctStudentOutputs(results) {
  const artifactPaths = results.map((result) => path.join(result.outputRoot, result.artifacts.artifact));
  assert(new Set(artifactPaths).size === artifactPaths.length, "Student outputs collided for the same program");
  for (const file of artifactPaths) {
    assert(fs.existsSync(file), `Expected written student artifact: ${file}`);
  }
}

function validateStudentCompareFlow() {
  for (const studentCase of STUDENT_CASES) {
    const result = runCompare({
      programs: PROGRAM_IDS,
      workspace: sourceRoot,
      student: studentCase.id,
      dryRunRoot: path.join(validationRoot, "dry-run", "compare", studentCase.id),
      date: "2026-06-27",
      syncTracker: false,
      write: false,
    });
    assert(
      result.outputRoot === path.join(validationRoot, "dry-run", "compare", studentCase.id),
      `Compare dry-run root is not student-scoped for ${studentCase.id}`
    );
    assert(result.report === "reports/comparison-2026-06-27.md", `Unexpected compare report path for ${studentCase.id}`);
    assert(result.checklist === "checklists/comparison-2026-06-27.md", `Unexpected compare checklist path for ${studentCase.id}`);
    assert(fs.existsSync(path.join(result.outputRoot, "tracker.md")), `Compare did not copy student tracker for ${studentCase.id}`);
  }
}

function validateStudentRequiredFailure() {
  const evaluation = readYaml(path.join(repoRoot, "examples", "fictional-programs", "northbridge-evaluation.yml"));
  let failed = false;
  try {
    runLiveCv({
      program: evaluation.id,
      workspace: sourceRoot,
      dryRunRoot: path.join(validationRoot, "dry-run", "missing-student"),
      write: false,
    });
  } catch (error) {
    failed = /Missing required --student <student-id>/.test(error.message);
  }
  assert(failed, "CV runner should require --student");
}

function hashStudentInputs() {
  const hashes = {};
  for (const studentCase of STUDENT_CASES) {
    const root = path.join(sourceRoot, "students", studentCase.id);
    for (const relative of [
      "profile.yml",
      "preferences.yml",
      "evidence.yml",
      "master-cv.md",
      `evaluations/${PROGRAM_IDS[0]}.yml`,
      `evaluations/${PROGRAM_IDS[1]}.yml`,
      "tracker.md",
    ]) {
      hashes[`${studentCase.id}/${relative}`] = hashFile(path.join(root, relative));
    }
  }
  return hashes;
}

function validateNoSourceMutation(before, label) {
  const after = hashStudentInputs();
  for (const [file, hash] of Object.entries(before)) {
    assert(after[file] === hash, `${label} mutated source file: ${file}`);
  }
}

function copyFile(source, target) {
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

function hashFile(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

main();
