const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const { parseTracker, reportFileName, trackerIdentity } = require("./program-writer");
const { REVIEW_STATUS } = require("./cv-writer");

const DRY_RUN_PATTERN = /run .*dry-run/i;
const CV_ARTIFACT_NAMES = ["academic-cv.html", "admissions-resume.html"];
const CV_ARTIFACT_BY_TYPE = {
  academic_cv: "academic-cv.html",
  admissions_resume: "admissions-resume.html",
};
const ELIGIBILITY_ROW_STATUSES = new Set(["met", "likely_met", "not_met", "unknown", "not_applicable"]);
const ELIGIBILITY_SUMMARY_VALUES = new Set(["eligible", "likely", "unclear", "ineligible"]);
// Scoped to language/standardized-test gates; word boundaries keep it from
// matching logistical rows ("degree" contains "gre").
const TEST_GATE_PATTERN = /\b(english|ielts|toefl|duolingo|gre|gmat)\b|\blanguage\b|standardized test/i;

// Deterministic post-write consistency checks across a student program's
// evaluation, report, tracker row, and generated output artifacts. This does
// not judge prose quality; it catches stale `pending` status, missing
// `Review Required` markers, broken links, drifted evidence sets, and a
// catalog record that silently lags behind a newer official-source retrieval.
//
// `workspace` is a resolveWorkspace() result (root, evaluationsDir, reportsDir,
// outputDir, trackerPath, baseRoot). Throws a single Error listing every
// problem found, so callers can surface all drift at once.
function validateProgramArtifacts(workspace, programId) {
  const problems = [];
  const fail = (message) => problems.push(message);

  const evalPath = path.join(workspace.evaluationsDir, `${programId}.yml`);
  if (!fs.existsSync(evalPath)) {
    throw new Error(`Cannot check consistency; missing evaluation: ${programId}`);
  }
  const evaluation = loadYaml(evalPath);
  if (!evaluation || typeof evaluation !== "object" || Array.isArray(evaluation)) {
    throw new Error(`Evaluation record is not a YAML object: ${evalPath}`);
  }

  const reportName = reportFileName(evaluation);
  const reportFile = path.join(workspace.reportsDir, reportName);
  const report = fs.existsSync(reportFile) ? fs.readFileSync(reportFile, "utf8") : null;
  if (report === null) fail(`Missing report for ${programId}: ${reportName}`);

  const trackerRow = findTrackerRow(workspace.trackerPath, evaluation, fail);

  const outputDir = path.join(workspace.outputDir, programId);
  const cvArtifacts = findCvArtifacts(outputDir);
  if (cvArtifacts.length > 1) {
    fail(
      `Output directory holds more than one CV artifact (expected exactly one): ${cvArtifacts
        .map((file) => path.basename(file))
        .join(", ")}`
    );
  }
  const statementDraft = path.join(outputDir, "statement-draft.md");
  const cvWritten = cvArtifacts.length > 0;
  const statementWritten = fs.existsSync(statementDraft);

  validateCatalogFreshness(workspace, evaluation, programId, fail);

  if (cvWritten) {
    validateCvConsistency({ workspace, evaluation, report, trackerRow, outputDir, cvArtifacts, fail });
  }
  if (statementWritten) {
    validateStatementConsistency({ workspace, evaluation, report, trackerRow, outputDir, statementDraft, fail });
  }
  validateNextAction({ evaluation, trackerRow, draftsExist: cvWritten || statementWritten, fail });
  validateEligibility({ evaluation, trackerRow, fail });

  if (problems.length > 0) {
    throw new Error(`Artifact consistency failed for ${programId}:\n- ${problems.join("\n- ")}`);
  }
  return { evaluation, cvWritten, statementWritten };
}

function validateCvConsistency({ workspace, evaluation, report, trackerRow, outputDir, cvArtifacts, fail }) {
  const evalCv = evaluation.tailored_cv;
  if (!evalCv || evalCv === "pending") {
    fail(`CV draft exists but evaluation tailored_cv is '${evalCv}' (expected a Review Required link)`);
    return;
  }
  if (!hasReviewRequired(evalCv)) fail("Evaluation tailored_cv missing Review Required marker");

  // Validate the artifact the evaluation links, never a filename-order pick;
  // a second CV-type artifact is already rejected by the caller.
  const linkedName = path.basename(normalizeOutputLink(evalCv));
  const cvArtifact = cvArtifacts.find((file) => path.basename(file) === linkedName);
  if (!cvArtifact) {
    fail(
      `Evaluation tailored_cv links ${linkedName} but the output directory holds: ${cvArtifacts
        .map((file) => path.basename(file))
        .join(", ")}`
    );
    return;
  }
  const plan = evaluation.cv_adaptation_plan || {};
  const expectedName = CV_ARTIFACT_BY_TYPE[plan.document_type];
  if (!expectedName) {
    fail(`cv_adaptation_plan.document_type is missing or unsupported: ${plan.document_type}`);
  } else if (linkedName !== expectedName) {
    fail(`Evaluation tailored_cv links ${linkedName} but cv_adaptation_plan.document_type is ${plan.document_type}`);
  }

  if (report !== null) {
    const headerLink = headerValue(report, "Tailored CV");
    if (!headerLink) fail("Report missing **Tailored CV:** header");
    else {
      if (!hasReviewRequired(headerLink)) fail("Report Tailored CV missing Review Required marker");
      if (normalizeOutputLink(headerLink) !== normalizeOutputLink(evalCv)) {
        fail("Report Tailored CV link target does not match evaluation tailored_cv");
      }
    }
  }

  if (trackerRow) {
    if (!hasReviewRequired(trackerRow.CV)) fail("Tracker CV column missing Review Required marker");
    if (normalizeOutputLink(trackerRow.CV) !== normalizeOutputLink(evalCv)) {
      fail("Tracker CV link target does not match evaluation tailored_cv");
    }
  }

  const cvTarget = path.join(workspace.root, normalizeOutputLink(evalCv));
  if (!fs.existsSync(cvTarget)) fail(`Evaluation tailored_cv link does not resolve: ${normalizeOutputLink(evalCv)}`);

  // Evidence sets must align across the rendered artifact, evidence map,
  // adaptation plan, and change log, or omissions must be explicitly recorded.
  const evidenceMapPath = path.join(outputDir, "evidence-map.yml");
  const planPath = path.join(outputDir, "adaptation-plan.md");
  const changeLogPath = path.join(outputDir, "change-log.md");
  for (const [label, file] of [["evidence map", evidenceMapPath], ["adaptation plan", planPath], ["change log", changeLogPath]]) {
    if (!fs.existsSync(file)) fail(`CV draft exists but ${label} is missing: ${path.basename(file)}`);
  }
  if (!fs.existsSync(evidenceMapPath) || !fs.existsSync(planPath) || !fs.existsSync(changeLogPath)) return;

  const evidenceMap = loadYaml(evidenceMapPath);
  if (evidenceMap.review_status !== REVIEW_STATUS) fail("CV evidence map missing Review Required status");
  const mapIds = idSet((evidenceMap.generated_claims || []).map((claim) => claim.evidence_id));

  const html = fs.readFileSync(cvArtifact, "utf8");
  const htmlIds = idSet([...html.matchAll(/data-evidence-id="([^"]+)"/g)].map((match) => match[1]));

  // The rendered evidence set must be exactly the plan's evidence_priorities;
  // the renderer serializes the agent's selection, so divergence means the
  // artifact and the recorded decision no longer match.
  const planPriorityIds = idSet((plan.evidence_priorities || []).map((id) => String(id || "").trim()));
  if (!setsEqual(planPriorityIds, htmlIds)) {
    fail(
      `Rendered evidence set differs from cv_adaptation_plan.evidence_priorities: ${symmetricDiff(
        planPriorityIds,
        htmlIds
      ).join(", ")}`
    );
  }

  const planText = fs.readFileSync(planPath, "utf8");
  if (!planText.includes(`Review status:** ${REVIEW_STATUS}`)) fail("CV adaptation plan missing Review Required status");
  const planSections = markdownSections(planText);
  const planUsed = idSet(extractBacktickIds(planSections["Evidence IDs Used"]));
  const planOmitted = idSet(extractBacktickIds(planSections["Evidence Omitted"]));

  const changeText = fs.readFileSync(changeLogPath, "utf8");
  if (!changeText.includes(`Review status:** ${REVIEW_STATUS}`)) fail("CV change log missing Review Required status");
  const changeUsed = idSet(extractBacktickIds(lineContaining(changeText, "Used evidence IDs")));
  const changeOmitted = idSet(extractBacktickIds(lineContaining(changeText, "Omitted evidence IDs")));

  if (!setsEqual(mapIds, htmlIds)) {
    fail(`CV evidence map IDs and rendered data-evidence-id set differ: ${symmetricDiff(mapIds, htmlIds).join(", ")}`);
  }
  if (!setsEqual(mapIds, planUsed)) {
    fail(`CV adaptation plan "Evidence IDs Used" differs from evidence map: ${symmetricDiff(mapIds, planUsed).join(", ")}`);
  }
  if (!setsEqual(planUsed, changeUsed)) {
    fail(`CV change log "Used evidence IDs" differs from adaptation plan: ${symmetricDiff(planUsed, changeUsed).join(", ")}`);
  }
  if (!setsEqual(planOmitted, changeOmitted)) {
    fail(`CV change log "Omitted evidence IDs" differs from adaptation plan: ${symmetricDiff(planOmitted, changeOmitted).join(", ")}`);
  }
  const overlap = [...planUsed].filter((id) => planOmitted.has(id));
  if (overlap.length > 0) fail(`CV evidence appears as both used and omitted: ${overlap.join(", ")}`);
}

function validateStatementConsistency({ workspace, evaluation, report, trackerRow, outputDir, statementDraft, fail }) {
  const evalStatement = evaluation.statement;
  if (!evalStatement || evalStatement === "pending") {
    fail(`Statement draft exists but evaluation statement is '${evalStatement}' (expected a Review Required link)`);
    return;
  }
  if (!hasReviewRequired(evalStatement)) fail("Evaluation statement missing Review Required marker");

  if (report !== null) {
    const headerLink = headerValue(report, "Statement");
    if (!headerLink) fail("Report missing **Statement:** header");
    else {
      if (!hasReviewRequired(headerLink)) fail("Report Statement missing Review Required marker");
      if (normalizeOutputLink(headerLink) !== normalizeOutputLink(evalStatement)) {
        fail("Report Statement link target does not match evaluation statement");
      }
    }
  }

  if (trackerRow) {
    if (!hasReviewRequired(trackerRow.Statement)) fail("Tracker Statement column missing Review Required marker");
    if (normalizeOutputLink(trackerRow.Statement) !== normalizeOutputLink(evalStatement)) {
      fail("Tracker Statement link target does not match evaluation statement");
    }
  }

  const target = path.join(workspace.root, normalizeOutputLink(evalStatement));
  if (!fs.existsSync(target)) {
    fail(`Evaluation statement link does not resolve: ${normalizeOutputLink(evalStatement)}`);
  } else if (!hasReviewRequired(fs.readFileSync(target, "utf8"))) {
    fail("Statement draft is missing a Review Required marker");
  }

  const evidenceMapPath = path.join(outputDir, "statement-evidence-map.yml");
  if (!fs.existsSync(evidenceMapPath)) {
    fail("Statement draft exists but statement-evidence-map.yml is missing");
    return;
  }
  const evidenceMap = loadYaml(evidenceMapPath);
  if (evidenceMap.review_status !== REVIEW_STATUS) fail("Statement evidence map missing Review Required status");
  const mapEvidence = idSet(
    (evidenceMap.generated_claims || [])
      .filter((claim) => claim.source_type === "evidence")
      .map((claim) => claim.evidence_id)
  );
  const claimMap = (evaluation.statement_plan && evaluation.statement_plan.claim_map) || [];
  for (const claim of claimMap) {
    if (claim.source_type === "evidence" && claim.evidence_id && !mapEvidence.has(claim.evidence_id)) {
      fail(`statement_plan claim_map evidence ${claim.evidence_id} is absent from the statement evidence map`);
    }
  }
}

function validateNextAction({ evaluation, trackerRow, draftsExist, fail }) {
  const evalNext = String(evaluation.next_action || "").trim();
  const rowNext = trackerRow ? String(trackerRow["Next Action"] || "").trim() : evalNext;
  if (trackerRow && evalNext !== rowNext) {
    fail("Evaluation next_action does not match tracker Next Action column");
  }
  if (draftsExist) {
    if (DRY_RUN_PATTERN.test(evalNext)) fail("Evaluation next_action still tells the user to run dry-runs that already ran");
    if (DRY_RUN_PATTERN.test(rowNext)) fail("Tracker Next Action still tells the user to run dry-runs that already ran");
  }
}

function validateCatalogFreshness(workspace, evaluation, programId, fail) {
  const catalogId = evaluation.catalog_id || programId;
  const catalogPath = path.join(workspace.baseRoot, "programs", "catalog", `${catalogId}.yml`);
  if (!fs.existsSync(catalogPath)) return;
  const catalog = loadYaml(catalogPath);
  const evalDate = String(evaluation.retrieved_at || "").trim();
  const catalogDate = String(catalog.retrieved_at || "").trim();
  if (!evalDate || !catalogDate) return;
  if (evalDate > catalogDate) {
    const note = String(evaluation.catalog_freshness || "");
    if (!note.includes(catalogDate)) {
      fail(
        `Evaluation retrieved ${evalDate} is newer than catalog ${catalogId} (${catalogDate}); ` +
          `refresh the catalog or add a catalog_freshness note that cites ${catalogDate}`
      );
    }
  }
}

// --- helpers ---------------------------------------------------------------

function findTrackerRow(trackerPath, evaluation, fail) {
  if (!fs.existsSync(trackerPath)) {
    fail("Missing tracker.md");
    return null;
  }
  const parsed = parseTracker(fs.readFileSync(trackerPath, "utf8"));
  const identity = trackerIdentity({
    Institution: evaluation.institution,
    Program: evaluation.program,
    Degree: evaluation.degree_type,
    Intake: evaluation.intake,
  });
  const matches = parsed.rows.filter((row) => trackerIdentity(row) === identity);
  if (matches.length !== 1) {
    fail(`Expected exactly one tracker row for ${evaluation.program}, found ${matches.length}`);
    return null;
  }
  return matches[0];
}

function findCvArtifacts(outputDir) {
  return CV_ARTIFACT_NAMES.map((name) => path.join(outputDir, name)).filter((file) => fs.existsSync(file));
}

// Scoped eligibility lint: controlled row statuses, a language or
// standardized-test gate may not be `met` without evidence (an unverified
// sub-score or waiver needs a verification task instead), and the coarse
// eligibility_summary uses the documented four-value vocabulary that the
// tracker Eligibility cell mirrors. Logistical rows (deadlines, transcripts,
// recommenders) are outside the test-gate pattern by design.
function validateEligibility({ evaluation, trackerRow, fail }) {
  const rows = Array.isArray(evaluation.eligibility) ? evaluation.eligibility : [];
  for (const row of rows) {
    const requirement = String(row.requirement || "");
    const status = String(row.status || "").trim();
    if (!ELIGIBILITY_ROW_STATUSES.has(status)) {
      fail(`Eligibility row has unsupported status '${status}': ${requirement}`);
    }
    const evidence = String(row.evidence || "").trim().toLowerCase();
    const hasEvidence = Boolean(evidence) && evidence !== "none";
    if (status === "met" && !hasEvidence && TEST_GATE_PATTERN.test(requirement)) {
      fail(
        `Language/standardized-test gate is 'met' with no evidence; cite evidence or use unknown plus a verification task: ${requirement}`
      );
    }
  }
  const summary = String(evaluation.eligibility_summary || "").trim();
  if (!ELIGIBILITY_SUMMARY_VALUES.has(summary)) {
    fail(`eligibility_summary '${summary}' is not one of eligible, likely, unclear, ineligible`);
  }
  if (trackerRow && String(trackerRow.Eligibility || "").trim() !== summary) {
    fail("Tracker Eligibility column does not match evaluation eligibility_summary");
  }
}

function headerValue(report, label) {
  const match = report.match(new RegExp(`^\\*\\*${label}:\\*\\* (.*)$`, "m"));
  return match ? match[1].trim() : null;
}

function normalizeOutputLink(value) {
  const match = String(value).match(/\]\(([^)]+)\)/);
  const target = match ? match[1] : String(value).trim();
  return target.replace(/^(\.\.\/)+/, "");
}

function hasReviewRequired(value) {
  return String(value || "").includes(REVIEW_STATUS);
}

function markdownSections(text) {
  const sections = {};
  const parts = text.split(/^## /m);
  for (const part of parts.slice(1)) {
    const newline = part.indexOf("\n");
    const title = (newline === -1 ? part : part.slice(0, newline)).trim();
    sections[title] = newline === -1 ? "" : part.slice(newline + 1);
  }
  return sections;
}

function lineContaining(text, needle) {
  return text.split(/\r?\n/).find((line) => line.includes(needle)) || "";
}

function extractBacktickIds(text) {
  if (!text) return [];
  return [...text.matchAll(/`([a-z0-9][a-z0-9-]*)`/g)].map((match) => match[1]);
}

function idSet(values) {
  return new Set((values || []).filter(Boolean));
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

function symmetricDiff(a, b) {
  const diff = [];
  for (const value of a) if (!b.has(value)) diff.push(`-${value}`);
  for (const value of b) if (!a.has(value)) diff.push(`+${value}`);
  return diff;
}

function loadYaml(file) {
  return yaml.load(fs.readFileSync(file, "utf8"));
}

module.exports = {
  validateProgramArtifacts,
  normalizeOutputLink,
};
