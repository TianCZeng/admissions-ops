const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const {
  attachCvArtifactsToEvaluation,
  estimateHtmlPages,
  flattenEvidence,
  renderCvAdaptation,
  REQUIRED_SECTIONS,
  REVIEW_STATUS,
} = require("../lib/cv-writer");
const { parseTracker, writeProgramEvaluation } = require("../lib/program-writer");

function readYaml(file) {
  return yaml.load(fs.readFileSync(file, "utf8"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function main() {
  const evaluation = readYaml("examples/fictional-programs/northbridge-evaluation.yml");
  const profile = readYaml("examples/fictional-student/profile.yml");
  const evidence = readYaml("examples/fictional-student/evidence.yml");
  const masterCvPath = "examples/fictional-student/master-cv.md";
  const masterCv = fs.readFileSync(masterCvPath, "utf8");
  const beforeHash = hashFile(masterCvPath);
  const validationRoot = path.join(__dirname, "..", "..", "validation-output", "verify", "cv");

  resetValidationRoot(validationRoot);

  writeProgramEvaluation(validationRoot, evaluation);
  const cvResult = renderCvAdaptation(validationRoot, {
    evaluation,
    profile,
    evidence,
    masterCv,
    documentInstructions: {},
  });
  const linkedEvaluation = attachCvArtifactsToEvaluation(evaluation, cvResult);
  const programOutput = writeProgramEvaluation(validationRoot, linkedEvaluation);

  validateAcademicCv(validationRoot, cvResult, evidence, masterCv);
  validateAgentAuthoredSummary(validationRoot, cvResult, evaluation);
  validatePlanDrivenSelection(cvResult, evaluation);
  validateReportAndTrackerLinks(validationRoot, programOutput.reportFileName, linkedEvaluation, cvResult);
  validateMasterCvUnchanged(masterCvPath, beforeHash);
  validateResumeScenario(validationRoot, evaluation, profile, evidence, masterCv);
  validateDocumentTypeOverride(validationRoot, evaluation, profile, evidence, masterCv);
  validateArtifactExclusivity(validationRoot, evaluation, profile, evidence, masterCv);
  validatePlanPreflightFailures(validationRoot, evaluation, profile, evidence, masterCv);
  validateRenderedLanguageGate(validationRoot, evaluation, profile, evidence, masterCv);
  validateUnsupportedEvidenceFailure(validationRoot, cvResult, evidence);

  console.log(`CV adaptation fixture verifies in ${path.relative(process.cwd(), validationRoot)}`);
}

// Resume-legal subset of the academic plan: education, research, projects,
// courses, and awards only, omitting enough evidence for the concision check.
function resumePlanFor(evaluation) {
  return {
    ...evaluation.cv_adaptation_plan,
    document_type: "admissions_resume",
    evidence_priorities: [
      "edu-pmc-bsc-cs",
      "research-human-feedback-thesis",
      "project-rubric-eval-dashboard",
      "course-machine-learning",
      "course-hci",
      "award-research-poster",
    ],
  };
}

// The rendered summary line is the agent's profile_summary, on both document
// paths, with no data-evidence-id and never a renderer-fabricated label.
function validateAgentAuthoredSummary(rootDir, result, evaluation) {
  const html = fs.readFileSync(path.join(rootDir, result.artifacts.artifact), "utf8");
  const summaryText = escapeHtml(String(evaluation.cv_adaptation_plan.profile_summary).trim());
  assert(
    html.includes(`<div class="summary"><p>${summaryText}</p></div>`),
    "Rendered artifact does not carry the agent-authored profile_summary verbatim"
  );
  assert(!html.includes("Computer vision applicant profile"), "Rendered artifact contains the retired hardcoded summary label");
  const summaryBlock = html.match(/<div class="summary">[\s\S]*?<\/div>/);
  assert(summaryBlock && !summaryBlock[0].includes("data-evidence-id"), "Profile summary must not carry a data-evidence-id");
}

function validatePlanDrivenSelection(result, evaluation) {
  const planned = new Set(evaluation.cv_adaptation_plan.evidence_priorities);
  const used = new Set(result.evidenceIdsUsed);
  assert(planned.size === used.size && [...planned].every((id) => used.has(id)),
    "Rendered evidence set must equal the plan's evidence_priorities exactly");
}

// An agent-recorded document type that disagrees with the instruction-derived
// default proceeds when a rationale is recorded, and the change log carries
// the override record with the faithful official text.
function validateDocumentTypeOverride(rootDir, evaluation, profile, evidence, masterCv) {
  const officialText = "Submit a current resume for the fictional override check.";
  const overrideEvaluation = {
    ...evaluation,
    id: `${evaluation.id}-override-check`,
    cv_adaptation_plan: {
      ...evaluation.cv_adaptation_plan,
      document_type: "academic_cv",
      document_type_rationale: "Research-focused applicant; the user asked for a full academic CV despite the resume instruction.",
    },
  };
  const result = renderCvAdaptation(rootDir, {
    evaluation: overrideEvaluation,
    profile,
    evidence,
    masterCv,
    documentInstructions: { text: officialText },
  });
  assert(result.documentType === "academic_cv", "Override should render the agent-chosen academic CV");
  assert(result.override && result.override.instructionDerived === "admissions_resume", "Override record missing instruction-derived type");
  const changeLog = fs.readFileSync(path.join(rootDir, result.artifacts.change_log), "utf8");
  assert(changeLog.includes("Document type override:"), "Change log missing document type override record");
  assert(changeLog.includes(officialText), "Change log override record must quote the faithful official text");
  assert(changeLog.includes(overrideEvaluation.cv_adaptation_plan.document_type_rationale), "Change log override record missing the rationale");
}

// Exactly one CV artifact per program output directory: a document-type change
// deletes the other type's file in the same run.
function validateArtifactExclusivity(rootDir, evaluation, profile, evidence, masterCv) {
  const swapEvaluation = {
    ...evaluation,
    id: `${evaluation.id}-artifact-swap`,
  };
  const first = renderCvAdaptation(rootDir, {
    evaluation: swapEvaluation,
    profile,
    evidence,
    masterCv,
    documentInstructions: {},
  });
  assert(first.documentType === "academic_cv", "Artifact-swap first render should be an academic CV");
  const outputDir = path.join(rootDir, "output", swapEvaluation.id);
  assert(fs.existsSync(path.join(outputDir, "academic-cv.html")), "Artifact-swap first render missing academic-cv.html");

  const resumeEvaluation = {
    ...swapEvaluation,
    cv_adaptation_plan: resumePlanFor(evaluation),
  };
  const second = renderCvAdaptation(rootDir, {
    evaluation: resumeEvaluation,
    profile,
    evidence,
    masterCv,
    documentInstructions: { page_limit: 2, text: "Upload a concise resume with a two-page limit." },
  });
  assert(second.documentType === "admissions_resume", "Artifact-swap second render should be a resume");
  assert(fs.existsSync(path.join(outputDir, "admissions-resume.html")), "Artifact-swap second render missing admissions-resume.html");
  assert(!fs.existsSync(path.join(outputDir, "academic-cv.html")), "Document-type change must delete the other type's artifact");
}

function resetValidationRoot(rootDir) {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const validationBase = path.join(repoRoot, "validation-output");
  const resolved = path.resolve(rootDir);
  assert(
    resolved === validationBase || resolved.startsWith(`${validationBase}${path.sep}`),
    `Refusing to reset validation output outside ${validationBase}`
  );
  fs.rmSync(resolved, { recursive: true, force: true });
  fs.mkdirSync(resolved, { recursive: true });
}

function validateAcademicCv(rootDir, result, evidence, masterCv) {
  assert(result.documentType === "academic_cv", `Expected academic_cv, got ${result.documentType}`);
  const artifactPath = path.join(rootDir, result.artifacts.artifact);
  const evidenceMapPath = path.join(rootDir, result.artifacts.evidence_map);
  const planPath = path.join(rootDir, result.artifacts.adaptation_plan);
  const changeLogPath = path.join(rootDir, result.artifacts.change_log);
  [artifactPath, evidenceMapPath, planPath, changeLogPath].forEach((file) =>
    assert(fs.existsSync(file), `Expected CV output file: ${file}`)
  );

  const html = fs.readFileSync(artifactPath, "utf8");
  const evidenceMap = readYaml(evidenceMapPath);
  assert(evidenceMap.review_status === REVIEW_STATUS, "Evidence map review status must require review");
  assert(!html.includes("{{"), "Rendered academic CV still contains template placeholders");
  validateRequiredSections(html, REQUIRED_SECTIONS.academic_cv);
  validateEvidenceUse(html, evidenceMap, evidence, masterCv);

  const plan = fs.readFileSync(planPath, "utf8");
  const changeLog = fs.readFileSync(changeLogPath, "utf8");
  assert(plan.includes(`**Review status:** ${REVIEW_STATUS}`), "Adaptation plan missing review status");
  assert(changeLog.includes("Did not edit `selected student's master-cv.md`"), "Change log must record master CV preservation");
  assert(result.estimatedPages === estimateHtmlPages(html), "Stored page estimate is not deterministic");
}

function validateResumeScenario(rootDir, evaluation, profile, evidence, masterCv) {
  const resumeEvaluation = {
    ...evaluation,
    id: `${evaluation.id}-resume-check`,
    cv_adaptation_plan: resumePlanFor(evaluation),
  };
  const result = renderCvAdaptation(rootDir, {
    evaluation: resumeEvaluation,
    profile,
    evidence,
    masterCv,
    documentInstructions: {
      page_limit: 2,
      text: "Upload a concise resume with a two-page limit.",
    },
  });
  assert(result.documentType === "admissions_resume", "Page-limit instruction should select admissions_resume");
  const html = fs.readFileSync(path.join(rootDir, result.artifacts.artifact), "utf8");
  const evidenceMap = readYaml(path.join(rootDir, result.artifacts.evidence_map));
  validateRequiredSections(html, REQUIRED_SECTIONS.admissions_resume);
  validateEvidenceUse(html, evidenceMap, evidence, masterCv);
  assert(evidenceMap.estimated_pages <= evidenceMap.page_limit, "Resume estimate exceeds page limit");
  assert(result.evidenceIdsOmitted.length > 0, "Resume should omit some evidence for concision");
}

function validatePlanPreflightFailures(rootDir, evaluation, profile, evidence, masterCv) {
  const baseInput = {
    profile,
    evidence,
    masterCv,
    documentInstructions: {},
  };
  assertRenderFails(
    rootDir,
    {
      ...baseInput,
      evaluation: withoutKey(evaluation, "cv_adaptation_plan"),
    },
    /CV adaptation plan preflight failed.*missing cv_adaptation_plan/,
    "Missing adaptation plan should fail before rendering"
  );
  const withPlan = (id, plan) => ({
    ...baseInput,
    evaluation: {
      ...evaluation,
      id: `${evaluation.id}-${id}`,
      cv_adaptation_plan: { ...evaluation.cv_adaptation_plan, ...plan },
    },
  });

  assertRenderFails(
    rootDir,
    withPlan("thin-plan", { summary: "Use a CV." }),
    /summary must be at least/,
    "Thin adaptation plan summary should fail before rendering"
  );
  assertRenderFails(
    rootDir,
    withPlan("missing-profile-summary", { profile_summary: "" }),
    /profile_summary must be an agent-authored applicant summary line/,
    "Missing profile summary should fail before rendering rather than falling back to renderer text"
  );
  assertRenderFails(
    rootDir,
    withPlan("unknown-priority-id", {
      evidence_priorities: ["edu-pmc-bsc-cs", "research-human-feedback-thesis", "not-a-real-evidence-id"],
    }),
    /not an evidence ID from the selected student's evidence.yml: not-a-real-evidence-id/,
    "Unknown evidence ID in priorities should fail before rendering"
  );
  assertRenderFails(
    rootDir,
    withPlan("duplicate-priority-id", {
      evidence_priorities: ["edu-pmc-bsc-cs", "research-human-feedback-thesis", "research-human-feedback-thesis"],
    }),
    /repeats evidence ID research-human-feedback-thesis/,
    "Duplicate evidence ID in priorities should fail before rendering"
  );
  assertRenderFails(
    rootDir,
    withPlan("no-education-id", {
      evidence_priorities: ["research-human-feedback-thesis", "project-rubric-eval-dashboard", "course-hci"],
    }),
    /must include at least one education evidence ID/,
    "Priorities without an education entry should fail before rendering"
  );
  assertRenderFails(
    rootDir,
    withPlan("resume-illegal-category", {
      document_type: "admissions_resume",
      evidence_priorities: ["edu-pmc-bsc-cs", "research-human-feedback-thesis", "teaching-python-lab"],
    }),
    /an admissions resume cannot render these evidence categories.*teaching-python-lab/,
    "Resume plan selecting a non-resume category should fail before rendering"
  );
  assertRenderFails(
    rootDir,
    {
      ...baseInput,
      documentInstructions: {
        document_type: "academic_cv",
        text: "Submit a current resume.",
      },
      evaluation: { ...evaluation, id: `${evaluation.id}-corrupted-instructions` },
    },
    /document_instructions must stay a faithful transcription/,
    "A structured document_type inside document_instructions should fail loudly as deprecated"
  );
  assertRenderFails(
    rootDir,
    {
      ...baseInput,
      documentInstructions: {
        page_limit: 2,
        text: "Upload a concise resume with a two-page limit.",
      },
      evaluation: {
        ...evaluation,
        id: `${evaluation.id}-override-no-rationale`,
        cv_adaptation_plan: {
          ...evaluation.cv_adaptation_plan,
          document_type: "academic_cv",
          document_type_rationale: "",
        },
      },
    },
    /overrides the official document instructions.*record cv_adaptation_plan.document_type_rationale/,
    "An override without a recorded rationale should fail before rendering"
  );
}

// Documents are English by script, not by ASCII, and the gate covers only the
// fields the renderer actually reads -- so an original kept in `original_title`
// is legal and `Saarbrücken` in a rendered field must still render.
function validateRenderedLanguageGate(rootDir, evaluation, profile, evidence, masterCv) {
  const withEvidence = (id, mutate) => {
    const copy = JSON.parse(JSON.stringify(evidence));
    mutate(copy);
    return {
      profile,
      evidence: copy,
      masterCv,
      documentInstructions: {},
      evaluation: { ...evaluation, id: `${evaluation.id}-${id}` },
    };
  };

  assertRenderFails(
    rootDir,
    withEvidence("cjk-award", (copy) => {
      copy.awards[0].title = "\u4f18\u79c0\u6bd5\u4e1a\u751f";
    }),
    /evidence\.awards\[award-research-poster\]\.title contains Han .* characters/,
    "CJK in a rendered evidence field should fail before rendering"
  );

  assertRenderFails(
    rootDir,
    { profile, evidence, masterCv, documentInstructions: {}, evaluation: {
      ...evaluation,
      id: `${evaluation.id}-cjk-summary`,
      cv_adaptation_plan: { ...evaluation.cv_adaptation_plan, profile_summary: "\u4eba\u673a\u4ea4\u4e92\u4e0e\u6a21\u578b\u8bc4\u4f30\u65b9\u5411\u7684\u7533\u8bf7\u4eba\uff0c\u4e13\u6ce8\u4e8e\u53cd\u9988\u754c\u9762\u3001\u8bc4\u5206\u91cf\u8868\u8bbe\u8ba1\uff0c\u4ee5\u53ca\u57fa\u4e8e Python \u7684\u6a21\u578b\u53cd\u9988\u5206\u6790\u4e0e\u53ef\u89c6\u5316\u5de5\u4f5c\u3002" },
    } },
    /cv_adaptation_plan\.profile_summary contains Han .* characters/,
    "CJK in agent-authored plan prose should fail before rendering"
  );

  // Preserved original in a field the renderer never reads: must pass.
  renderCvAdaptation(rootDir, withEvidence("original-title", (copy) => {
    copy.awards[0].original_title = "\u4f18\u79c0\u6bd5\u4e1a\u751f";
  }));

  // Accented Latin in a rendered field: must pass. Script, not ASCII.
  const accented = renderCvAdaptation(rootDir, withEvidence("accented-latin", (copy) => {
    copy.education[0].institution = "Universit\u00e4t des Saarlandes, Saarbr\u00fccken";
  }));
  const accentedHtml = fs.readFileSync(
    path.join(rootDir, "output", `${evaluation.id}-accented-latin`, "academic-cv.html"),
    "utf8"
  );
  assert(accentedHtml.includes("Saarbr\u00fccken"), "Accented Latin must survive rendering unchanged");
  assert(accented.documentType === "academic_cv", "Accented-Latin fixture should render the academic CV path");
}

function assertRenderFails(rootDir, input, pattern, message) {
  let failed = false;
  try {
    renderCvAdaptation(rootDir, input);
  } catch (error) {
    failed = pattern.test(error.message) && error.message.includes("$admissions-ops cv");
  }
  assert(failed, message);
}

function withoutKey(object, key) {
  const copy = { ...object };
  delete copy[key];
  return copy;
}

function validateReportAndTrackerLinks(rootDir, reportFileName, evaluation, cvResult) {
  const reportPath = path.join(rootDir, "reports", reportFileName);
  const trackerPath = path.join(rootDir, "programs", "tracker.md");
  const report = fs.readFileSync(reportPath, "utf8");
  const tracker = fs.readFileSync(trackerPath, "utf8");
  const parsed = parseTracker(tracker);
  assert(parsed.rows.length === 1, `Expected one tracker row after CV relink, got ${parsed.rows.length}`);

  assert(report.includes(`**Tailored CV:** ${evaluation.tailored_cv}`), "Report header missing CV draft link");
  assert(report.includes("Draft output links:"), "Report section G missing draft output links");
  assert(report.includes(REVIEW_STATUS), "Report must show draft review status");
  assert(parsed.rows[0].CV.includes(REVIEW_STATUS), "Tracker CV column must show review status");

  for (const link of [
    cvResult.links.artifact,
    cvResult.links.adaptation_plan,
    cvResult.links.change_log,
    cvResult.links.evidence_map,
  ]) {
    assert(report.includes(link), `Report missing CV link: ${link}`);
    assert(resolveMarkdownLink(reportPath, link, rootDir), `Report link does not resolve: ${link}`);
  }
  assert(resolveMarkdownLink(trackerPath, parsed.rows[0].CV, rootDir), "Tracker CV link does not resolve");
}

function validateEvidenceUse(html, evidenceMap, evidence, masterCv) {
  const allowedEvidenceIds = new Set(flattenEvidence(evidence).map((entry) => entry.id));
  assert(evidenceMap.generated_claims.length > 0, "Evidence map must include generated claims");

  for (const claim of evidenceMap.generated_claims) {
    assert(allowedEvidenceIds.has(claim.evidence_id), `Unsupported evidence ID: ${claim.evidence_id}`);
    assert(html.includes(`data-evidence-id="${claim.evidence_id}"`), `Rendered claim lacks data-evidence-id: ${claim.evidence_id}`);
    for (const fact of claim.protected_facts || []) {
      assert(
        html.includes(escapeHtml(fact)) || html.includes(fact) || masterCv.includes(fact),
        `Protected fact was not preserved exactly: ${fact}`
      );
    }
  }

  const renderedIds = [...html.matchAll(/data-evidence-id="([^"]+)"/g)].map((match) => match[1]);
  for (const id of renderedIds) {
    assert(allowedEvidenceIds.has(id), `Rendered unsupported evidence ID: ${id}`);
  }
}

function validateUnsupportedEvidenceFailure(rootDir, result, evidence) {
  const html = fs.readFileSync(path.join(rootDir, result.artifacts.artifact), "utf8");
  const evidenceMap = readYaml(path.join(rootDir, result.artifacts.evidence_map));
  evidenceMap.generated_claims.push({
    evidence_id: "missing-evidence-id",
    protected_facts: ["Unsupported claim"],
  });
  let failed = false;
  try {
    validateEvidenceUse(html, evidenceMap, evidence, "");
  } catch (error) {
    failed = /Unsupported evidence ID/.test(error.message);
  }
  assert(failed, "Unsupported evidence ID should fail evidence-use validation");
}

function validateRequiredSections(html, sections) {
  let cursor = -1;
  for (const section of sections) {
    const index = html.indexOf(`<h2>${section}</h2>`);
    assert(index > cursor, `Missing or out-of-order document section: ${section}`);
    cursor = index;
  }
}

function validateMasterCvUnchanged(file, beforeHash) {
  assert(hashFile(file) === beforeHash, "Rendering mutated the canonical master CV fixture");
}

function resolveMarkdownLink(baseFile, markdownLink, rootDir) {
  const match = markdownLink.match(/\]\(([^)]+)\)/);
  if (!match) return false;
  const resolved = path.resolve(path.dirname(baseFile), match[1]);
  assert(resolved.startsWith(path.resolve(rootDir)), `Link escapes validation root: ${markdownLink}`);
  return fs.existsSync(resolved);
}

function hashFile(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

main();
