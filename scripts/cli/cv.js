const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const {
  attachCvArtifactsToEvaluation,
  renderCvAdaptation,
  CLI_OVERRIDE_RATIONALE,
  DOCUMENT_TYPES,
  REVIEW_STATUS,
} = require("../lib/cv-writer");
const {
  parseTracker,
  renderCvArtifacts,
  renderTracker,
  reportFileName,
  trackerIdentity,
} = require("../lib/program-writer");
const {
  assertDryRunRootSafe,
  dryRunRoot,
  evaluationPath,
  reportPath,
  requireFile,
  resolveWorkspace,
  updateEvaluationPlanFields,
  updateEvaluationStatusField,
  isInsideOrEqual,
} = require("../lib/workspace");

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = runLiveCv(options);
    const mode = result.write ? "write" : "dry-run";
    console.log(`CV live ${mode} complete for ${result.programId}`);
    console.log(`Document type: ${result.documentType}`);
    console.log(`Review status: ${result.reviewStatus}`);
    console.log(`Output root: ${path.relative(process.cwd(), result.outputRoot) || "."}`);
    console.log(`Draft artifact: ${result.artifacts.artifact}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

function parseArgs(args) {
  const options = { write: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--write") {
      options.write = true;
    } else if (arg === "--program") {
      options.program = requireValue(args, ++index, arg);
    } else if (arg === "--evaluation") {
      options.evaluation = requireValue(args, ++index, arg);
    } else if (arg === "--workspace") {
      options.workspace = requireValue(args, ++index, arg);
    } else if (arg === "--student") {
      options.student = requireValue(args, ++index, arg);
    } else if (arg === "--document-type") {
      options.documentType = requireValue(args, ++index, arg);
      if (!DOCUMENT_TYPES.has(options.documentType)) {
        throw new Error(
          `Unsupported --document-type ${options.documentType}; use academic_cv or admissions_resume`
        );
      }
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.program) {
    throw new Error("Missing required --program <program-id>");
  }
  return options;
}

function requireValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function printHelp() {
  console.log(`Usage: npm run cv -- --student <student-id> --program <program-id> [--write] [--document-type academic_cv|admissions_resume] [--evaluation <path>] [--workspace <path>]

Defaults to dry-run mode. Dry-run reads live inputs but writes only to
validation-output/dry-run/live/<student-id>/<program-id>/.
--document-type overrides the plan's document type; the override and its
rationale are recorded in the change log, and --write persists the choice
into the evaluation's cv_adaptation_plan.
Use --write only after reviewing the dry-run output.`);
}

function runLiveCv(options) {
  const programId = options.program;
  const workspace = resolveWorkspace(options);
  const resolvedEvaluationPath = evaluationPath(workspace, programId, options.evaluation);
  const resolvedDryRunRoot = options.dryRunRoot ? path.resolve(options.dryRunRoot) : dryRunRoot("live", workspace, programId);
  const outputRoot = options.write ? workspace.root : resolvedDryRunRoot;

  if (!options.write) {
    assertDryRunRootSafe(outputRoot);
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }

  const catalogPath = path.join(workspace.baseRoot, "programs", "catalog", `${programId}.yml`);
  if (!fs.existsSync(resolvedEvaluationPath) && fs.existsSync(catalogPath)) {
    throw new Error(`Cannot render catalog-only program; missing student evaluation record: ${programId}`);
  }

  for (const file of [workspace.profilePath, workspace.evidencePath, workspace.masterCvPath, resolvedEvaluationPath, workspace.trackerPath]) {
    requireFile(file);
  }

  let evaluation = readYaml(resolvedEvaluationPath);
  if (!evaluation || typeof evaluation !== "object") {
    throw new Error(`Evaluation record is not a YAML object: ${resolvedEvaluationPath}`);
  }
  evaluation = mergeCatalog(workspace, evaluation, programId);
  if (evaluation.id && evaluation.id !== programId) {
    throw new Error(`Evaluation id ${evaluation.id} does not match --program ${programId}`);
  }
  if (!evaluation.id) evaluation.id = programId;

  const documentInstructions = evaluation.document_instructions || evaluation.documentInstructions || {};
  const reportPathValue = reportPath(workspace, evaluation, reportFileName);
  requireFile(reportPathValue);
  const trackerMatch = requireTrackerRow(workspace.trackerPath, evaluation);

  const profile = readYaml(workspace.profilePath);
  const evidence = readYaml(workspace.evidencePath);
  const masterCv = fs.readFileSync(workspace.masterCvPath, "utf8");

  if (!options.write) {
    copyReportAndTracker(workspace.root, outputRoot, reportPathValue, workspace.trackerPath);
  }

  const renderResult = renderCvAdaptation(outputRoot, {
    evaluation,
    profile,
    evidence,
    masterCv,
    documentInstructions,
    documentTypeOverride: options.documentType,
    sourceLabels: sourceLabels(workspace),
  });
  const linkedEvaluation = attachCvArtifactsToEvaluation(evaluation, renderResult);
  const documentType = renderResult.documentType;

  const targetReportPath = path.join(outputRoot, path.relative(workspace.root, reportPathValue));
  const targetTrackerPath = path.join(outputRoot, path.relative(workspace.root, workspace.trackerPath));
  const trackerCvLink = trackerCvLinkForWorkspace(linkedEvaluation.tailored_cv, workspace.mode);
  updateReportCvLinks(targetReportPath, linkedEvaluation);
  updateTrackerCvLink(targetTrackerPath, linkedEvaluation, trackerMatch.identity, trackerCvLink);
  validateRenderedPaths(outputRoot, targetReportPath, targetTrackerPath, linkedEvaluation, renderResult, trackerCvLink);

  // On an approved write, persist the derived status field back into the
  // evaluation so the evaluation, report, and tracker cannot drift apart.
  // Dry-runs never touch the live evaluation (outputRoot is the dry-run dir).
  if (options.write) {
    updateEvaluationStatusField(resolvedEvaluationPath, "tailored_cv", linkedEvaluation.tailored_cv);
    persistDocumentTypeOverride(resolvedEvaluationPath, evaluation, renderResult, options.documentType);
  }

  return {
    programId,
    documentType,
    reviewStatus: REVIEW_STATUS,
    write: Boolean(options.write),
    dataRoot: workspace.root,
    workspace,
    outputRoot,
    reportPath: targetReportPath,
    trackerPath: targetTrackerPath,
    artifacts: renderResult.artifacts,
    links: renderResult.links,
    trackerCvLink,
    estimatedPages: renderResult.estimatedPages,
  };
}

function readYaml(file) {
  return yaml.load(fs.readFileSync(file, "utf8"));
}

function mergeCatalog(workspace, evaluation, programId) {
  if (workspace.mode !== "student" || !evaluation.catalog_id) return evaluation;
  const catalogPath = path.join(workspace.baseRoot, "programs", "catalog", `${evaluation.catalog_id}.yml`);
  requireFile(catalogPath);
  const catalog = readYaml(catalogPath);
  if (!catalog || typeof catalog !== "object") {
    throw new Error(`Catalog record is not a YAML object: ${catalogPath}`);
  }
  if (catalog.id && catalog.id !== evaluation.catalog_id) {
    throw new Error(`Catalog id ${catalog.id} does not match ${evaluation.catalog_id}`);
  }
  return {
    ...catalog,
    ...evaluation,
    id: evaluation.id || programId,
  };
}

function sourceLabels(workspace) {
  const prefix = `students/${workspace.studentId}`;
  return {
    profile: `${prefix}/profile.yml for identity and contact only`,
    evidence: `${prefix}/evidence.yml`,
    master_cv: `${prefix}/master-cv.md`,
  };
}

function copyReportAndTracker(dataRoot, outputRoot, reportPath, trackerPath) {
  copyFileIntoRoot(dataRoot, outputRoot, reportPath);
  copyFileIntoRoot(dataRoot, outputRoot, trackerPath);
}

function copyFileIntoRoot(dataRoot, outputRoot, sourcePath) {
  const relative = path.relative(dataRoot, sourcePath);
  const target = path.join(outputRoot, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(sourcePath, target);
}

function requireTrackerRow(trackerPath, evaluation) {
  const tracker = fs.readFileSync(trackerPath, "utf8");
  const parsed = parseTracker(tracker);
  const identity = trackerIdentity({
    Institution: evaluation.institution,
    Program: evaluation.program,
    Degree: evaluation.degree_type,
    Intake: evaluation.intake,
  });
  const matches = parsed.rows.filter((row) => trackerIdentity(row) === identity);
  if (matches.length === 0) {
    throw new Error(`Tracker row not found for ${evaluation.institution} / ${evaluation.program} / ${evaluation.intake}`);
  }
  if (matches.length > 1) {
    throw new Error(`Tracker has multiple rows for ${evaluation.institution} / ${evaluation.program} / ${evaluation.intake}`);
  }
  return { identity, row: matches[0] };
}

function updateReportCvLinks(reportPath, evaluation) {
  const report = fs.readFileSync(reportPath, "utf8");
  if (!/^\*\*Tailored CV:\*\* /m.test(report)) {
    throw new Error(`Report missing Tailored CV header: ${reportPath}`);
  }
  const withHeader = report.replace(/^\*\*Tailored CV:\*\* .*$/m, `**Tailored CV:** ${evaluation.tailored_cv}`);
  const sectionStart = withHeader.indexOf("\n## G. Academic CV adaptation plan");
  const sectionEnd = withHeader.indexOf("\n## H. Remaining application package and action plan");
  if (sectionStart === -1 || sectionEnd === -1 || sectionEnd <= sectionStart) {
    throw new Error(`Report missing CV section boundaries: ${reportPath}`);
  }

  const before = withHeader.slice(0, sectionStart);
  const section = withHeader.slice(sectionStart, sectionEnd);
  const after = withHeader.slice(sectionEnd);
  const marker = "\nDraft output links:";
  const markerIndex = section.indexOf(marker);
  const withoutOldLinks = (markerIndex === -1 ? section : section.slice(0, markerIndex)).trimEnd();
  const linkBlock = renderCvArtifacts(evaluation.cv_adaptation_plan).trimEnd();
  if (!linkBlock.includes(REVIEW_STATUS)) {
    throw new Error("Rendered CV link block is missing review status");
  }
  fs.writeFileSync(reportPath, `${before}${withoutOldLinks}\n\n${linkBlock}\n${after}`);
}

// Persists a user-approved --document-type override into the evaluation's
// cv_adaptation_plan so the recorded agent decision matches the rendered
// artifact and a subsequent flag-less run reproduces it byte-for-byte.
function persistDocumentTypeOverride(evaluationPath, evaluation, renderResult, cliDocumentType) {
  if (!cliDocumentType) return;
  const plan = evaluation.cv_adaptation_plan || {};
  const updates = {};
  if (plan.document_type !== renderResult.documentType) {
    updates.document_type = renderResult.documentType;
  }
  if (
    renderResult.override &&
    renderResult.override.rationale === CLI_OVERRIDE_RATIONALE &&
    String(plan.document_type_rationale || "").trim() !== CLI_OVERRIDE_RATIONALE
  ) {
    updates.document_type_rationale = CLI_OVERRIDE_RATIONALE;
  }
  if (Object.keys(updates).length > 0) {
    updateEvaluationPlanFields(evaluationPath, updates);
  }
}

// The tracker CV cell and Next Action cell are both rendered from the
// evaluation on every run, so evaluation and tracker stay identical by
// construction instead of relying on the agent to copy next_action verbatim.
function updateTrackerCvLink(trackerPath, evaluation, identity, cvLink = evaluation.tailored_cv) {
  const tracker = fs.readFileSync(trackerPath, "utf8");
  const parsed = parseTracker(tracker);
  let updated = 0;
  const rows = parsed.rows.map((row) => {
    if (trackerIdentity(row) !== identity) return row;
    updated += 1;
    return {
      ...row,
      CV: cvLink,
      "Next Action": evaluation.next_action === undefined ? row["Next Action"] : String(evaluation.next_action),
    };
  });
  if (updated !== 1) {
    throw new Error(`Expected one tracker row update, got ${updated}`);
  }
  fs.writeFileSync(trackerPath, renderTracker(parsed.prelude, rows));
}

function trackerCvLinkForWorkspace(cvLink, workspaceMode) {
  if (workspaceMode !== "student") return cvLink;
  return cvLink.replace(/\]\(\.\.\/output\//g, "](output/");
}

function validateRenderedPaths(rootDir, reportPath, trackerPath, evaluation, result, trackerCvLink = evaluation.tailored_cv) {
  for (const artifactPath of Object.values(result.artifacts)) {
    const resolved = path.resolve(rootDir, artifactPath);
    if (!isInsideOrEqual(resolved, rootDir) || !fs.existsSync(resolved)) {
      throw new Error(`Generated artifact path does not resolve: ${artifactPath}`);
    }
  }

  const report = fs.readFileSync(reportPath, "utf8");
  const tracker = fs.readFileSync(trackerPath, "utf8");
  if (!report.includes(REVIEW_STATUS) || !tracker.includes(REVIEW_STATUS)) {
    throw new Error("Report and tracker must preserve Review Required status");
  }
  for (const link of Object.values(result.links)) {
    if (!report.includes(link)) {
      throw new Error(`Report missing generated link: ${link}`);
    }
    if (!resolveMarkdownLink(reportPath, link, rootDir)) {
      throw new Error(`Report link does not resolve: ${link}`);
    }
  }
  if (!tracker.includes(trackerCvLink)) {
    throw new Error("Tracker CV column missing tailored CV link");
  }
  if (!resolveMarkdownLink(trackerPath, trackerCvLink, rootDir)) {
    throw new Error(`Tracker CV link does not resolve: ${trackerCvLink}`);
  }
}

function resolveMarkdownLink(baseFile, markdownLink, rootDir) {
  const match = markdownLink.match(/\]\(([^)]+)\)/);
  if (!match) return false;
  const resolved = path.resolve(path.dirname(baseFile), match[1]);
  if (!isInsideOrEqual(resolved, rootDir)) return false;
  return fs.existsSync(resolved);
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  runLiveCv,
  updateReportCvLinks,
  updateTrackerCvLink,
};
