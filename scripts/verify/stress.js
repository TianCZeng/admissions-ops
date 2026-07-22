const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const { flattenEvidence, REVIEW_STATUS, REQUIRED_SECTIONS } = require("../lib/cv-writer");
const { runLiveCv } = require("../cli/cv");
const {
  renderReport,
  renderTracker,
  reportFileName,
  trackerRowFromEvaluation,
} = require("../lib/program-writer");

const repoRoot = path.resolve(__dirname, "..", "..");
const validationRoot = path.join(repoRoot, "validation-output", "verify", "stress");
const studentsPath = path.join(repoRoot, "examples", "stress-benchmark", "students.yml");
const programsPath = path.join(repoRoot, "examples", "stress-benchmark", "programs.yml");

function main() {
  resetValidationRoot();

  const studentsFixture = readYaml(studentsPath);
  const programsFixture = readYaml(programsPath);
  const students = studentsFixture.students || {};
  const programs = new Map((programsFixture.programs || []).map((program) => [program.id, program]));
  const cases = programsFixture.cases || [];

  validateCoverage(students, programs, cases, programsFixture.coverage_expectations || {});
  validateProgramRecords(programs);
  validateStudentRecords(students);

  const rendered = [];
  const boundary = [];
  for (const testCase of cases) {
    if (testCase.expected_behavior === "render") {
      rendered.push(validateRenderedCase(testCase, programs, students));
    } else {
      boundary.push(validateBoundaryCase(testCase, programs, students));
    }
  }

  assert(rendered.some((result) => result.documentType === "academic_cv"), "Stress benchmark did not render an academic CV");
  assert(rendered.some((result) => result.documentType === "admissions_resume"), "Stress benchmark did not render an admissions resume");
  assert(boundary.some((result) => result.behavior === "no_standalone_cv"), "Stress benchmark missing no-standalone-CV boundary");
  assert(boundary.some((result) => result.behavior === "not_masters_workflow"), "Stress benchmark missing non-master's boundary");

  console.log(
    `Stress benchmark verifies ${rendered.length} rendered cases and ${boundary.length} boundary cases in ${path.relative(process.cwd(), validationRoot)}`
  );
}

function resetValidationRoot() {
  assert(
    validationRoot.startsWith(path.join(repoRoot, "validation-output")),
    `Refusing to reset outside validation-output: ${validationRoot}`
  );
  fs.rmSync(validationRoot, { recursive: true, force: true });
  fs.mkdirSync(validationRoot, { recursive: true });
}

function validateCoverage(students, programs, cases, expectations) {
  assert(Object.keys(students).length >= expectations.minimum_students, "Stress benchmark has too few synthetic students");
  assert(programs.size >= expectations.minimum_programs, "Stress benchmark has too few programs");

  const domains = new Set(Object.values(students).map((student) => student.domain));
  for (const domain of expectations.required_domains || []) {
    assert(domains.has(domain), `Stress benchmark missing student domain: ${domain}`);
  }

  const behaviors = new Set(cases.map((testCase) => testCase.expected_behavior));
  for (const behavior of expectations.required_behaviors || []) {
    assert(behaviors.has(behavior), `Stress benchmark missing behavior: ${behavior}`);
  }

  const renderedTypes = new Set(
    cases
      .filter((testCase) => testCase.expected_behavior === "render")
      .map((testCase) => testCase.expected_document_type)
  );
  for (const documentType of expectations.required_document_types || []) {
    assert(renderedTypes.has(documentType), `Stress benchmark missing rendered document type: ${documentType}`);
  }

  for (const testCase of cases) {
    assert(programs.has(testCase.program_id), `Case references missing program: ${testCase.id}`);
    assert(students[testCase.student_id], `Case references missing student: ${testCase.id}`);
  }
}

function validateProgramRecords(programs) {
  const seen = new Set();
  for (const program of programs.values()) {
    assert(program.id, "Program missing id");
    const identity = [program.institution, program.program, program.degree_type, program.intake].join("||").toLowerCase();
    assert(!seen.has(identity), `Duplicate program identity: ${identity}`);
    seen.add(identity);

    assert(/^https:\/\//.test(program.official_url), `Program official URL must be HTTPS: ${program.id}`);
    assert(!program.official_url.includes("example.edu"), `Program official URL must not be a placeholder: ${program.id}`);
    assert(program.retrieved_at === "2026-06-27", `Stress source retrieval date must be explicit: ${program.id}`);
    assert(program.sources && program.sources.length > 0, `Program missing sources: ${program.id}`);
    for (const source of program.sources) {
      assert(/^https:\/\//.test(source.url), `Source URL must be HTTPS: ${program.id}`);
      assert(source.retrieved_at === program.retrieved_at, `Source retrieval date mismatch: ${program.id}`);
    }

    const unknownRows = (program.eligibility || []).filter((row) => row.status === "unknown");
    if (unknownRows.length > 0) {
      assert((program.action_items || []).length > 0, `Unknown eligibility needs action items: ${program.id}`);
    }
    assertNoProbabilityLanguage(program, program.id);
  }
}

function validateStudentRecords(students) {
  for (const [studentId, student] of Object.entries(students)) {
    assert(student.profile && student.profile.student && student.profile.student.name, `Student missing profile: ${studentId}`);
    assert(student.evidence && Array.isArray(student.evidence.education), `Student missing evidence education: ${studentId}`);
    assert(typeof student.master_cv === "string" && student.master_cv.includes("# "), `Student missing master CV: ${studentId}`);

    const ids = flattenEvidence(student.evidence).map((entry) => entry.id);
    assert(ids.length > 0, `Student has no evidence IDs: ${studentId}`);
    assert(new Set(ids).size === ids.length, `Student has duplicate evidence IDs: ${studentId}`);
  }
}

function validateRenderedCase(testCase, programs, students) {
  const program = clone(programs.get(testCase.program_id));
  program.report_number = 1;
  // Evidence priorities are per-student IDs; when a program renders for a
  // non-canonical student, the case record supplies that student's plan.
  if (testCase.cv_adaptation_plan) {
    program.cv_adaptation_plan = clone(testCase.cv_adaptation_plan);
  }
  const student = students[testCase.student_id];
  const caseRoot = path.join(validationRoot, "source", testCase.id);
  const runtimeStudentId = testCase.id;
  const studentRoot = path.join(caseRoot, "students", runtimeStudentId);
  const dryRunRoot = path.join(validationRoot, "dry-run", testCase.id);
  setupCaseWorkspace(caseRoot, runtimeStudentId, program, student);

  const reportPath = path.join(studentRoot, "reports", reportFileName(program));
  const sourceFiles = [
    `students/${runtimeStudentId}/profile.yml`,
    `students/${runtimeStudentId}/evidence.yml`,
    `students/${runtimeStudentId}/master-cv.md`,
    `students/${runtimeStudentId}/evaluations/${program.id}.yml`,
    `students/${runtimeStudentId}/tracker.md`,
    path.relative(caseRoot, reportPath).split(path.sep).join("/"),
  ];
  const before = hashFiles(caseRoot, sourceFiles);

  const result = runLiveCv({
    program: program.id,
    workspace: caseRoot,
    student: runtimeStudentId,
    dryRunRoot,
    write: false,
  });
  assertHashes(caseRoot, sourceFiles, before, `Dry-run mutated source workspace for ${testCase.id}`);
  assert(result.reviewStatus === REVIEW_STATUS, `Rendered case missing review status: ${testCase.id}`);
  assert(
    result.documentType === testCase.expected_document_type,
    `Unexpected document type for ${testCase.id}: ${result.documentType}`
  );
  assert(!fs.existsSync(path.join(studentRoot, "output", program.id)), `Dry-run wrote source output for ${testCase.id}`);

  const artifactPath = path.join(result.outputRoot, result.artifacts.artifact);
  const evidenceMapPath = path.join(result.outputRoot, result.artifacts.evidence_map);
  const planPath = path.join(result.outputRoot, result.artifacts.adaptation_plan);
  for (const file of [artifactPath, evidenceMapPath, planPath, result.reportPath, result.trackerPath]) {
    assert(fs.existsSync(file), `Rendered case missing output file ${file}`);
  }

  const html = fs.readFileSync(artifactPath, "utf8");
  const plan = fs.readFileSync(planPath, "utf8");
  const evidenceMap = readYaml(evidenceMapPath);
  const allowedEvidenceIds = new Set(flattenEvidence(student.evidence).map((entry) => entry.id));
  const usedIds = new Set((evidenceMap.generated_claims || []).map((claim) => claim.evidence_id));
  for (const id of usedIds) {
    assert(allowedEvidenceIds.has(id), `Rendered unsupported evidence ${id} in ${testCase.id}`);
    assert(html.includes(`data-evidence-id="${id}"`), `Rendered HTML missing evidence marker ${id} in ${testCase.id}`);
  }
  for (const expectedId of testCase.expected_used_evidence || []) {
    assert(usedIds.has(expectedId), `Rendered case ${testCase.id} did not use expected evidence ${expectedId}`);
  }

  validateRequiredSections(html, REQUIRED_SECTIONS[result.documentType], testCase.id);
  assert(plan.includes(`**Review status:** ${REVIEW_STATUS}`), `Plan missing review status for ${testCase.id}`);
  if (program.document_instructions && program.document_instructions.page_limit) {
    assert(
      evidenceMap.estimated_pages <= program.document_instructions.page_limit,
      `Page estimate exceeds limit for ${testCase.id}`
    );
  }

  return {
    caseId: testCase.id,
    documentType: result.documentType,
    evidenceIdsUsed: [...usedIds],
  };
}

function validateBoundaryCase(testCase, programs, students) {
  const program = programs.get(testCase.program_id);
  const student = students[testCase.student_id];
  assert(student, `Boundary case missing student: ${testCase.id}`);
  assert(program.material_behavior === testCase.expected_behavior, `Boundary behavior mismatch for ${testCase.id}`);
  assert(program.material_behavior_reason, `Boundary case missing reason: ${testCase.id}`);
  assert((program.action_items || []).some((item) => item.status === "Needed"), `Boundary case needs action item: ${testCase.id}`);
  assert(
    !program.material_behavior_reason.toLowerCase().includes("probably"),
    `Boundary reason must not hedge with probability language: ${testCase.id}`
  );
  return {
    caseId: testCase.id,
    behavior: program.material_behavior,
  };
}

function setupCaseWorkspace(root, studentId, program, student) {
  const studentRoot = path.join(root, "students", studentId);
  writeYaml(path.join(studentRoot, "profile.yml"), student.profile);
  writeYaml(path.join(studentRoot, "evidence.yml"), student.evidence);
  writeText(path.join(studentRoot, "master-cv.md"), student.master_cv);
  writeYaml(path.join(studentRoot, "evaluations", `${program.id}.yml`), program);
  const reportName = reportFileName(program);
  writeText(path.join(studentRoot, "reports", reportName), renderReport(program));
  writeText(path.join(studentRoot, "tracker.md"), renderTracker("# Programs Tracker\n\n", [
    trackerRowFromEvaluation(program, reportName),
  ]));
}

function assertNoProbabilityLanguage(value, label) {
  const text = JSON.stringify(value).toLowerCase();
  const forbidden = [
    "acceptance probability",
    "chance of admission",
    "admission chance",
    "guaranteed admission",
    "will be admitted",
  ];
  for (const phrase of forbidden) {
    assert(!text.includes(phrase), `Forbidden probability language in ${label}: ${phrase}`);
  }
}

function validateRequiredSections(html, sections, label) {
  let cursor = -1;
  for (const section of sections) {
    const index = html.indexOf(`<h2>${section}</h2>`);
    assert(index > cursor, `Missing or out-of-order section ${section} in ${label}`);
    cursor = index;
  }
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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

main();
