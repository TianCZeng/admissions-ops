const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const { runLiveCv } = require("../cli/cv");
const { runLiveStatement } = require("../cli/statement");
const { resolveWorkspace } = require("../lib/workspace");
const { validateProgramArtifacts } = require("../lib/consistency");
const { parseTracker, renderTracker, reportFileName } = require("../lib/program-writer");

const repoRoot = path.resolve(__dirname, "..", "..");
const validationRoot = path.join(repoRoot, "validation-output", "verify", "generated");
const CV_ARTIFACT_NAMES = ["academic-cv.html", "admissions-resume.html"];

// verify:generated closes the coverage blind spot the six-case batch QA found:
// npm run verify used to validate only fixtures and the *.example.* templates,
// never a freshly generated students/* workspace. This target treats every
// committed student workspace with evaluations as a multi-student generated
// fixture: (A) each evaluated program must pass the artifact-consistency
// contract, (B) re-rendering through the deterministic runners must reproduce
// the committed files byte-for-byte (hand-edited output cannot survive), and
// (C) injected drift on scratch copies must be rejected with the expected
// diagnostics.
function main() {
  resetValidationRoot();
  const workspaces = discoverGeneratedWorkspaces();
  if (workspaces.length === 0) {
    console.log("No generated student workspaces with evaluations found; nothing to verify");
    return;
  }
  validateCommittedWorkspaces(workspaces);
  validateRerenderReproduction(workspaces);
  validateInjectedDrift(workspaces);
  const programCount = workspaces.reduce((sum, ws) => sum + ws.programIds.length, 0);
  console.log(
    `Generated workspaces verify: ${workspaces.length} students, ${programCount} programs, re-render reproduction and drift rejection in ${path.relative(process.cwd(), validationRoot)}`
  );
}

function resetValidationRoot() {
  assert(
    validationRoot.startsWith(path.join(repoRoot, "validation-output")),
    `Refusing reset outside validation-output: ${validationRoot}`
  );
  fs.rmSync(validationRoot, { recursive: true, force: true });
  fs.mkdirSync(validationRoot, { recursive: true });
}

function discoverGeneratedWorkspaces() {
  const studentsDir = path.join(repoRoot, "students");
  if (!fs.existsSync(studentsDir)) return [];
  const workspaces = [];
  for (const entry of fs.readdirSync(studentsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const root = path.join(studentsDir, entry.name);
    const evaluationsDir = path.join(root, "evaluations");
    if (!fs.existsSync(path.join(root, "profile.yml")) || !fs.existsSync(evaluationsDir)) continue;
    const programIds = fs
      .readdirSync(evaluationsDir)
      .filter((file) => file.endsWith(".yml"))
      .map((file) => file.replace(/\.yml$/, ""))
      .sort();
    if (programIds.length > 0) workspaces.push({ studentId: entry.name, root, programIds });
  }
  return workspaces.sort((left, right) => left.studentId.localeCompare(right.studentId));
}

// Part A: every committed evaluated program passes the consistency contract.
function validateCommittedWorkspaces(workspaces) {
  for (const ws of workspaces) {
    const workspace = resolveWorkspace({ student: ws.studentId });
    for (const programId of ws.programIds) {
      try {
        validateProgramArtifacts(workspace, programId);
      } catch (error) {
        throw new Error(`Committed workspace students/${ws.studentId} failed for ${programId}:\n${error.message}`);
      }
    }
  }
}

// Part B: re-running the deterministic CV renderer and statement packager on a
// copy must be a fixpoint of the committed state. Any hand-edited generated
// file breaks byte equality here.
function validateRerenderReproduction(workspaces) {
  for (const ws of workspaces) {
    const scratchBase = path.join(validationRoot, "rerender", ws.studentId);
    copyWorkspace(ws, scratchBase);
    for (const programId of ws.programIds) {
      const committedOutput = path.join(ws.root, "output", programId);
      const cvWritten = CV_ARTIFACT_NAMES.some((name) => fs.existsSync(path.join(committedOutput, name)));
      const statementWritten = fs.existsSync(path.join(committedOutput, "statement-draft.md"));
      if (cvWritten) {
        runLiveCv({ program: programId, student: ws.studentId, workspace: scratchBase, write: true });
      }
      if (statementWritten) {
        runLiveStatement({ program: programId, student: ws.studentId, workspace: scratchBase, write: true });
      }
    }
    compareTrees(ws.root, path.join(scratchBase, "students", ws.studentId), ws.studentId);
  }
}

// Part C: injected drift on scratch copies must be rejected. Covers the drift
// classes from the batch QA, including the filename-order trap in both
// directions (the pre-fix checker picked admissions-resume.html first).
function validateInjectedDrift(workspaces) {
  const targets = collectDriftTargets(workspaces);
  const target = targets.resume || targets.academic;
  if (!target) {
    console.log("No workspace with a written CV artifact; skipping drift injection cases");
    return;
  }

  expectRejected("tracker-next-action-drift", target, (root) => {
    mutateTracker(root, target, (row) => ({ ...row, "Next Action": "Hand-edited next action that drifted" }));
  }, /next_action does not match/);

  expectRejected("broken-report-link", target, (root) => {
    const reportFile = reportPathFor(root, target);
    const text = fs.readFileSync(reportFile, "utf8");
    const mutated = text.replace(
      /^(\*\*Tailored CV:\*\* \[[^\]]*\]\()([^)]+)(\).*)$/m,
      "$1../output/wrong/wrong-artifact.html$3"
    );
    assert(mutated !== text, "broken-report-link mutation did not change the report");
    fs.writeFileSync(reportFile, mutated);
  }, /Report Tailored CV link target does not match/);

  expectRejected("missing-review-marker", target, (root) => {
    mutateTracker(root, target, (row) => {
      const linkTarget = String(row.CV).match(/\]\(([^)]+)\)/);
      assert(linkTarget, "missing-review-marker fixture row has no CV link");
      return { ...row, CV: `[draft](${linkTarget[1]})` };
    });
  }, /Tracker CV column missing Review Required marker/);

  for (const [label, driftTarget] of Object.entries(targets)) {
    if (!driftTarget) continue;
    const staleName = label === "academic" ? "admissions-resume.html" : "academic-cv.html";
    expectRejected(`lingering-artifact-${label}`, driftTarget, (root) => {
      const outputDir = path.join(root, "students", driftTarget.studentId, "output", driftTarget.programId);
      fs.writeFileSync(path.join(outputDir, staleName), "<html><body>stale artifact</body></html>");
    }, /more than one CV artifact/, (message) => {
      // The checker must still validate the linked artifact, not the stale one
      // that sorts first: no false evidence-set mismatch may appear.
      assert(
        !/Rendered evidence set differs|data-evidence-id set differ/.test(message),
        `lingering-artifact-${label} produced a false evidence mismatch against the stale artifact:\n${message}`
      );
    });
  }

  expectRejected("evidence-priorities-drift", target, (root) => {
    mutateEvaluation(root, target, (evaluation) => {
      const priorities = evaluation.cv_adaptation_plan.evidence_priorities;
      assert(Array.isArray(priorities) && priorities.length > 1, "fixture plan has too few priorities to drift");
      priorities.pop();
    });
  }, /Rendered evidence set differs from cv_adaptation_plan.evidence_priorities/);

  expectRejected("test-gate-met-without-evidence", target, (root) => {
    mutateEvaluation(root, target, (evaluation) => {
      evaluation.eligibility.push({
        requirement: "English language test sub-scores",
        status: "met",
        evidence: "none",
        source: "https://example.org/injected",
        notes: "Injected drift case.",
      });
    });
  }, /Language\/standardized-test gate is 'met' with no evidence/);

  // Scope check: a logistical row with met/none must NOT trip the test-gate
  // lint; the workspace still validates.
  {
    const { root, workspace } = copyForDrift("logistical-row-not-flagged", target);
    mutateEvaluation(root, target, (evaluation) => {
      evaluation.eligibility.push({
        requirement: "Official transcripts uploaded before submission portal check",
        status: "met",
        evidence: "none",
        source: "https://example.org/injected",
        notes: "Injected logistical row; the scoped lint must not fire.",
      });
    });
    validateProgramArtifacts(workspace, target.programId);
  }

  expectRejected("bad-eligibility-vocabulary", target, (root) => {
    mutateEvaluation(root, target, (evaluation) => {
      evaluation.eligibility_summary = "borderline";
    });
  }, /eligibility_summary 'borderline' is not one of eligible, likely, unclear, ineligible/);
}

function collectDriftTargets(workspaces) {
  const targets = { academic: null, resume: null };
  for (const ws of workspaces) {
    for (const programId of ws.programIds) {
      const outputDir = path.join(ws.root, "output", programId);
      const statementWritten = fs.existsSync(path.join(outputDir, "statement-draft.md"));
      if (!targets.academic && fs.existsSync(path.join(outputDir, "academic-cv.html"))) {
        targets.academic = { studentId: ws.studentId, programId, statementWritten };
      }
      if (!targets.resume && fs.existsSync(path.join(outputDir, "admissions-resume.html"))) {
        targets.resume = { studentId: ws.studentId, programId, statementWritten };
      }
    }
  }
  return targets;
}

function expectRejected(name, target, mutate, pattern, extraCheck) {
  const { root, workspace } = copyForDrift(name, target);
  mutate(root);
  let failed = false;
  let message = "";
  try {
    validateProgramArtifacts(workspace, target.programId);
  } catch (error) {
    failed = true;
    message = error.message;
  }
  assert(failed, `Expected consistency check to reject drift case: ${name}`);
  assert(pattern.test(message), `Drift case ${name} threw an unexpected message:\n${message}`);
  if (extraCheck) extraCheck(message);
}

function copyForDrift(name, target) {
  const base = path.join(validationRoot, "drift", name);
  const sourceRoot = path.join(repoRoot, "students", target.studentId);
  copyDir(sourceRoot, path.join(base, "students", target.studentId));
  copyDir(path.join(repoRoot, "programs", "catalog"), path.join(base, "programs", "catalog"));
  return { root: base, workspace: resolveWorkspace({ workspace: base, student: target.studentId }) };
}

function copyWorkspace(ws, scratchBase) {
  copyDir(ws.root, path.join(scratchBase, "students", ws.studentId));
  copyDir(path.join(repoRoot, "programs", "catalog"), path.join(scratchBase, "programs", "catalog"));
}

function copyDir(source, destination) {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true });
}

function compareTrees(committedRoot, rerenderedRoot, studentId) {
  const committed = listFiles(committedRoot);
  const rerendered = listFiles(rerenderedRoot);
  const committedSet = new Set(committed);
  const rerenderedSet = new Set(rerendered);
  for (const file of committed) {
    assert(rerenderedSet.has(file), `Re-render dropped a committed file for ${studentId}: ${file}`);
  }
  for (const file of rerendered) {
    assert(committedSet.has(file), `Re-render created an uncommitted file for ${studentId}: ${file}`);
  }
  for (const file of committed) {
    const left = fs.readFileSync(path.join(committedRoot, file));
    const right = fs.readFileSync(path.join(rerenderedRoot, file));
    assert(
      left.equals(right),
      `Re-rendering students/${studentId}/${file} does not reproduce the committed file; generated artifacts must come from the deterministic runners, never hand edits`
    );
  }
}

function listFiles(root) {
  const results = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else results.push(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  walk(root);
  return results.sort();
}

function mutateTracker(root, target, mapRow) {
  const trackerPath = path.join(root, "students", target.studentId, "tracker.md");
  const evaluation = readEvaluation(root, target);
  const parsed = parseTracker(fs.readFileSync(trackerPath, "utf8"));
  let updated = 0;
  const rows = parsed.rows.map((row) => {
    if (row.Program !== evaluation.program || row.Intake !== evaluation.intake) return row;
    updated += 1;
    return mapRow(row);
  });
  assert(updated === 1, `Expected one tracker row for ${target.programId}, updated ${updated}`);
  fs.writeFileSync(trackerPath, renderTracker(parsed.prelude, rows));
}

function mutateEvaluation(root, target, mutate) {
  const file = evaluationPathFor(root, target);
  const evaluation = yaml.load(fs.readFileSync(file, "utf8"));
  mutate(evaluation);
  fs.writeFileSync(file, yaml.dump(evaluation, { lineWidth: 100 }));
}

function readEvaluation(root, target) {
  return yaml.load(fs.readFileSync(evaluationPathFor(root, target), "utf8"));
}

function evaluationPathFor(root, target) {
  return path.join(root, "students", target.studentId, "evaluations", `${target.programId}.yml`);
}

function reportPathFor(root, target) {
  const evaluation = readEvaluation(root, target);
  return path.join(root, "students", target.studentId, "reports", reportFileName(evaluation));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

main();
