const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");

// The four canonical inputs of a student workspace, each with the shipped
// example `npm run init` copies into it; `npm run check` reads the same list to
// catch an example that was never replaced. The tracker is not listed because
// init writes the program writer's own empty tracker. statement-brief.md is not
// listed because its existence is what turns statement drafting on, so an empty
// template must never appear on its own.
const STUDENT_INPUT_EXAMPLES = {
  "profile.yml": "students/profile.example.yml",
  "preferences.yml": "students/preferences.example.yml",
  "evidence.yml": "students/evidence.example.yml",
  "master-cv.md": "students/master-cv.example.md",
};

function resolveInsideRepoOrValidation(value, label) {
  const resolved = path.resolve(value);
  const validationRoot = path.join(REPO_ROOT, "validation-output");
  if (resolved === REPO_ROOT || isInside(resolved, REPO_ROOT) || isInside(resolved, validationRoot)) {
    return resolved;
  }
  throw new Error(`Refusing ${label} outside repository or validation output: ${resolved}`);
}

function resolveWorkspace(options = {}) {
  const baseRoot = resolveInsideRepoOrValidation(options.workspace || REPO_ROOT, "workspace");
  const studentId = options.student || "";
  if (!studentId) {
    throw new Error(
      "Missing required --student <student-id>; live applicant state must live under students/{student-id}/"
    );
  }
  assertSafeStudentId(studentId);
  const root = path.join(baseRoot, "students", studentId);
  return {
    mode: "student",
    studentId,
    baseRoot,
    root,
    profilePath: path.join(root, "profile.yml"),
    preferencesPath: path.join(root, "preferences.yml"),
    evidencePath: path.join(root, "evidence.yml"),
    masterCvPath: path.join(root, "master-cv.md"),
    statementBriefPath: path.join(root, "statement-brief.md"),
    trackerPath: path.join(root, "tracker.md"),
    evaluationsDir: path.join(root, "evaluations"),
    reportsDir: path.join(root, "reports"),
    checklistsDir: path.join(root, "checklists"),
    outputDir: path.join(root, "output"),
  };
}

function evaluationPath(workspace, programId, override) {
  if (override) return resolveUnderRoot(workspace.root, override, "evaluation path");
  return path.join(workspace.evaluationsDir, `${programId}.yml`);
}

function reportPath(workspace, evaluation, reportFileName) {
  const reportValue = evaluation.report_path || evaluation.report || evaluation.report_file;
  if (reportValue) return resolveUnderRoot(workspace.root, reportValue, "report path");
  return path.join(workspace.reportsDir, reportFileName(evaluation));
}

function dryRunRoot(kind, workspace, programId) {
  if (kind === "live") {
    return path.join(REPO_ROOT, "validation-output", "dry-run", "live", workspace.studentId, programId);
  }
  if (kind === "compare") {
    return path.join(REPO_ROOT, "validation-output", "dry-run", "compare", workspace.studentId);
  }
  if (kind === "statement") {
    return path.join(REPO_ROOT, "validation-output", "dry-run", "statement", workspace.studentId, programId);
  }
  throw new Error(`Unsupported dry-run kind: ${kind}`);
}

function resolveUnderRoot(root, value, label) {
  const resolved = path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
  if (!isInsideOrEqual(resolved, root)) {
    throw new Error(`Refusing ${label} outside workspace: ${resolved}`);
  }
  return resolved;
}

function assertDryRunRootSafe(root) {
  const validationRoot = path.join(REPO_ROOT, "validation-output");
  if (!isInside(root, validationRoot)) {
    throw new Error(`Refusing dry-run output outside validation-output: ${root}`);
  }
}

function requireFile(file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`Missing required file: ${file}`);
  }
}

// Surgically replace a top-level scalar status line (e.g. `tailored_cv:`,
// `statement:`) in an evaluation YAML file, preserving all other agent-authored
// content, ordering, and comments. Used by the live CV/statement writers to keep
// the evaluation's derived link status in sync with the report and tracker on an
// approved write. The field must already exist as a top-level key.
function updateEvaluationStatusField(filePath, field, value) {
  const original = fs.readFileSync(filePath, "utf8");
  const pattern = new RegExp(`^${field}:.*$`, "m");
  if (!pattern.test(original)) {
    throw new Error(`Evaluation record missing top-level ${field} field: ${filePath}`);
  }
  const escaped = String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const updated = original.replace(pattern, `${field}: "${escaped}"`);
  if (updated !== original) {
    fs.writeFileSync(filePath, updated);
  }
}

// Surgically update scalar fields inside the evaluation's cv_adaptation_plan
// block, preserving everything else. Used by the live CV writer to persist a
// user-approved --document-type override (and its rationale) so a subsequent
// flag-less run reproduces the same artifact. Only `document_type` and
// `document_type_rationale` may be updated; the block and `document_type`
// line must already exist because the plan is agent-authored.
function updateEvaluationPlanFields(filePath, updates) {
  const allowed = new Set(["document_type", "document_type_rationale"]);
  for (const field of Object.keys(updates)) {
    if (!allowed.has(field)) {
      throw new Error(`Refusing to update cv_adaptation_plan field: ${field}`);
    }
  }
  const original = fs.readFileSync(filePath, "utf8");
  const lines = original.split("\n");
  const blockStart = lines.findIndex((line) => /^cv_adaptation_plan:\s*$/.test(line));
  if (blockStart === -1) {
    throw new Error(`Evaluation record missing cv_adaptation_plan block: ${filePath}`);
  }
  let blockEnd = lines.length;
  for (let index = blockStart + 1; index < lines.length; index += 1) {
    if (/^[A-Za-z_#]/.test(lines[index])) {
      blockEnd = index;
      break;
    }
  }
  const findField = (field) => {
    for (let index = blockStart + 1; index < blockEnd; index += 1) {
      if (new RegExp(`^  ${field}:`).test(lines[index])) return index;
    }
    return -1;
  };
  const quote = (value) => `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

  if (updates.document_type !== undefined) {
    const index = findField("document_type");
    if (index === -1) {
      throw new Error(`cv_adaptation_plan missing document_type line: ${filePath}`);
    }
    lines[index] = `  document_type: ${updates.document_type}`;
  }
  if (updates.document_type_rationale !== undefined) {
    const index = findField("document_type_rationale");
    const line = `  document_type_rationale: ${quote(updates.document_type_rationale)}`;
    if (index === -1) {
      const anchor = findField("document_type");
      lines.splice(anchor + 1, 0, line);
    } else {
      lines[index] = line;
    }
  }
  const updated = lines.join("\n");
  if (updated !== original) {
    fs.writeFileSync(filePath, updated);
  }
}

function rel(rootDir, filePath) {
  return path.relative(rootDir, filePath).split(path.sep).join("/");
}

function assertSafeStudentId(studentId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(studentId) || studentId.includes("..")) {
    throw new Error(`Invalid --student id: ${studentId}`);
  }
}

function isInside(value, root) {
  const relative = path.relative(root, value);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isInsideOrEqual(value, root) {
  return value === root || isInside(value, root);
}

module.exports = {
  REPO_ROOT,
  STUDENT_INPUT_EXAMPLES,
  assertDryRunRootSafe,
  dryRunRoot,
  evaluationPath,
  rel,
  reportPath,
  requireFile,
  resolveInsideRepoOrValidation,
  resolveUnderRoot,
  resolveWorkspace,
  updateEvaluationPlanFields,
  updateEvaluationStatusField,
  isInside,
  isInsideOrEqual,
};
