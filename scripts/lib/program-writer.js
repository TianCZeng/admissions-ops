const fs = require("fs");
const path = require("path");

const TRACKER_COLUMNS = [
  "#",
  "Institution",
  "Program",
  "Degree",
  "Intake",
  "Deadline",
  "Eligibility",
  "Fit",
  "Status",
  "CV",
  "Statement",
  "Report",
  "Next Action",
  "Notes",
];
const LEGACY_TRACKER_COLUMNS = TRACKER_COLUMNS.filter((column) => column !== "Statement");

const REPORT_SECTIONS = [
  "A. Program and intake summary",
  "B. Source and deadline verification",
  "C. Formal eligibility matrix",
  "D. Academic and research fit",
  "E. Competitiveness, gaps, and mitigation",
  "F. Practical constraints",
  "G. Academic CV adaptation plan",
  "H. Remaining application package and action plan",
  "I. Questions for the university or potential supervisor",
];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function formatReportNumber(number) {
  return String(number).padStart(3, "0");
}

function reportFileName(evaluation, number = evaluation.report_number) {
  return `${formatReportNumber(number)}-${slugify(evaluation.institution)}-${evaluation.retrieved_at}.md`;
}

function reserveReportNumber(reportsDir) {
  if (!fs.existsSync(reportsDir)) return 1;
  const numbers = fs
    .readdirSync(reportsDir)
    .map((file) => file.match(/^(\d{3})-[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.md$/))
    .filter(Boolean)
    .map((match) => Number(match[1]));
  return numbers.length === 0 ? 1 : Math.max(...numbers) + 1;
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

function renderReport(evaluation) {
  const sourceRows = evaluation.sources.map((source) => [
    source.url,
    source.retrieved_at,
    source.use,
    source.notes,
  ]);
  const eligibilityRows = evaluation.eligibility.map((row) => [
    row.requirement,
    row.status,
    row.evidence,
    row.source,
    row.notes,
  ]);
  const actionRows = evaluation.action_items.map((item) => [
    item.item,
    item.status,
    item.due,
    item.source,
    item.notes,
  ]);

  return `# Program Evaluation: ${evaluation.institution} - ${evaluation.program}

**Intake:** ${evaluation.intake}  
**Applicant category:** ${evaluation.applicant_category || "not applicable"}  
**Official URL:** ${evaluation.official_url}  
**Retrieved:** ${evaluation.retrieved_at}  
**Deadline:** ${renderDeadline(evaluation.deadline)}  
**Eligibility:** ${evaluation.eligibility_summary}  
**Fit score:** ${evaluation.fit_score}/5  
**Evidence confidence:** ${evaluation.evidence_confidence}  
**Tailored CV:** ${evaluation.tailored_cv}
**Statement:** ${evaluation.statement || "pending"}

This report is generated from a normalized admissions evaluation record and
must remain user-reviewed before any external use.

## A. Program and intake summary

${evaluation.institution}'s ${evaluation.program} record captures the intended intake, official-source evidence, eligibility planning, academic fit, and document preparation state for local review.

## B. Source and deadline verification

${mdTable(["Source", "Retrieved", "Use", "Notes"], sourceRows)}

Freshness and conflict notes:

${bulletList([...evaluation.freshness_warnings, ...conflictNotes(evaluation)])}

## C. Formal eligibility matrix

${mdTable(["Requirement", "Status", "Evidence", "Source", "Notes"], eligibilityRows)}

## D. Academic and research fit

${evaluation.fit.summary}

${Object.entries(evaluation.fit.dimensions)
  .map(([name, text]) => `- **${humanize(name)}:** ${text}`)
  .join("\n")}

## E. Competitiveness, gaps, and mitigation

${bulletList(evaluation.competitiveness_gaps)}

## F. Practical constraints

${bulletList(evaluation.practical_constraints)}

## G. Academic CV adaptation plan

${evaluation.cv_adaptation_plan.summary}

Prioritize:

${bulletList(evaluation.cv_adaptation_plan.evidence_priorities)}

${renderCvArtifacts(evaluation.cv_adaptation_plan)}

## H. Remaining application package and action plan

${mdTable(["Action", "Status", "Due", "Source", "Notes"], actionRows)}

## I. Questions for the university or potential supervisor

${bulletList(evaluation.questions)}
`;
}

function renderCvArtifacts(plan = {}) {
  if (!plan.artifacts) return "";
  const rows = [
    ["Review status", plan.review_status || "Review Required"],
    ["Adaptation plan", linkOrText(plan.artifacts.adaptation_plan)],
    ["Draft artifact", linkOrText(plan.artifacts.artifact)],
    ["Change log", linkOrText(plan.artifacts.change_log)],
    ["Evidence map", linkOrText(plan.artifacts.evidence_map)],
  ];
  return `\nDraft output links:\n\n${mdTable(["Item", "Path"], rows)}`;
}

function renderStatementArtifacts(plan = {}) {
  if (!plan.artifacts) return "";
  const rows = [
    ["Review status", plan.review_status || "Review Required"],
    ["Statement plan", linkOrText(plan.artifacts.statement_plan)],
    ["Draft statement", linkOrText(plan.artifacts.statement_draft)],
    ["Change log", linkOrText(plan.artifacts.statement_change_log)],
    ["Evidence map", linkOrText(plan.artifacts.statement_evidence_map)],
  ];
  return `\nStatement output links:\n\n${mdTable(["Item", "Path"], rows)}`;
}

function linkOrText(value) {
  if (!value) return "pending";
  return value;
}

function renderDeadline(deadline) {
  if (deadline.value === "unknown") return `unknown - ${deadline.notes}`;
  if (deadline.type === "rolling") return `rolling - ${deadline.timezone}`;
  return `${deadline.value} (${deadline.type}, ${deadline.timezone})`;
}

function bulletList(items) {
  if (!items || items.length === 0) return "- None.";
  return items.map((item) => `- ${item}`).join("\n");
}

function conflictNotes(evaluation) {
  if (!evaluation.conflicts || evaluation.conflicts.length === 0) {
    return ["No conflicting official sources in this fixture."];
  }
  return evaluation.conflicts;
}

function humanize(value) {
  return value.replace(/_/g, " ").replace(/^\w/, (char) => char.toUpperCase());
}

function writeReport(rootDir, evaluation) {
  const reportsDir = path.join(rootDir, "reports");
  ensureDir(reportsDir);
  if (evaluation.report_number) {
    const expectedFileName = reportFileName(evaluation, evaluation.report_number);
    const expectedPath = path.join(reportsDir, expectedFileName);
    if (fs.existsSync(expectedPath)) {
      fs.writeFileSync(expectedPath, renderReport(evaluation));
      return {
        reportPath: expectedPath,
        fileName: expectedFileName,
        reportNumber: evaluation.report_number,
      };
    }
  }
  const reserved = reserveReportNumber(reportsDir);
  if (evaluation.report_number && evaluation.report_number !== reserved) {
    throw new Error(`Expected report number ${evaluation.report_number}, reserved ${reserved}`);
  }
  const fileName = reportFileName(evaluation, reserved);
  const reportPath = path.join(reportsDir, fileName);
  fs.writeFileSync(reportPath, renderReport(evaluation));
  return { reportPath, fileName, reportNumber: reserved };
}

function renderChecklist(evaluation) {
  return `# Checklist: ${evaluation.institution} - ${evaluation.program} - ${evaluation.intake}

This checklist is generated from the normalized admissions evaluation record
and remains user-reviewed.

${mdTable(
    ["Item", "Status", "Due", "Source", "Notes"],
    evaluation.action_items.map((item) => [item.item, item.status, item.due, item.source, item.notes])
  )}
`;
}

function writeChecklist(rootDir, evaluation) {
  const checklistDir = path.join(rootDir, "programs", "checklists");
  ensureDir(checklistDir);
  const fileName = `${slugify(evaluation.institution)}-${slugify(evaluation.program)}-${slugify(evaluation.intake)}.md`;
  const checklistPath = path.join(checklistDir, fileName);
  fs.writeFileSync(checklistPath, renderChecklist(evaluation));
  return { checklistPath, fileName };
}

function emptyTracker() {
  return `# Programs Tracker

${mdTable(TRACKER_COLUMNS, [])}
`;
}

function parseTracker(markdown) {
  const lines = markdown.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.trim().startsWith("| # | Institution |"));
  if (headerIndex === -1) return { prelude: "# Programs Tracker\n\n", rows: [] };
  // Normalize trailing blank lines so a parse/render roundtrip is a byte-level
  // fixpoint; otherwise every deterministic write grows the prelude by one line.
  const preludeText = lines.slice(0, headerIndex).join("\n").replace(/\s+$/, "");
  const prelude = preludeText ? `${preludeText}\n\n` : "";
  const rows = [];
  for (const line of lines.slice(headerIndex + 2)) {
    if (!line.trim().startsWith("|")) continue;
    const cells = splitRow(line);
    if (cells.length === TRACKER_COLUMNS.length) {
      rows.push(Object.fromEntries(TRACKER_COLUMNS.map((column, index) => [column, cells[index]])));
    } else if (cells.length === LEGACY_TRACKER_COLUMNS.length) {
      const row = Object.fromEntries(LEGACY_TRACKER_COLUMNS.map((column, index) => [column, cells[index]]));
      row.Statement = "pending";
      rows.push(row);
    }
  }
  return { prelude, rows };
}

function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function trackerIdentity(row) {
  return [row.Institution, row.Program, row.Degree, row.Intake]
    .map((value) => String(value).trim().toLowerCase())
    .join("||");
}

function trackerRowFromEvaluation(evaluation, reportFileName) {
  return {
    "#": formatReportNumber(evaluation.report_number),
    Institution: evaluation.institution,
    Program: evaluation.program,
    Degree: evaluation.degree_type,
    Intake: evaluation.intake,
    Deadline: renderDeadline(evaluation.deadline),
    Eligibility: evaluation.eligibility_summary,
    Fit: `${evaluation.fit_score}/5`,
    Status: evaluation.status,
    CV: evaluation.tailored_cv,
    Statement: evaluation.statement || "pending",
    Report: `[${formatReportNumber(evaluation.report_number)}](../reports/${reportFileName})`,
    "Next Action": evaluation.next_action,
    Notes: evaluation.notes,
  };
}

function renderTracker(prelude, rows) {
  return `${prelude}${mdTable(
    TRACKER_COLUMNS,
    rows.map((row, index) => {
      const numbered = { ...row, "#": row["#"] || formatReportNumber(index + 1) };
      return TRACKER_COLUMNS.map((column) => numbered[column] || "");
    })
  )}
`;
}

function mergeTracker(rootDir, evaluation, reportFileName) {
  const programsDir = path.join(rootDir, "programs");
  ensureDir(programsDir);
  const trackerPath = path.join(programsDir, "tracker.md");
  const existing = fs.existsSync(trackerPath) ? fs.readFileSync(trackerPath, "utf8") : emptyTracker();
  const parsed = parseTracker(existing);
  const nextRow = trackerRowFromEvaluation(evaluation, reportFileName);
  const nextIdentity = trackerIdentity(nextRow);
  const keptRows = parsed.rows.filter((row) => trackerIdentity(row) !== nextIdentity);
  const rows = [...keptRows, nextRow].map((row, index) => ({ ...row, "#": formatReportNumber(index + 1) }));
  fs.writeFileSync(trackerPath, renderTracker(parsed.prelude, rows));
  return { trackerPath, rows };
}

function writeProgramEvaluation(rootDir, evaluation) {
  const report = writeReport(rootDir, evaluation);
  const tracker = mergeTracker(rootDir, evaluation, report.fileName);
  const checklist = writeChecklist(rootDir, evaluation);
  return {
    reportPath: report.reportPath,
    reportFileName: report.fileName,
    reportNumber: report.reportNumber,
    trackerPath: tracker.trackerPath,
    trackerRows: tracker.rows,
    checklistPath: checklist.checklistPath,
    checklistFileName: checklist.fileName,
  };
}

module.exports = {
  REPORT_SECTIONS,
  TRACKER_COLUMNS,
  emptyTracker,
  formatReportNumber,
  mergeTracker,
  parseTracker,
  renderCvArtifacts,
  renderStatementArtifacts,
  reportFileName,
  renderTracker,
  renderReport,
  reserveReportNumber,
  slugify,
  trackerRowFromEvaluation,
  trackerIdentity,
  writeProgramEvaluation,
};
