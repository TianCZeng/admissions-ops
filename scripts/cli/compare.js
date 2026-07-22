const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const {
  emptyTracker,
  parseTracker,
  renderTracker,
  reportFileName,
  trackerIdentity,
  trackerRowFromEvaluation,
} = require("../lib/program-writer");
const {
  assertDryRunRootSafe,
  dryRunRoot,
  evaluationPath,
  rel,
  reportPath,
  requireFile,
  resolveWorkspace,
  isInsideOrEqual,
} = require("../lib/workspace");

const REVIEW_STATUS = "Review Required";
const ALLOWED_LABELS = new Set(["ambitious", "realistic", "lower-risk"]);

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = runCompare(options);
    const mode = result.write ? "write" : "dry-run";
    console.log(`Comparison ${mode} complete for ${result.programs.length} programs`);
    console.log(`Output root: ${path.relative(process.cwd(), result.outputRoot) || "."}`);
    console.log(`Report: ${result.report}`);
    console.log(`Checklist: ${result.checklist}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

function parseArgs(args) {
  const options = {
    programs: [],
    write: false,
    syncTracker: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--program") {
      options.programs.push(requireValue(args, ++index, arg));
    } else if (arg === "--date") {
      options.date = requireValue(args, ++index, arg);
    } else if (arg === "--workspace") {
      options.workspace = requireValue(args, ++index, arg);
    } else if (arg === "--student") {
      options.student = requireValue(args, ++index, arg);
    } else if (arg === "--write") {
      options.write = true;
    } else if (arg === "--sync-tracker") {
      options.syncTracker = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (options.programs.length < 2) {
    throw new Error("Compare requires at least two --program <program-id> values");
  }
  options.date = options.date || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.date)) {
    throw new Error(`--date must use YYYY-MM-DD: ${options.date}`);
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
  console.log(`Usage: npm run compare -- --student <student-id> --program <program-id> --program <program-id> [--date YYYY-MM-DD] [--workspace <path>] [--sync-tracker] [--write]

Defaults to dry-run mode. Dry-runs write only under
validation-output/dry-run/compare/<student-id>/.
Use --write to create reports/comparison-YYYY-MM-DD.md and the matching
comparison checklist in the selected student workspace.`);
}

function runCompare(options) {
  const workspace = resolveWorkspace(options);
  const resolvedDryRunRoot = options.dryRunRoot ? path.resolve(options.dryRunRoot) : dryRunRoot("compare", workspace);
  const outputRoot = options.write ? workspace.root : resolvedDryRunRoot;
  if (!options.write) {
    resetDryRunRoot(outputRoot);
  }

  requireFile(workspace.preferencesPath);
  const preferences = readYaml(workspace.preferencesPath);
  const evaluations = options.programs.map((programId) => loadEvaluation(workspace, programId));
  const duplicateIds = findDuplicates(evaluations.map((evaluation) => evaluation.id));
  if (duplicateIds.length > 0) {
    throw new Error(`Duplicate program ids are not comparable: ${duplicateIds.join(", ")}`);
  }

  const records = evaluations.map((evaluation) => buildProgramRecord(workspace, evaluation, options.date));
  if (!options.write) {
    copyComparisonInputs(workspace, outputRoot, records);
  }

  const trackerPath = path.join(outputRoot, path.relative(workspace.root, workspace.trackerPath));
  ensureTracker(outputRoot, workspace);
  if (options.syncTracker) {
    syncTrackerRows(trackerPath, records, workspace.mode);
  }
  validateTrackerRows(trackerPath, records);

  const report = renderComparisonReport(records, preferences, options.date);
  const checklist = renderComparisonChecklist(records, options.date);
  const reportPath = path.join(outputRoot, path.relative(workspace.root, path.join(workspace.reportsDir, `comparison-${options.date}.md`)));
  const checklistPath = path.join(outputRoot, path.relative(workspace.root, path.join(workspace.checklistsDir, `comparison-${options.date}.md`)));
  writeFile(reportPath, report);
  writeFile(checklistPath, checklist);
  validateComparisonOutput(outputRoot, reportPath, checklistPath, records);

  return {
    write: Boolean(options.write),
    outputRoot,
    workspace,
    report: rel(outputRoot, reportPath),
    checklist: rel(outputRoot, checklistPath),
    programs: records.map((record) => record.evaluation.id),
  };
}

function loadEvaluation(workspace, programId) {
  const resolvedEvaluationPath = evaluationPath(workspace, programId);
  if (!fs.existsSync(resolvedEvaluationPath)) {
    const inboxPath = path.join(workspace.baseRoot, "programs", "inbox.yml");
    const exampleInboxPath = path.join(workspace.baseRoot, "programs", "inbox.example.yml");
    if (inboxHasProgram(inboxPath, programId) || inboxHasProgram(exampleInboxPath, programId)) {
      throw new Error(`Cannot compare raw inbox entry; missing normalized evaluated-program record: ${programId}`);
    }
    const catalogPath = path.join(workspace.baseRoot, "programs", "catalog", `${programId}.yml`);
    if (fs.existsSync(catalogPath)) {
      throw new Error(`Cannot compare catalog-only program; missing student evaluation record: ${programId}`);
    }
    throw new Error(`Missing normalized evaluated-program record: ${resolvedEvaluationPath}`);
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
  return evaluation;
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

function inboxHasProgram(file, programId) {
  if (!fs.existsSync(file)) return false;
  const inbox = readYaml(file);
  return Boolean((inbox.programs || []).some((program) => program.id === programId));
}

function buildProgramRecord(workspace, evaluation, comparisonDate) {
  const resolvedReportPath = reportPath(workspace, evaluation, reportFileName);
  requireFile(resolvedReportPath);
  const report = fs.readFileSync(resolvedReportPath, "utf8");
  const reportTailoredCv = extractTailoredCv(report);
  const tailoredCv = cvReady(evaluation.tailored_cv) ? evaluation.tailored_cv : reportTailoredCv || evaluation.tailored_cv || "pending";
  const enriched = { ...evaluation, tailored_cv: tailoredCv };
  return {
    evaluation: enriched,
    reportPath: resolvedReportPath,
    reportFileName: path.basename(resolvedReportPath),
    reportLink: `[${formatReportLabel(enriched)}](../reports/${path.basename(resolvedReportPath)})`,
    cvStatus: summarizeCvReadiness(tailoredCv),
    deadlinePressure: summarizeDeadlinePressure(enriched.deadline, comparisonDate),
    unresolved: unresolvedTasks(enriched),
    effort: summarizeEffort(enriched),
    label: portfolioLabel(enriched),
  };
}

function extractTailoredCv(report) {
  const match = report.match(/^\*\*Tailored CV:\*\* (.+)$/m);
  if (!match) return "";
  return match[1].trim();
}

function summarizeCvReadiness(value) {
  if (!value || value === "pending") return "pending";
  if (value.includes(REVIEW_STATUS)) return `${REVIEW_STATUS} draft`;
  return value;
}

function summarizeDeadlinePressure(deadline = {}, comparisonDate) {
  if (!deadline || deadline.value === "unknown") {
    return {
      level: "unknown",
      text: `unknown - ${deadline.notes || "manual verification required"}`,
    };
  }
  if (deadline.type === "rolling") {
    return {
      level: "rolling",
      text: `rolling - ${deadline.timezone || "timezone unknown"}`,
    };
  }
  const parsed = Date.parse(`${deadline.value}T00:00:00Z`);
  if (Number.isNaN(parsed)) {
    return {
      level: "unknown",
      text: `${deadline.value} (${deadline.type || "unknown"}, ${deadline.timezone || "timezone unknown"})`,
    };
  }
  const today = Date.parse(`${comparisonDate}T00:00:00Z`);
  const days = Math.ceil((parsed - today) / (24 * 60 * 60 * 1000));
  let level = "low";
  if (days < 0) level = "passed";
  else if (days <= 30) level = "high";
  else if (days <= 90) level = "medium";
  return {
    level,
    text: `${deadline.value} (${deadline.type || "fixed"}, ${deadline.timezone || "timezone unknown"}; ${level} pressure)`,
  };
}

function unresolvedTasks(evaluation) {
  const unknownRequirements = (evaluation.eligibility || [])
    .filter((row) => row.status === "unknown")
    .map((row) => ({
      item: row.requirement,
      status: "Needed",
      due: dueFromDeadline(evaluation.deadline),
      source: row.source || "unknown",
      notes: row.notes || "Manual verification required.",
    }));
  const actionItems = (evaluation.action_items || [])
    .filter((item) => String(item.status || "").toLowerCase() !== "done")
    .map((item) => ({
      item: item.item,
      status: item.status || "Needed",
      due: item.due || "unknown",
      source: item.source || "unknown",
      notes: item.notes || "",
    }));
  const keyed = new Map();
  for (const item of [...unknownRequirements, ...actionItems]) {
    keyed.set(`${item.item}||${item.source}`, item);
  }
  return [...keyed.values()];
}

function dueFromDeadline(deadline = {}) {
  return deadline.value && deadline.value !== "unknown" ? deadline.value : "unknown";
}

function summarizeEffort(evaluation) {
  const text = evaluation.fit && evaluation.fit.dimensions
    ? evaluation.fit.dimensions.application_effort || ""
    : "";
  const unresolvedCount = unresolvedTasks(evaluation).length;
  if (/high/i.test(text) || unresolvedCount >= 4) return "high";
  if (/low/i.test(text) && unresolvedCount <= 1) return "low";
  return "moderate";
}

function portfolioLabel(evaluation) {
  const unknownCount = (evaluation.eligibility || []).filter((row) => row.status === "unknown").length;
  const notMetCount = (evaluation.eligibility || []).filter((row) => row.status === "not_met").length;
  const effort = summarizeEffort(evaluation);
  const fitScore = Number(evaluation.fit_score || 0);
  const eligibility = String(evaluation.eligibility_summary || "").toLowerCase();
  let label = "realistic";
  if (notMetCount > 0 || eligibility === "unclear" || unknownCount >= 2 || effort === "high") {
    label = "ambitious";
  } else if ((eligibility === "likely" || eligibility === "eligible") && fitScore >= 4 && unknownCount === 0 && effort !== "high") {
    label = "lower-risk";
  }
  const reasoning = labelReasoning(label, evaluation, unknownCount, effort);
  if (!ALLOWED_LABELS.has(label)) throw new Error(`Unsupported planning label: ${label}`);
  return { value: label, reasoning };
}

function labelReasoning(label, evaluation, unknownCount, effort) {
  const fit = `${evaluation.fit_score}/5 fit`;
  if (label === "ambitious") {
    return `${fit}; ${unknownCount} unresolved hard requirement(s) and ${effort} application effort require planning caution.`;
  }
  if (label === "lower-risk") {
    return `${fit}; formal requirements are mostly resolved and effort is not high.`;
  }
  return `${fit}; fit is plausible, but remaining verification and preparation still matter.`;
}

function copyComparisonInputs(workspace, outputRoot, records) {
  for (const record of records) {
    copyFileIntoRoot(workspace.root, outputRoot, record.reportPath);
    copyEvaluation(workspace, outputRoot, record.evaluation.id);
    copyOutputDir(workspace, outputRoot, record.evaluation.id);
  }
  copyFileIntoRoot(workspace.root, outputRoot, workspace.preferencesPath);
  if (fs.existsSync(workspace.trackerPath)) copyFileIntoRoot(workspace.root, outputRoot, workspace.trackerPath);
}

function copyEvaluation(workspace, outputRoot, programId) {
  copyFileIntoRoot(
    workspace.root,
    outputRoot,
    path.join(workspace.evaluationsDir, `${programId}.yml`)
  );
}

function copyOutputDir(workspace, outputRoot, programId) {
  const source = path.join(workspace.outputDir, programId);
  if (!fs.existsSync(source)) return;
  const target = path.join(outputRoot, path.relative(workspace.root, source));
  fs.cpSync(source, target, { recursive: true });
}

function copyFileIntoRoot(dataRoot, outputRoot, sourcePath) {
  const relative = path.relative(dataRoot, sourcePath);
  const target = path.join(outputRoot, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(sourcePath, target);
}

function ensureTracker(outputRoot, workspace) {
  const trackerPath = path.join(outputRoot, path.relative(workspace.root, workspace.trackerPath));
  if (fs.existsSync(trackerPath)) return;
  if (fs.existsSync(workspace.trackerPath) && outputRoot === workspace.root) return;
  writeFile(trackerPath, emptyTracker());
}

function syncTrackerRows(trackerPath, records, workspaceMode) {
  const existing = fs.existsSync(trackerPath) ? fs.readFileSync(trackerPath, "utf8") : emptyTracker();
  const parsed = parseTracker(existing);
  const rows = [...parsed.rows];
  for (const record of records) {
    const row = trackerRowFromEvaluation(record.evaluation, record.reportFileName);
    if (workspaceMode === "student") {
      row.Report = `[${String(record.evaluation.report_number).padStart(3, "0")}](reports/${record.reportFileName})`;
      row.CV = String(row.CV || "").replace(/\]\(\.\.\/output\//g, "](output/");
    }
    const identity = trackerIdentity(row);
    const index = rows.findIndex((candidate) => trackerIdentity(candidate) === identity);
    if (index === -1) {
      rows.push(row);
    } else if (!cvReady(rows[index].CV) && cvReady(row.CV)) {
      rows[index] = { ...rows[index], CV: row.CV };
    }
  }
  fs.writeFileSync(trackerPath, renderTracker(parsed.prelude, rows));
}

function validateTrackerRows(trackerPath, records) {
  const tracker = fs.existsSync(trackerPath) ? fs.readFileSync(trackerPath, "utf8") : emptyTracker();
  const parsed = parseTracker(tracker);
  const missing = records.filter((record) => {
    const expected = trackerIdentity({
      Institution: record.evaluation.institution,
      Program: record.evaluation.program,
      Degree: record.evaluation.degree_type,
      Intake: record.evaluation.intake,
    });
    return !parsed.rows.some((row) => trackerIdentity(row) === expected);
  });
  if (missing.length > 0) {
    throw new Error(`Tracker row missing; rerun with --sync-tracker: ${missing.map((record) => record.evaluation.id).join(", ")}`);
  }
}

function renderComparisonReport(records, preferences, date) {
  const rows = records.map((record) => [
    programName(record.evaluation),
    record.evaluation.eligibility_summary,
    `${record.evaluation.fit_score}/5`,
    record.evaluation.evidence_confidence,
    record.deadlinePressure.text,
    record.effort,
    record.cvStatus,
    record.label.value,
    record.label.reasoning,
  ]);

  return `# Program Comparison: ${date}

Planning labels are shorthand for prioritizing application work. They are not admissions odds or promises.

## Student Preference Context

${preferenceSummary(preferences)}

## Portfolio Summary

${mdTable(
    ["Program", "Eligibility", "Fit", "Confidence", "Deadline pressure", "Effort", "CV/resume readiness", "Planning label", "Reasoning"],
    rows
  )}

## Program Details

${records.map(renderProgramDetail).join("\n\n")}

## Planning Notes

- Funding remains free text in this MVP comparison.
- Unknown requirements remain manual verification tasks.
- Use the checklist below for preparation sequencing; do not treat labels as outcomes.
`;
}

function renderProgramDetail(record) {
  const evaluation = record.evaluation;
  return `### ${programName(evaluation)}

- Report: ${record.reportLink}
- Official URL: ${evaluation.official_url}
- Deadline: ${record.deadlinePressure.text}
- Source confidence: ${evaluation.evidence_confidence}
- Freshness and conflicts: ${listInline([...(evaluation.freshness_warnings || []), ...(evaluation.conflicts || [])])}
- Practical constraints: ${listInline(evaluation.practical_constraints)}
- Application effort: ${record.effort}; ${dimensionText(evaluation, "application_effort")}
- CV/resume readiness: ${record.cvStatus}
- Planning label: ${record.label.value} - ${record.label.reasoning}
- Unresolved tasks: ${record.unresolved.length === 0 ? "None." : record.unresolved.map((item) => `${item.item} (${item.due})`).join("; ")}
`;
}

function renderComparisonChecklist(records, date) {
  const rows = [
    ["Review comparison prioritization", "Needed", date, "local comparison review", "Confirm labels are useful and do not overstate certainty."],
  ];
  for (const record of records) {
    for (const item of record.unresolved) {
      rows.push([
        `${programName(record.evaluation)}: ${item.item}`,
        item.status,
        item.due || "unknown",
        item.source || "unknown",
        item.notes || "",
      ]);
    }
  }
  return `# Comparison Checklist: ${date}

${mdTable(["Item", "Status", "Due", "Source", "Notes"], rows)}
`;
}

function validateComparisonOutput(rootDir, reportPath, checklistPath, records) {
  const report = fs.readFileSync(reportPath, "utf8");
  const checklist = fs.readFileSync(checklistPath, "utf8");
  for (const record of records) {
    if (!report.includes(programName(record.evaluation))) {
      throw new Error(`Comparison report missing program: ${record.evaluation.id}`);
    }
    if (!ALLOWED_LABELS.has(record.label.value)) {
      throw new Error(`Comparison report has unsupported label: ${record.label.value}`);
    }
    if (!record.label.reasoning) {
      throw new Error(`Comparison label lacks reasoning: ${record.evaluation.id}`);
    }
    if (cvReady(record.evaluation.tailored_cv)) {
      if (!report.includes(REVIEW_STATUS)) {
        throw new Error("Comparison report must retain Review Required CV status");
      }
      if (!resolveMarkdownLink(record.reportPath, record.evaluation.tailored_cv, path.dirname(path.dirname(record.reportPath)))) {
        throw new Error(`CV link does not resolve from source report: ${record.evaluation.tailored_cv}`);
      }
    }
  }
  if (/guarantee|guaranteed|chance of admission|probability of admission/i.test(report)) {
    throw new Error("Comparison report contains guarantee-style admissions language");
  }
  const checklistLines = checklist.split(/\r?\n/).filter((line) => line.startsWith("| ") && !line.includes("---"));
  for (const line of checklistLines.slice(1)) {
    const cells = splitMarkdownRow(line);
    if (cells.length !== 5 || cells.some((cell) => cell === "")) {
      throw new Error(`Checklist row must include item, status, due, source, and notes: ${line}`);
    }
  }
  for (const file of [reportPath, checklistPath]) {
    if (!path.resolve(file).startsWith(path.resolve(rootDir))) {
      throw new Error(`Comparison output escaped root: ${file}`);
    }
  }
}

function preferenceSummary(preferences = {}) {
  const pieces = [];
  if (preferences.target_fields) pieces.push(`Target fields: ${preferences.target_fields.join(", ")}.`);
  if (preferences.countries) pieces.push(`Countries: ${preferences.countries.join(", ")}.`);
  if (preferences.intakes) pieces.push(`Intakes: ${preferences.intakes.join(", ")}.`);
  if (preferences.constraints) pieces.push(`Constraints remain user-reviewed; funding is free text.`);
  return pieces.length === 0 ? "- No student preferences file details available." : pieces.map((item) => `- ${item}`).join("\n");
}

function dimensionText(evaluation, dimension) {
  return evaluation.fit && evaluation.fit.dimensions && evaluation.fit.dimensions[dimension]
    ? evaluation.fit.dimensions[dimension]
    : "No detail recorded.";
}

function programName(evaluation) {
  return `${evaluation.institution} - ${evaluation.program} (${evaluation.degree_type}, ${evaluation.intake})`;
}

function formatReportLabel(evaluation) {
  return String(evaluation.report_number || evaluation.id);
}

function listInline(items) {
  return items && items.length > 0 ? items.join("; ") : "None recorded.";
}

function cvReady(value) {
  return Boolean(value && value !== "pending" && value.includes("[") && value.includes("]("));
}

function findDuplicates(values) {
  const seen = new Set();
  const duplicated = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicated.add(value);
    seen.add(value);
  }
  return [...duplicated];
}

function readYaml(file) {
  return yaml.load(fs.readFileSync(file, "utf8"));
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function mdTable(headers, rows) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(formatCell).join(" | ")} |`),
  ].join("\n");
}

function formatCell(value) {
  return String(value ?? "").replace(/\n/g, "<br>").replace(/\|/g, "\\|");
}

function splitMarkdownRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function resetDryRunRoot(rootDir) {
  assertDryRunRootSafe(rootDir);
  const resolved = path.resolve(rootDir);
  fs.rmSync(resolved, { recursive: true, force: true });
  fs.mkdirSync(resolved, { recursive: true });
}

function resolveMarkdownLink(baseFile, markdownLink, rootDir) {
  const match = String(markdownLink).match(/\]\(([^)]+)\)/);
  if (!match) return false;
  const resolved = path.resolve(path.dirname(baseFile), match[1]);
  return isInsideOrEqual(resolved, rootDir) && fs.existsSync(resolved);
}

if (require.main === module) {
  main();
}

module.exports = {
  ALLOWED_LABELS,
  parseArgs,
  runCompare,
};
