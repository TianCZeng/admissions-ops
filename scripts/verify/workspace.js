const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const yaml = require("js-yaml");
const { REVIEW_STATUS } = require("../lib/cv-writer");
const { STUDENT_INPUT_EXAMPLES } = require("../lib/workspace");
const { runCheck } = require("../cli/check");
const { runCompare } = require("../cli/compare");
const { runLiveCv } = require("../cli/cv");
const { runInit } = require("../cli/init");
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
const initRoot = path.join(validationRoot, "init");
const checkRoot = path.join(validationRoot, "check");
const DEMO_WORKSPACES = ["nus-cs", "tsinghua-automation"];

// Each case is one edit to a copy of the nus-cs inputs, and must produce exactly
// the one problem it names, so a check that fires on everything cannot pass.
const CHECK_CASES = [
  {
    id: "example-header",
    edit: (inputs) => {
      inputs["preferences.yml"] = `${exampleFirstLine("preferences.yml")}\n${inputs["preferences.yml"]}`;
    },
    expect: /^preferences\.yml: still begins with the example line/,
  },
  { id: "missing-file", edit: (inputs) => delete inputs["master-cv.md"], expect: /^master-cv\.md: missing$/ },
  {
    id: "missing-id",
    evidence: (evidence) => delete evidence.courses[0].id,
    expect: /^evidence\.yml: courses\[0\] has no id$/,
  },
  {
    id: "duplicate-id",
    evidence: (evidence) => {
      evidence.projects[0].id = evidence.research[0].id;
    },
    expect: /^evidence\.yml: projects\[0\] repeats id "research-[^"]+" already used in research/,
  },
  {
    id: "cjk-rendered-field",
    evidence: (evidence) => {
      evidence.awards[0].title = "优秀学生";
    },
    expect: /^evidence\.yml: evidence\.awards\[award-[^\]]+\]\.title contains Han/,
  },
  {
    id: "cjk-profile-name",
    profile: (profile) => {
      profile.student.name = "陈书涵";
    },
    expect: /^profile\.yml: profile\.student\.name contains Han/,
  },
  // A field the renderer never reads may keep the original for a reviewer.
  {
    id: "cjk-original-title",
    evidence: (evidence) => {
      evidence.awards[0].original_title = "优秀学生";
    },
    expect: null,
  },
];
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
  validateInit();
  validateCheck();
  validatePrivateBackupIgnore();

  console.log(`Student workspace layout verifies in ${path.relative(process.cwd(), validationRoot)}`);
}

function validateInit() {
  const root = path.join(initRoot, "students", "fresh");
  runInit({ workspace: initRoot, student: "fresh" });
  for (const [name, example] of Object.entries(STUDENT_INPUT_EXAMPLES)) {
    assert(
      fs.readFileSync(path.join(root, name), "utf8") === fs.readFileSync(path.join(repoRoot, example), "utf8"),
      `init did not copy ${example} into ${name}`
    );
  }
  assert(fs.readFileSync(path.join(root, "tracker.md"), "utf8") === emptyTracker(), "init tracker is not the empty tracker");
  // Inputs only: no statement brief (its existence turns statement drafting on)
  // and none of the generated state the program pipeline owns.
  const expected = [...Object.keys(STUDENT_INPUT_EXAMPLES), "tracker.md"].sort();
  assert(
    JSON.stringify(fs.readdirSync(root).sort()) === JSON.stringify(expected),
    `init wrote unexpected entries: ${fs.readdirSync(root).join(", ")}`
  );
  const fresh = runCheck({ workspace: initRoot, student: "fresh" });
  assert(
    fresh.problems.length === Object.keys(STUDENT_INPUT_EXAMPLES).length &&
      fresh.problems.every((problem) => /still begins with the example line/.test(problem)),
    `check must refuse every input of a fresh init: ${fresh.problems.join("; ")}`
  );

  const rawRoot = path.join(initRoot, "students", "with-raw");
  writeText(path.join(rawRoot, "raw", "cv.txt"), "Synthetic CV text.\n");
  runInit({ workspace: initRoot, student: "with-raw" });
  assert(fs.existsSync(path.join(rawRoot, "profile.yml")), "init should accept a workspace that holds only raw/");
  assert(fs.readFileSync(path.join(rawRoot, "raw", "cv.txt"), "utf8") === "Synthetic CV text.\n", "init changed raw/");

  // One existing input is enough to refuse, and a refusal writes nothing.
  const partialRoot = path.join(initRoot, "students", "partial");
  writeText(path.join(partialRoot, "evidence.yml"), "education: []\n");
  expectFailure(
    () => runInit({ workspace: initRoot, student: "partial" }),
    /Refusing to overwrite existing evidence\.yml in /,
    "init should refuse a workspace that already has evidence.yml"
  );
  assert(JSON.stringify(fs.readdirSync(partialRoot)) === JSON.stringify(["evidence.yml"]), "a refused init still wrote files");
  assert(fs.readFileSync(path.join(partialRoot, "evidence.yml"), "utf8") === "education: []\n", "a refused init changed evidence.yml");
  expectFailure(
    () => runInit({ workspace: initRoot, student: "fresh" }),
    /Refusing to overwrite existing profile\.yml, preferences\.yml, evidence\.yml, master-cv\.md, tracker\.md/,
    "init should refuse to run twice on one workspace"
  );

  for (const id of ["../escape", "a/b", ".hidden", "-dash", "x..y"]) {
    expectFailure(() => runInit({ workspace: initRoot, student: id }), /Invalid --student id/, `init accepted invalid id ${id}`);
  }
  expectFailure(() => runInit({ workspace: initRoot }), /Missing required --student/, "init should require --student");
  assert(!fs.existsSync(path.join(initRoot, "escape")), "init wrote outside students/ for a traversal id");

  const cliArgs = [path.join(repoRoot, "scripts", "cli", "init.js"), "--workspace", initRoot, "--student", "printed"];
  const printed = spawnSync(process.execPath, cliArgs, { encoding: "utf8" });
  assert(printed.status === 0, `init CLI failed: ${printed.stderr}`);
  for (const step of [
    "$admissions-ops setup for student printed",
    "npm run check -- --student printed",
    "$admissions-ops program for student printed:",
  ]) {
    assert(printed.stdout.includes(step), `init output missing next step: ${step}`);
  }
  const rerun = spawnSync(process.execPath, cliArgs, { encoding: "utf8" });
  assert(rerun.status === 1 && /Refusing to overwrite/.test(rerun.stderr), "init CLI rerun should exit 1 with the refusal");

  // A new workspace in the real tree stays ignored. The path is asked about,
  // never created, so this cannot leave anything behind.
  if (!gitAvailable(repoRoot)) {
    console.log("Skipped the new-workspace ignore check: not a git checkout");
    return;
  }
  for (const name of expected) {
    assert(gitIgnored(repoRoot, `students/init-fixture/${name}`), `A new workspace file is not ignored: students/init-fixture/${name}`);
  }
}

function validateCheck() {
  const before = hashTree(path.join(repoRoot, "students"), DEMO_WORKSPACES);
  for (const id of DEMO_WORKSPACES) {
    const result = runCheck({ student: id });
    assert(result.problems.length === 0, `check should pass on students/${id}/: ${result.problems.join("; ")}`);
  }

  const source = Object.fromEntries(
    Object.keys(STUDENT_INPUT_EXAMPLES).map((name) => [
      name,
      fs.readFileSync(path.join(repoRoot, "students", DEMO_WORKSPACES[0], name), "utf8"),
    ])
  );
  for (const checkCase of CHECK_CASES) {
    const inputs = { ...source };
    if (checkCase.edit) checkCase.edit(inputs);
    if (checkCase.evidence) inputs["evidence.yml"] = editYaml(inputs["evidence.yml"], checkCase.evidence);
    if (checkCase.profile) inputs["profile.yml"] = editYaml(inputs["profile.yml"], checkCase.profile);
    for (const [name, text] of Object.entries(inputs)) {
      writeText(path.join(checkRoot, "students", checkCase.id, name), text);
    }
  }
  const casesBefore = hashTree(path.join(checkRoot, "students"));
  for (const checkCase of CHECK_CASES) {
    const { problems } = runCheck({ workspace: checkRoot, student: checkCase.id });
    if (!checkCase.expect) {
      assert(problems.length === 0, `check case ${checkCase.id} should pass: ${problems.join("; ")}`);
      continue;
    }
    assert(
      problems.length === 1 && checkCase.expect.test(problems[0]),
      `check case ${checkCase.id} should report exactly ${checkCase.expect}; got: ${problems.join("; ") || "nothing"}`
    );
  }

  const cli = spawnSync(
    process.execPath,
    [path.join(repoRoot, "scripts", "cli", "check.js"), "--workspace", checkRoot, "--student", "missing-id"],
    { encoding: "utf8" }
  );
  assert(cli.status === 1 && /courses\[0\] has no id/.test(cli.stderr), "check CLI should exit 1 and name the problem");

  assert(sameHashes(before, hashTree(path.join(repoRoot, "students"), DEMO_WORKSPACES)), "check wrote into a demo workspace");
  assert(sameHashes(casesBefore, hashTree(path.join(checkRoot, "students"))), "check wrote into a checked workspace");
}

// The README's private-backup step appends `!/students/<your-id>/` to a private
// copy's .gitignore. That has to track the workspace while every
// `/students/*/<folder>/` rule (raw/ first, where setup keeps the user's CV and
// transcript) and every other workspace stay ignored. Proven against the
// shipped .gitignore so a change to it breaks here, not in someone's backup.
function validatePrivateBackupIgnore() {
  const backupRoot = path.join(validationRoot, "private-backup");
  if (!gitAvailable()) {
    console.log("Skipped the private-backup ignore check: git is not available");
    return;
  }
  const gitignore = fs.readFileSync(path.join(repoRoot, ".gitignore"), "utf8");
  const sensitive = [...gitignore.matchAll(/^\/students\/\*\/([^/\s]+)\/$/gm)].map((match) => match[1]);
  assert(sensitive.includes("raw"), ".gitignore must keep /students/*/raw/ ignored; setup reads source documents from there");
  writeText(path.join(backupRoot, ".gitignore"), `${gitignore}\n!/students/ada/\n`);
  const init = spawnSync("git", ["init", "-q"], { cwd: backupRoot, stdio: "ignore" });
  assert(init.status === 0, "git init failed for the private-backup check");

  for (const tracked of ["students/ada/profile.yml", "students/ada/evaluations/example.yml", "students/ada/output/example/statement-draft.md"]) {
    assert(!gitIgnored(backupRoot, tracked), `Private backup would not track ${tracked}`);
  }
  for (const folder of sensitive) {
    assert(gitIgnored(backupRoot, `students/ada/${folder}/file.pdf`), `Private backup would track students/ada/${folder}/`);
  }
  assert(gitIgnored(backupRoot, "students/someone-else/profile.yml"), "Private backup would track another workspace");
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

function exampleFirstLine(name) {
  return fs.readFileSync(path.join(repoRoot, STUDENT_INPUT_EXAMPLES[name]), "utf8").split("\n", 1)[0];
}

function editYaml(text, edit) {
  const data = yaml.load(text);
  edit(data);
  return yaml.dump(data, { lineWidth: 100 });
}

// The user's global excludes file is switched off so only the repository's own
// .gitignore decides.
function gitIgnored(cwd, relative) {
  const result = spawnSync("git", ["-c", "core.excludesFile=", "check-ignore", "-q", relative], { cwd });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`git check-ignore failed in ${cwd} for ${relative}`);
}

function gitAvailable(cwd) {
  const args = cwd ? ["rev-parse", "--is-inside-work-tree"] : ["--version"];
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return result.status === 0 && (!cwd || result.stdout.trim() === "true");
}

function hashTree(root, only) {
  const hashes = {};
  for (const entry of only || fs.readdirSync(root).sort()) {
    const full = path.join(root, entry);
    if (fs.statSync(full).isDirectory()) {
      for (const [file, hash] of Object.entries(hashTree(full))) hashes[`${entry}/${file}`] = hash;
    } else {
      hashes[entry] = hashFile(full);
    }
  }
  return hashes;
}

function sameHashes(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function expectFailure(run, pattern, message) {
  let error;
  try {
    run();
  } catch (caught) {
    error = caught;
  }
  assert(error && pattern.test(error.message), `${message}${error ? `: ${error.message}` : " (it succeeded)"}`);
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
