const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const { runCompare } = require("../cli/compare");
const { runLiveCv } = require("../cli/cv");

const repoRoot = path.resolve(__dirname, "..", "..");
const validationRoot = path.join(repoRoot, "validation-output", "verify", "catalog");
const programsPath = path.join(repoRoot, "examples", "stress-benchmark", "programs.yml");

const CATALOG_ALLOWED_FIELDS = new Set([
  "id",
  "institution",
  "program",
  "degree_type",
  "department",
  "intake",
  "applicant_category",
  "applicant_category_split",
  "country",
  "campus",
  "delivery",
  "official_url",
  "application_url",
  "retrieved_at",
  "deadline",
  "requirements",
  "document_instructions",
  "sources",
  "freshness_warnings",
  "conflicts",
  "material_behavior",
  "material_behavior_reason",
]);

const CATALOG_FORBIDDEN_FIELDS = new Set([
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
]);

const STUDENT_EVALUATION_REQUIRED_FIELDS = new Set([
  "id",
  "catalog_id",
  "eligibility_summary",
  "fit_score",
  "evidence_confidence",
  "eligibility",
  "fit",
  "cv_adaptation_plan",
  "action_items",
]);

function main() {
  resetValidationRoot();
  const stressPrograms = readYaml(programsPath).programs;
  const renderablePrograms = stressPrograms.filter((program) => program.material_behavior !== "no_standalone_cv" && program.material_behavior !== "not_masters_workflow");
  const catalogs = renderablePrograms.slice(0, 2).map(catalogFromProgram);
  for (const catalog of catalogs) {
    writeYaml(path.join(validationRoot, "programs", "catalog", `${catalog.id}.yml`), catalog);
  }
  writeStudentEvaluationFixtures(renderablePrograms.slice(0, 2));

  validateCatalogDirectory(path.join(validationRoot, "programs", "catalog"), { requireRecords: true });
  validateLiveCatalogDirectory();
  validateStudentEvaluations(path.join(validationRoot, "students"));
  validateDuplicateCatalogIdentityRejected(catalogs[0]);
  validateMultipleStudentEvaluationsAllowed();
  validateCatalogOnlyRuntimeRejection(catalogs[0].id);

  console.log(`Catalog split verifies in ${path.relative(process.cwd(), validationRoot)}`);
}

function resetValidationRoot() {
  assert(
    validationRoot.startsWith(path.join(repoRoot, "validation-output")),
    `Refusing to reset outside validation-output: ${validationRoot}`
  );
  fs.rmSync(validationRoot, { recursive: true, force: true });
  fs.mkdirSync(validationRoot, { recursive: true });
}

function validateLiveCatalogDirectory() {
  const liveCatalogDir = path.join(repoRoot, "programs", "catalog");
  if (fs.existsSync(liveCatalogDir)) {
    validateCatalogDirectory(liveCatalogDir, { requireRecords: false });
  }
}

function validateCatalogDirectory(catalogDir, options = {}) {
  const files = fs.existsSync(catalogDir)
    ? fs.readdirSync(catalogDir).filter((file) => file.endsWith(".yml")).sort()
    : [];
  if (options.requireRecords) {
    assert(files.length > 0, `Catalog directory has no records: ${catalogDir}`);
  }
  const records = files.map((file) => readYaml(path.join(catalogDir, file)));
  for (const record of records) {
    validateCatalogRecord(record);
  }
  validateCatalogIdentity(records);
}

function validateCatalogRecord(record) {
  assert(record && typeof record === "object", "Catalog record must be a YAML object");
  for (const key of Object.keys(record)) {
    assert(CATALOG_ALLOWED_FIELDS.has(key), `Catalog field is not shared program data: ${record.id || "unknown"}.${key}`);
    assert(!CATALOG_FORBIDDEN_FIELDS.has(key), `Catalog contains student-specific field: ${record.id || "unknown"}.${key}`);
  }
  for (const key of ["id", "institution", "program", "degree_type", "intake", "official_url", "retrieved_at", "deadline", "sources"]) {
    assert(key in record, `Catalog missing required shared field ${key}: ${record.id || "unknown"}`);
  }
  assert(/^https:\/\//.test(record.official_url), `Catalog official URL must be HTTPS: ${record.id}`);
  assert(!record.official_url.includes("example.edu"), `Catalog official URL must not be a placeholder: ${record.id}`);
  assert(!JSON.stringify(record).includes("`student/"), `Catalog must not reference student evidence paths: ${record.id}`);
}

function validateCatalogIdentity(records) {
  const seen = new Map();
  for (const record of records) {
    const base = baseIdentity(record);
    const key = record.applicant_category_split ? `${base}||${record.applicant_category || "not_applicable"}` : base;
    assert(!seen.has(key), `Duplicate catalog identity: ${key}`);
    seen.set(key, record.id);
  }
}

function validateDuplicateCatalogIdentityRejected(record) {
  const duplicate = { ...clone(record), id: `${record.id}-duplicate` };
  let failed = false;
  try {
    validateCatalogIdentity([record, duplicate]);
  } catch (error) {
    failed = /Duplicate catalog identity/.test(error.message);
  }
  assert(failed, "Duplicate catalog identity should be rejected");
}

function writeStudentEvaluationFixtures(programs) {
  for (const studentId of ["ari", "noor"]) {
    for (const program of programs) {
      const evaluation = studentEvaluationFromProgram(program);
      evaluation.catalog_id = program.id;
      if (studentId === "noor") {
        evaluation.fit_score = Math.max(1, Number(evaluation.fit_score || 1) - 0.4);
        evaluation.next_action = "Student-specific review for Noor";
      }
      writeYaml(path.join(validationRoot, "students", studentId, "evaluations", `${program.id}.yml`), evaluation);
    }
  }
}

function validateStudentEvaluations(studentsDir) {
  for (const studentId of fs.readdirSync(studentsDir)) {
    const evaluationsDir = path.join(studentsDir, studentId, "evaluations");
    for (const file of fs.readdirSync(evaluationsDir).filter((item) => item.endsWith(".yml"))) {
      const evaluation = readYaml(path.join(evaluationsDir, file));
      for (const key of STUDENT_EVALUATION_REQUIRED_FIELDS) {
        assert(key in evaluation, `Student evaluation missing ${key}: ${studentId}/${file}`);
      }
      assert(evaluation.catalog_id, `Student evaluation must reference catalog_id: ${studentId}/${file}`);
      assert(JSON.stringify(evaluation).includes("`"), `Student evaluation should carry evidence references: ${studentId}/${file}`);
    }
  }
}

function validateMultipleStudentEvaluationsAllowed() {
  const ari = readYaml(path.join(validationRoot, "students", "ari", "evaluations", "cmu-mscv-fall-2027.yml"));
  const noor = readYaml(path.join(validationRoot, "students", "noor", "evaluations", "cmu-mscv-fall-2027.yml"));
  assert(ari.catalog_id === noor.catalog_id, "Student evaluations should be allowed to share a catalog_id");
  assert(ari.fit_score !== noor.fit_score, "Student-scoped evaluations should be able to differ");
}

function validateCatalogOnlyRuntimeRejection(programId) {
  writeYaml(path.join(validationRoot, "students", "catalog-only", "preferences.yml"), {
    target_fields: ["validation"],
    countries: ["United States"],
    intakes: ["Fall 2027"],
  });
  let compareFailed = false;
  try {
    runCompare({
      programs: [programId, "ucl-msc-hci-fall-2027"],
      workspace: validationRoot,
      student: "catalog-only",
      dryRunRoot: path.join(validationRoot, "dry-run", "compare-catalog-only"),
      date: "2026-06-27",
      write: false,
    });
  } catch (error) {
    compareFailed = /Cannot compare catalog-only program|Missing normalized evaluated-program record/.test(error.message);
  }
  assert(compareFailed, "Compare should reject catalog-only records");

  let cvFailed = false;
  try {
    runLiveCv({
      program: programId,
      workspace: validationRoot,
      student: "missing-student",
      dryRunRoot: path.join(validationRoot, "dry-run", "cv-catalog-only"),
      write: false,
    });
  } catch (error) {
    cvFailed = /Cannot render catalog-only program|Missing required file/.test(error.message);
  }
  assert(cvFailed, "CV runner should reject catalog-only records");
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
    "material_behavior",
    "material_behavior_reason",
  ];
  return Object.fromEntries(allowed.filter((key) => key in program).map((key) => [key, clone(program[key])]));
}

function studentEvaluationFromProgram(program) {
  const fields = [
    "id",
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
  return Object.fromEntries(fields.filter((key) => key in program).map((key) => [key, clone(program[key])]));
}

function baseIdentity(record) {
  return [record.institution, record.program, record.degree_type, record.intake]
    .map((value) => String(value || "").trim().toLowerCase())
    .join("||");
}

function readYaml(file) {
  return yaml.load(fs.readFileSync(file, "utf8"));
}

function writeYaml(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, yaml.dump(value, { lineWidth: 100 }));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

main();
