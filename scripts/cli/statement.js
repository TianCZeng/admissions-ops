const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const {
  attachStatementArtifactsToEvaluation,
  renderStatementAdaptation,
  REVIEW_STATUS,
} = require("../lib/statement-writer");
const {
  parseTracker,
  renderStatementArtifacts,
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
  updateEvaluationStatusField,
  isInsideOrEqual,
} = require("../lib/workspace");

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = runLiveStatement(options);
    const mode = result.write ? "write" : "dry-run";
    console.log(`Statement ${mode} complete for ${result.programId}`);
    console.log(`Statement type: ${result.statementType}`);
    console.log(`Review status: ${result.reviewStatus}`);
    console.log(`Output root: ${path.relative(process.cwd(), result.outputRoot) || "."}`);
    console.log(`Draft artifact: ${result.artifacts.statement_draft}`);
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
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.program) throw new Error("Missing required --program <program-id>");
  return options;
}

function requireValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
  return value;
}

function printHelp() {
  console.log(`Usage: npm run statement -- --student <student-id> --program <program-id> [--write] [--evaluation <path>] [--workspace <path>]

Defaults to dry-run mode. Dry-run reads live inputs but writes only to
validation-output/dry-run/statement/<student-id>/<program-id>/.
Use --write only after reviewing the dry-run output.`);
}

function runLiveStatement(options) {
  const programId = options.program;
  const workspace = resolveWorkspace(options);
  const resolvedEvaluationPath = evaluationPath(workspace, programId, options.evaluation);
  const resolvedDryRunRoot = options.dryRunRoot || dryRunRoot("statement", workspace, programId);
  const outputRoot = options.write ? workspace.root : path.resolve(resolvedDryRunRoot);

  if (!options.write) {
    assertDryRunRootSafe(outputRoot);
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }

  const catalogPath = path.join(workspace.baseRoot, "programs", "catalog", `${programId}.yml`);
  if (!fs.existsSync(resolvedEvaluationPath) && fs.existsSync(catalogPath)) {
    throw new Error(`Cannot render catalog-only program; missing student evaluation record: ${programId}`);
  }

  for (const file of [
    workspace.evidencePath,
    workspace.masterCvPath,
    workspace.statementBriefPath,
    resolvedEvaluationPath,
    workspace.trackerPath,
  ]) {
    requireFile(file);
  }

  let evaluation = readYaml(resolvedEvaluationPath);
  if (!evaluation || typeof evaluation !== "object" || Array.isArray(evaluation)) {
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

  const evidence = readYaml(workspace.evidencePath);
  const masterCv = fs.readFileSync(workspace.masterCvPath, "utf8");
  const statementBrief = fs.readFileSync(workspace.statementBriefPath, "utf8");

  if (!options.write) {
    copyReportAndTracker(workspace.root, outputRoot, reportPathValue, workspace.trackerPath);
  }

  const renderResult = renderStatementAdaptation(outputRoot, {
    evaluation,
    evidence,
    masterCv,
    statementBrief,
    documentInstructions,
    sourceLabels: sourceLabels(workspace),
  });
  const linkedEvaluation = attachStatementArtifactsToEvaluation(evaluation, renderResult);

  const targetReportPath = path.join(outputRoot, path.relative(workspace.root, reportPathValue));
  const targetTrackerPath = path.join(outputRoot, path.relative(workspace.root, workspace.trackerPath));
  const trackerStatementLink = trackerStatementLinkForWorkspace(linkedEvaluation.statement, workspace.mode);
  updateReportStatementLinks(targetReportPath, linkedEvaluation);
  updateTrackerStatementLink(targetTrackerPath, linkedEvaluation, trackerMatch.identity, trackerStatementLink);
  validateRenderedPaths(outputRoot, targetReportPath, targetTrackerPath, linkedEvaluation, renderResult, trackerStatementLink);

  // On an approved write, persist the derived status field back into the
  // evaluation so the evaluation, report, and tracker cannot drift apart.
  // Dry-runs never touch the live evaluation (outputRoot is the dry-run dir).
  if (options.write) {
    updateEvaluationStatusField(resolvedEvaluationPath, "statement", linkedEvaluation.statement);
  }

  return {
    programId,
    statementType: renderResult.statementType,
    reviewStatus: REVIEW_STATUS,
    write: Boolean(options.write),
    workspace,
    outputRoot,
    reportPath: targetReportPath,
    trackerPath: targetTrackerPath,
    artifacts: renderResult.artifacts,
    links: renderResult.links,
    trackerStatementLink,
    wordCount: renderResult.wordCount,
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
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
    throw new Error(`Catalog record is not a YAML object: ${catalogPath}`);
  }
  if (catalog.id && catalog.id !== evaluation.catalog_id) {
    throw new Error(`Catalog id ${catalog.id} does not match ${evaluation.catalog_id}`);
  }
  return { ...catalog, ...evaluation, id: evaluation.id || programId };
}

function sourceLabels(workspace) {
  const prefix = `students/${workspace.studentId}`;
  return {
    evidence: `${prefix}/evidence.yml`,
    master_cv: `${prefix}/master-cv.md`,
    statement_brief: `${prefix}/statement-brief.md`,
  };
}

function copyReportAndTracker(dataRoot, outputRoot, sourceReportPath, sourceTrackerPath) {
  copyFileIntoRoot(dataRoot, outputRoot, sourceReportPath);
  copyFileIntoRoot(dataRoot, outputRoot, sourceTrackerPath);
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

function updateReportStatementLinks(reportPath, evaluation) {
  const report = fs.readFileSync(reportPath, "utf8");
  let withHeader = report;
  if (/^\*\*Statement:\*\* /m.test(withHeader)) {
    withHeader = withHeader.replace(/^\*\*Statement:\*\* .*$/m, `**Statement:** ${evaluation.statement}`);
  } else if (/^\*\*Tailored CV:\*\* .*$/m.test(withHeader)) {
    withHeader = withHeader.replace(/^\*\*Tailored CV:\*\* .*$/m, (line) => `${line}\n**Statement:** ${evaluation.statement}`);
  } else {
    throw new Error(`Report missing Tailored CV header for statement insertion: ${reportPath}`);
  }

  const sectionStart = withHeader.indexOf("\n## H. Remaining application package and action plan");
  const sectionEnd = withHeader.indexOf("\n## I. Questions for the university or potential supervisor");
  if (sectionStart === -1 || sectionEnd === -1 || sectionEnd <= sectionStart) {
    throw new Error(`Report missing statement link section boundaries: ${reportPath}`);
  }
  const before = withHeader.slice(0, sectionStart);
  const section = withHeader.slice(sectionStart, sectionEnd);
  const after = withHeader.slice(sectionEnd);
  const linkBlock = renderStatementArtifacts(evaluation.statement_plan).trimEnd();
  if (!linkBlock.includes(REVIEW_STATUS)) throw new Error("Rendered statement link block is missing review status");
  const withoutOld = removeOldStatementBlock(section).trimEnd();
  fs.writeFileSync(reportPath, `${before}${withoutOld}\n\n${linkBlock}\n${after}`);
}

function removeOldStatementBlock(section) {
  const marker = "\nStatement output links:";
  const markerIndex = section.indexOf(marker);
  if (markerIndex === -1) return section;
  const nextTableIndex = section.indexOf("\n\n| Action |", markerIndex);
  if (nextTableIndex === -1) return section.slice(0, markerIndex);
  return `${section.slice(0, markerIndex)}${section.slice(nextTableIndex)}`;
}

// The tracker Statement cell and Next Action cell are both rendered from the
// evaluation on every run, so evaluation and tracker stay identical by
// construction instead of relying on the agent to copy next_action verbatim.
function updateTrackerStatementLink(trackerPath, evaluation, identity, statementLink) {
  const tracker = fs.readFileSync(trackerPath, "utf8");
  const parsed = parseTracker(tracker);
  let updated = 0;
  const rows = parsed.rows.map((row) => {
    if (trackerIdentity(row) !== identity) return row;
    updated += 1;
    return {
      ...row,
      Statement: statementLink,
      "Next Action": evaluation.next_action === undefined ? row["Next Action"] : String(evaluation.next_action),
    };
  });
  if (updated !== 1) throw new Error(`Expected one tracker row update, got ${updated}`);
  fs.writeFileSync(trackerPath, renderTracker(parsed.prelude, rows));
}

function trackerStatementLinkForWorkspace(statementLink, workspaceMode) {
  if (workspaceMode !== "student") return statementLink;
  return statementLink.replace(/\]\(\.\.\/output\//g, "](output/");
}

function validateRenderedPaths(rootDir, reportPathValue, trackerPathValue, evaluation, result, trackerStatementLink) {
  for (const artifactPath of Object.values(result.artifacts)) {
    const resolved = path.resolve(rootDir, artifactPath);
    if (!isInsideOrEqual(resolved, rootDir) || !fs.existsSync(resolved)) {
      throw new Error(`Generated statement artifact path does not resolve: ${artifactPath}`);
    }
  }
  const report = fs.readFileSync(reportPathValue, "utf8");
  const tracker = fs.readFileSync(trackerPathValue, "utf8");
  if (!report.includes(REVIEW_STATUS) || !tracker.includes(REVIEW_STATUS)) {
    throw new Error("Report and tracker must preserve Review Required status");
  }
  for (const link of Object.values(result.links)) {
    if (!report.includes(link)) throw new Error(`Report missing generated statement link: ${link}`);
    if (!resolveMarkdownLink(reportPathValue, link, rootDir)) throw new Error(`Report link does not resolve: ${link}`);
  }
  if (!tracker.includes(trackerStatementLink)) throw new Error("Tracker Statement column missing statement link");
  if (!resolveMarkdownLink(trackerPathValue, trackerStatementLink, rootDir)) {
    throw new Error(`Tracker statement link does not resolve: ${trackerStatementLink}`);
  }
  if (!evaluation.statement.includes(REVIEW_STATUS)) throw new Error("Statement link missing Review Required status");
}

function resolveMarkdownLink(baseFile, markdownLink, rootDir) {
  const match = markdownLink.match(/\]\(([^)]+)\)/);
  if (!match) return false;
  const resolved = path.resolve(path.dirname(baseFile), match[1]);
  if (!isInsideOrEqual(resolved, rootDir)) return false;
  return fs.existsSync(resolved);
}

if (require.main === module) main();

module.exports = {
  parseArgs,
  runLiveStatement,
  updateReportStatementLinks,
  updateTrackerStatementLink,
};
