const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const { parseTracker } = require("../lib/program-writer");
const { resolveWorkspace } = require("../lib/workspace");
const { validateProgramArtifacts } = require("../lib/consistency");

const repoRoot = path.resolve(__dirname, "..", "..");
const liveStudentId = "nus-cs";
const liveStudentRoot = path.join(repoRoot, "students", liveStudentId);
const REQUIRED_REAL_PROGRAMS = [
  "cmu-mscv-fall-2027",
  "ucl-msc-hci-fall-2027",
  "uw-ms-hcde-fall-2027",
  "berkeley-mims-fall-2027",
  "epfl-eth-ms-cyber-security-fall-2027",
  "nus-master-computing-cs-fall-2027",
];

function main() {
  validateFreshTemplate();
  validateLiveStudentWorkspace();
  validateCatalogs();
  console.log("Fresh setup template and live NUS CS workspace verify with retained real program catalog records");
}

// Fresh-setup invariants are proven against the shipped *.example.* template,
// not against the live student workspace. A new user copies these files to
// start; the tracker example must contain no evaluated program rows.
function validateFreshTemplate() {
  for (const file of [
    "students/profile.example.yml",
    "students/preferences.example.yml",
    "students/evidence.example.yml",
    "students/master-cv.example.md",
    "students/statement-brief.example.md",
    "students/tracker.example.md",
  ]) {
    assert(fs.existsSync(path.join(repoRoot, file)), `Missing fresh setup template: ${file}`);
  }
  const tracker = fs.readFileSync(path.join(repoRoot, "students", "tracker.example.md"), "utf8");
  assert(parseTracker(tracker).rows.length === 0, "Fresh tracker example should contain no evaluated program rows");
}

// The live student workspace may be either a fresh setup (inputs only) or a
// post-pipeline state with generated evaluations, reports, checklists, tracker
// rows, and output. When generated state exists, every evaluated program must
// pass the deterministic artifact-consistency contract and resolve its links.
function validateLiveStudentWorkspace() {
  for (const relative of ["profile.yml", "preferences.yml", "evidence.yml", "master-cv.md", "tracker.md"]) {
    assert(fs.existsSync(path.join(liveStudentRoot, relative)), `Missing live student input: students/${liveStudentId}/${relative}`);
  }

  const evaluationsDir = path.join(liveStudentRoot, "evaluations");
  if (!fs.existsSync(evaluationsDir)) return; // fresh setup is a valid state

  const workspace = resolveWorkspace({ student: liveStudentId });
  const evaluations = fs.readdirSync(evaluationsDir).filter((file) => file.endsWith(".yml"));
  for (const file of evaluations) {
    const programId = file.replace(/\.yml$/, "");
    validateProgramArtifacts(workspace, programId);
    const evaluation = readYaml(path.join(evaluationsDir, file));
    if (Array.isArray(evaluation.action_items) && evaluation.action_items.length > 0) {
      const checklistsDir = path.join(liveStudentRoot, "checklists");
      assert(
        fs.existsSync(checklistsDir) && fs.readdirSync(checklistsDir).length > 0,
        `Live workspace has open action items for ${programId} but no checklist`
      );
    }
  }
}

function validateCatalogs() {
  const dir = path.join(repoRoot, "programs", "catalog");
  for (const id of REQUIRED_REAL_PROGRAMS) {
    const file = path.join(dir, `${id}.yml`);
    assert(fs.existsSync(file), `Missing catalog record: ${id}`);
    const catalog = readYaml(file);
    assert(catalog.id === id, `Catalog id mismatch: ${id}`);
    assert(/^https:\/\//.test(catalog.official_url), `Catalog official URL must be HTTPS: ${id}`);
    assert(catalog.retrieved_at, `Catalog missing retrieval date: ${id}`);
    assert(catalog.sources && catalog.sources.length > 0, `Catalog missing sources: ${id}`);
    assert(!/example\.edu|example\.test/.test(JSON.stringify(catalog)), `Catalog contains placeholder URL: ${id}`);
    assert(!/Redwood Institute|redwood-msc-applied-machine-learning/i.test(JSON.stringify(catalog)), `Catalog contains Redwood placeholder state: ${id}`);
    for (const forbidden of ["eligibility", "fit", "fit_score", "cv_adaptation_plan", "action_items", "tailored_cv"]) {
      assert(!(forbidden in catalog), `Catalog contains student-specific field ${forbidden}: ${id}`);
    }
  }
}

function readYaml(file) {
  return yaml.load(fs.readFileSync(file, "utf8"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

main();
