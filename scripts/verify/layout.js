const fs = require("fs");
const path = require("path");
const { dryRunRoot, resolveWorkspace } = require("../lib/workspace");

const repoRoot = path.resolve(__dirname, "..", "..");
const validationRoot = path.join(repoRoot, "validation-output");

function main() {
  validateScriptLayout();
  validatePackageScripts();
  validatePipelineContracts();
  validatePublicReadmeContract();
  validateGithubMeta();
  validateSeedArchive();
  validateValidationOutputReferences();
  validateRuntimeDryRunRoots();
  validateStudentExamplesAndRootPlaceholders();
  validateLiveStudentWorkspace();
  console.log("Runtime, fixture, and validation layout verifies");
}

function validatePipelineContracts() {
  const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
  const agents = fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8");
  const dataContract = fs.readFileSync(path.join(repoRoot, "DATA_CONTRACT.md"), "utf8");
  const router = fs.readFileSync(path.join(repoRoot, ".agents", "skills", "admissions-ops", "SKILL.md"), "utf8");
  const sharedMode = fs.readFileSync(path.join(repoRoot, "modes", "_shared.md"), "utf8");
  const programMode = fs.readFileSync(path.join(repoRoot, "modes", "program.md"), "utf8");
  const cvMode = fs.readFileSync(path.join(repoRoot, "modes", "cv.md"), "utf8");
  const statementMode = fs.readFileSync(path.join(repoRoot, "modes", "statement.md"), "utf8");

  assert(readme.includes("$admissions-ops program for student <student-id>:"), "README missing short full-pipeline prompt");
  assert(!readme.includes("Read the selected student workspace:"), "README prompt still contains moved operational detail");
  assert(router.includes("## Full Pipeline Default"), "Router missing full pipeline default contract");
  assert(router.includes("--write-drafts"), "Router missing write-drafts pipeline flag");
  assert(router.includes("input beginning with `program`, including `--write-drafts`"), "Router should route program flags to program mode");
  assert(programMode.includes("Return one final review bundle"), "Program mode missing final review bundle requirement");
  assert(programMode.includes("npm run cv -- --student <student-id> --program <program-id>"), "Program mode missing deterministic dry-run step");
  assert(programMode.includes("npm run statement -- --student <student-id> --program <program-id>"), "Program mode missing automatic statement dry-run step");
  assert(programMode.includes("LLM-authored statement draft"), "Program mode must require an LLM-authored statement draft before packaging");
  assert(programMode.includes("structured claim map"), "Program mode must require a structured statement claim map");
  assert(programMode.includes("--write-drafts"), "Program mode missing write-drafts approval contract");
  assert(cvMode.includes("## Adaptation Plan Contract"), "CV mode missing adaptation plan contract");
  assert(cvMode.includes("fails before output generation"), "CV mode must describe pre-render failure");
  assert(router.includes("`statement` | `statement`"), "Router missing statement mode route");
  assert(/both CV\/resume rendering and statement\s+packaging/.test(readme), "README must explain the program pipeline runs both CV/resume and statement packaging");
  assert(readme.includes("--write-drafts"), "README missing write-drafts pipeline flag");
  assert(readme.includes("npm run statement -- --student <student-id> --program <program-id>"), "README missing statement dry-run command");
  assert(/deterministic statement\s+packager\/validator/.test(readme), "README must describe the statement dry-run as a packager/validator");
  assert(readme.includes("draft_markdown") && readme.includes("claim_map"), "README missing statement draft_markdown/claim_map contract");
  assert(readme.includes("agent-led"), "README must describe the workflow as agent-led");
  assert(readme.includes("Optional Codex CLI example"), "README must keep Codex only as an optional invocation example");
  assert(!/codex/i.test(router), "Router must not contain Codex-specific wording");
  for (const modeFile of fs.readdirSync(path.join(repoRoot, "modes")).filter((file) => file.endsWith(".md"))) {
    const text = fs.readFileSync(path.join(repoRoot, "modes", modeFile), "utf8");
    assert(!/codex/i.test(text), `Mode doc ${modeFile} must not contain Codex-specific wording`);
  }
  assert(agents.includes("LLM-authored statement draft") && agents.includes("structured claim map"), "AGENTS missing statement draft/claim-map policy");
  assert(dataContract.includes("statement packager/validator"), "DATA_CONTRACT missing statement packager/validator wording");
  assert(/The agent authors the\s+statement prose and claim map/.test(sharedMode), "Shared mode missing statement authorship boundary");
  assert(router.includes("statement draft, and claim map"), "Router missing statement draft/claim-map pipeline step");
  assert(router.includes("deterministic dry-run packager and validator"), "Router missing statement packager wording");
  assert(statementMode.includes("## Statement Plan Contract"), "Statement mode missing plan contract");
  assert(statementMode.includes("## Deterministic Packager/Validator"), "Statement mode missing deterministic packager contract");
  assert(statementMode.includes("draft_markdown") && statementMode.includes("claim_map"), "Statement mode missing draft_markdown/claim_map contract");
  assert(statementMode.includes("It must fail when"), "Statement mode must require failure when draft/map are missing");
  for (const [label, text] of Object.entries({ readme, agents, dataContract, router, programMode, statementMode })) {
    assert(!/statement dry-run renderer|deterministic statement dry-run renderer|deterministic statement runner|only renders/.test(text), `${label} still uses retired statement-renderer wording`);
  }
}

function validatePublicReadmeContract() {
  // The README is the public front page (open-source-plan Stage A3). These are
  // structural checks on the public-audience sections; reflowing prose is
  // fine, removing a section or its policy stance is not.
  const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
  assert(readme.includes("## How It Keeps The Agent Honest"), "README missing the agent-builder honesty section");
  assert(readme.includes("## Integrity & Disclaimers"), "README missing the integrity & disclaimer section");
  assert(readme.includes("not affiliated with"), "README disclaimer must state non-affiliation with universities");
  // Honest privacy claim (A6): must name the model-provider data flow rather
  // than implying nothing leaves the machine, and route sensitive data to
  // SECURITY.md.
  assert(readme.includes("model provider"), "README must disclose that content is sent to the agent's model provider");
  assert(readme.includes("SECURITY.md"), "README must point to SECURITY.md for data-exposure guidance");
  assert(/prohibit or restrict AI-written/.test(readme), "README disclaimer must surface program AI-essay policies");
  assert(readme.includes("fully synthetic"), "README must label the demo applicant as fully synthetic");
  assert(readme.includes("Use this template"), "README must keep the private-copy note (Use this template -> Private) as the no-fork path to a cloud backup");
  assert(readme.includes("core.symlinks"), "README must keep the Windows symlink setup note");
  assert(readme.includes("not a maintained deadline database"), "README must frame catalog records as dated snapshots");
  assert(readme.includes("actions/workflows/verify.yml/badge.svg"), "README missing the CI verify badge");
  assert(readme.includes("README.zh-CN.md"), "README must link the zh-CN translation");
  assert(/docs\/media\/demo\.(gif|mp4)/.test(readme), "README missing the launch demo embed");

  const zhReadme = fs.readFileSync(path.join(repoRoot, "README.zh-CN.md"), "utf8");
  assert(zhReadme.includes("$admissions-ops program for student <student-id>:"), "zh-CN README missing the canonical full-pipeline prompt");
  assert(zhReadme.includes("[English](README.md)"), "zh-CN README must link back to the English README");
  assert(zhReadme.includes("Review Required"), "zh-CN README must keep the Review Required state name");
  assert(zhReadme.includes("core.symlinks"), "zh-CN README must keep the Windows symlink setup note");
  assert(/docs\/media\/demo\.(gif|mp4)/.test(zhReadme), "zh-CN README missing the launch demo embed");
  assert(zhReadme.includes("模型供应商"), "zh-CN README must disclose the model-provider data flow");
  assert(zhReadme.includes("SECURITY.md"), "zh-CN README must point to SECURITY.md");
}

function validateGithubMeta() {
  // Launch-trust files (A6). These ship publicly (the sync strips only the
  // maintainer layer), so assert them in both the dev and public trees.
  const security = path.join(repoRoot, "SECURITY.md");
  assert(fs.existsSync(security), "SECURITY.md is missing");
  const securityText = fs.readFileSync(security, "utf8");
  assert(/applicant data/i.test(securityText), "SECURITY.md must warn against posting applicant data publicly");
  assert(/public issue/i.test(securityText), "SECURITY.md must tell users not to open public issues for sensitive reports");

  assert(fs.existsSync(path.join(repoRoot, ".github", "PULL_REQUEST_TEMPLATE.md")), "PR template is missing");
  for (const template of ["bug_report.md", "source_correction.md"]) {
    assert(
      fs.existsSync(path.join(repoRoot, ".github", "ISSUE_TEMPLATE", template)),
      `Issue template is missing: ${template}`
    );
  }
}

function validateScriptLayout() {
  assertDirFiles("scripts/cli", ["compare.js", "cv.js", "statement.js"]);
  assertDirFiles("scripts/lib", ["consistency.js", "cv-writer.js", "program-writer.js", "statement-writer.js", "workspace.js"]);
  assertDirFiles("scripts/verify", [
    "catalog.js",
    "compare.js",
    "consistency.js",
    "cv.js",
    "generated.js",
    "layout.js",
    "live-cv.js",
    "live-real.js",
    "program.js",
    "statement.js",
    "stress.js",
    "workspace.js",
    "yaml.js",
  ]);

  const topLevelJs = fs.readdirSync(path.join(repoRoot, "scripts"))
    .filter((entry) => entry.endsWith(".js"));
  assert(topLevelJs.length === 0, `scripts/ contains top-level JS files: ${topLevelJs.join(", ")}`);
}

function validatePackageScripts() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  for (const [name, command] of Object.entries(packageJson.scripts || {})) {
    const nodeMatch = command.match(/^node (scripts\/\S+\.js)$/);
    if (!nodeMatch) continue;
    assert(fs.existsSync(path.join(repoRoot, nodeMatch[1])), `package script ${name} points to missing file: ${nodeMatch[1]}`);
  }
  assert(packageJson.scripts.verify.includes("verify:layout"), "npm run verify must include verify:layout");
  assert(packageJson.scripts.verify.includes("verify:statement"), "npm run verify must include verify:statement");
  assert(packageJson.scripts.verify.includes("verify:consistency"), "npm run verify must include verify:consistency");
  assert(packageJson.scripts.verify.includes("verify:generated"), "npm run verify must include verify:generated");
  assert(packageJson.scripts.cv === "node scripts/cli/cv.js", "cv script should point to scripts/cli/cv.js");
  assert(packageJson.scripts.compare === "node scripts/cli/compare.js", "compare script should point to scripts/cli/compare.js");
  assert(packageJson.scripts.statement === "node scripts/cli/statement.js", "statement script should point to scripts/cli/statement.js");
  assert(!JSON.stringify(packageJson.scripts).includes("seed-live-real"), "seed-live-real must not be referenced by package scripts");
  assert(packageJson.scripts.test === "npm run verify", "package.json must alias test to the verify suite");
  assert(packageJson.engines && packageJson.engines.node === ">=20", "package.json must declare the Node engine floor (>=20)");
  for (const field of ["repository", "bugs", "homepage"]) {
    assert(packageJson[field], `package.json missing public metadata field: ${field}`);
  }
}

function validateSeedArchive() {
  assert(!fs.existsSync(path.join(repoRoot, "scripts", "seed-live-real.js")), "seed-live-real.js remains in active scripts");
  // maintainer-notes/ is the private maintainer layer and is absent from the
  // public distribution; enforce the archive location only when it exists.
  const maintainerNotes = path.join(repoRoot, "maintainer-notes");
  if (!fs.existsSync(maintainerNotes)) return;
  const archiveDir = path.join(maintainerNotes, "archive", "phase-5.4-seed-live-real");
  assert(fs.existsSync(path.join(archiveDir, "seed-live-real.js")), "Archived seed-live-real.js is missing");
  assert(fs.existsSync(path.join(archiveDir, "README.md")), "Archived seed README is missing");
}

function validateValidationOutputReferences() {
  for (const file of walk(path.join(repoRoot, "scripts", "verify")).filter((entry) => entry.endsWith(".js"))) {
    if (path.basename(file) === "layout.js" || path.basename(file) === "yaml.js" || path.basename(file) === "live-real.js") {
      continue;
    }
    const text = fs.readFileSync(file, "utf8");
    assert(
      text.includes('"validation-output", "verify"'),
      `Validator must use validation-output/verify/: ${rel(file)}`
    );
    assert(
      !text.includes('"validation-output", "live"') &&
        !text.includes('"validation-output", "compare"') &&
        !text.includes('"validation-output", "program"') &&
        !text.includes('"validation-output", "cv"') &&
        !text.includes('"validation-output", "stress"') &&
        !text.includes('"validation-output", "workspace"') &&
        !text.includes('"validation-output", "catalog"'),
      `Validator references a retired validation-output sibling: ${rel(file)}`
    );
  }
}

function validateRuntimeDryRunRoots() {
  const workspace = resolveWorkspace({ student: "layout-fixture" });
  const liveRoot = dryRunRoot("live", workspace, "cmu-mscv-fall-2027");
  const compareRoot = dryRunRoot("compare", workspace);
  const statementRoot = dryRunRoot("statement", workspace, "cmu-mscv-fall-2027");
  assert(
    liveRoot === path.join(validationRoot, "dry-run", "live", "layout-fixture", "cmu-mscv-fall-2027"),
    `Live dry-run root mismatch: ${rel(liveRoot)}`
  );
  assert(
    compareRoot === path.join(validationRoot, "dry-run", "compare", "layout-fixture"),
    `Compare dry-run root mismatch: ${rel(compareRoot)}`
  );
  assert(
    statementRoot === path.join(validationRoot, "dry-run", "statement", "layout-fixture", "cmu-mscv-fall-2027"),
    `Statement dry-run root mismatch: ${rel(statementRoot)}`
  );

  let failed = false;
  try {
    resolveWorkspace({});
  } catch (error) {
    failed = /Missing required --student <student-id>/.test(error.message);
  }
  assert(failed, "resolveWorkspace should require --student");
}

function validateStudentExamplesAndRootPlaceholders() {
  assert(!fs.existsSync(path.join(repoRoot, "student")), "Root student/ directory should not exist");

  for (const file of [
    "students/profile.example.yml",
    "students/preferences.example.yml",
    "students/evidence.example.yml",
    "students/master-cv.example.md",
    "students/statement-brief.example.md",
    "students/tracker.example.md",
  ]) {
    assert(fs.existsSync(path.join(repoRoot, file)), `Missing setup example: ${file}`);
  }

  for (const dir of ["programs/evaluations", "programs/checklists", "reports", "output"]) {
    const absolute = path.join(repoRoot, dir);
    const entries = fs.existsSync(absolute) ? fs.readdirSync(absolute).filter((entry) => entry !== ".gitkeep") : [];
    assert(entries.length === 0, `${dir}/ should contain only .gitkeep after live-state migration: ${entries.join(", ")}`);
  }
}

function validateLiveStudentWorkspace() {
  const root = path.join(repoRoot, "students", "nus-cs");
  for (const relative of [
    "profile.yml",
    "preferences.yml",
    "evidence.yml",
    "master-cv.md",
    "tracker.md",
  ]) {
    assert(fs.existsSync(path.join(root, relative)), `Missing NUS CS setup path: students/nus-cs/${relative}`);
  }

  // Generated student-scoped state (evaluations/, reports/, checklists/,
  // output/) is allowed here: after a successful program run the live
  // workspace is post-pipeline. Its internal consistency is enforced by
  // verify:live-real and verify:consistency. Layout only guards that root-level
  // live state stays empty (see validateStudentExamplesAndRootPlaceholders).
}

function assertDirFiles(relativeDir, expected) {
  const dir = path.join(repoRoot, relativeDir);
  const files = fs.readdirSync(dir).filter((entry) => entry.endsWith(".js")).sort();
  const expectedSorted = [...expected].sort();
  assert(
    JSON.stringify(files) === JSON.stringify(expectedSorted),
    `${relativeDir} file set mismatch: expected ${expectedSorted.join(", ")}, got ${files.join(", ")}`
  );
}

function walk(root) {
  if (!fs.existsSync(root)) return [];
  const results = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) results.push(...walk(full));
    else results.push(full);
  }
  return results;
}

function rel(file) {
  return path.relative(repoRoot, file).split(path.sep).join("/");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

main();
