const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const { slugify } = require("./program-writer");

const DOCUMENT_TYPES = new Set(["academic_cv", "admissions_resume"]);
const REVIEW_STATUS = "Review Required";
const MIN_PLAN_SUMMARY_LENGTH = 60;
const MIN_PROFILE_SUMMARY_LENGTH = 40;
const MIN_PLAN_PRIORITIES = 3;
const CLI_OVERRIDE_RATIONALE = "User requested this document type via the --document-type flag.";
const EVIDENCE_CATEGORIES = [
  "education",
  "courses",
  "research",
  "projects",
  "awards",
  "publications",
  "presentations",
  "teaching",
  "service",
];
// The admissions resume template only has sections for these categories; the
// preflight rejects plans that select evidence a resume cannot render.
const RESUME_CATEGORIES = new Set(["education", "courses", "research", "projects", "awards"]);
const PLAN_PREFLIGHT_HINT =
  "Run `$admissions-ops cv` or the full `$admissions-ops program for student <student-id>` pipeline before `npm run cv`.";

const REQUIRED_SECTIONS = {
  academic_cv: [
    "Education",
    "Relevant Coursework",
    "Research Interests",
    "Research Experience",
    "Publications And Presentations",
    "Projects",
    "Teaching And Service",
    "Awards",
    "Methods And Tools",
  ],
  admissions_resume: [
    "Education",
    "Selected Research And Projects",
    "Relevant Coursework",
    "Awards",
    "Skills",
  ],
};

// The instruction-derived document type comes only from the faithful official
// text and page-limit evidence. It is never read from a structured
// document_type field: the agent records overrides in
// cv_adaptation_plan.document_type with a rationale, so the official
// transcription cannot be edited to defeat the guard.
function instructionDerivedDocumentType(documentInstructions = {}) {
  const text = String(documentInstructions.text || "").toLowerCase();
  const mentionsResume = /\bresume\b/.test(text);
  const mentionsCv = /\bcv\b/.test(text);
  if (documentInstructions.page_limit || /page limit/.test(text)) {
    return "admissions_resume";
  }
  if (mentionsResume && !mentionsCv) return "admissions_resume";
  if (mentionsCv && !mentionsResume) return "academic_cv";
  return null;
}

// Precedence: CLI --document-type > agent plan document_type. The
// instruction-derived type is a default to compare against, not a decision
// channel; disagreement is an override that must carry a rationale.
function resolveDocumentType(plan, cliOverride) {
  if (cliOverride) return assertDocumentType(cliOverride);
  return assertDocumentType(plan.document_type);
}

function effectiveOverrideRationale(plan, cliOverride) {
  if (cliOverride && cliOverride !== plan.document_type) return CLI_OVERRIDE_RATIONALE;
  const recorded = String(plan.document_type_rationale || "").trim();
  if (recorded) return recorded;
  return cliOverride ? CLI_OVERRIDE_RATIONALE : "";
}

function assertDocumentType(documentType) {
  if (!DOCUMENT_TYPES.has(documentType)) {
    throw new Error(`Unsupported document type: ${documentType}`);
  }
  return documentType;
}

function renderCvAdaptation(rootDir, input) {
  const cliOverride = input.documentTypeOverride ? assertDocumentType(input.documentTypeOverride) : null;
  validateCvAdaptationPlan(input.evaluation, input.documentInstructions, input.evidence, { cliOverride });
  const plan = input.evaluation.cv_adaptation_plan;
  const documentType = resolveDocumentType(plan, cliOverride);
  const derivedType = instructionDerivedDocumentType(input.documentInstructions);
  const override =
    derivedType && derivedType !== documentType
      ? {
          instructionDerived: derivedType,
          chosenType: documentType,
          rationale: effectiveOverrideRationale(plan, cliOverride),
          officialText: String((input.documentInstructions || {}).text || "").trim(),
        }
      : null;
  const programId = input.evaluation.id || programIdFromEvaluation(input.evaluation);
  const outputDir = path.join(rootDir, "output", programId);
  fs.mkdirSync(outputDir, { recursive: true });

  const model =
    documentType === "academic_cv"
      ? buildAcademicCvModel(input)
      : buildAdmissionsResumeModel(input);
  const templateFile =
    documentType === "academic_cv" ? "academic-cv-template.html" : "admissions-resume-template.html";
  const artifactFile =
    documentType === "academic_cv" ? "academic-cv.html" : "admissions-resume.html";
  const otherArtifactFile =
    documentType === "academic_cv" ? "admissions-resume.html" : "academic-cv.html";
  const html = fillTemplate(path.join(__dirname, "..", "..", "templates", templateFile), model.placeholders);

  // One CV artifact per program output directory: a document-type change
  // removes the other type's file in the same run so no orphan can go stale
  // against the single sidecar set.
  fs.rmSync(path.join(outputDir, otherArtifactFile), { force: true });

  const artifactPath = path.join(outputDir, artifactFile);
  const adaptationPlanPath = path.join(outputDir, "adaptation-plan.md");
  const changeLogPath = path.join(outputDir, "change-log.md");
  const evidenceMapPath = path.join(outputDir, "evidence-map.yml");

  const evidenceMap = {
    program_id: programId,
    institution: input.evaluation.institution,
    program: input.evaluation.program,
    document_type: documentType,
    review_status: REVIEW_STATUS,
    artifact: rel(rootDir, artifactPath),
    sources: input.sourceLabels || {
      profile: "selected student profile.yml for identity and contact only",
      evidence: "selected student evidence.yml",
      master_cv: "selected student master-cv.md",
    },
    generated_claims: model.claims,
    estimated_pages: estimateHtmlPages(html),
    page_limit: input.documentInstructions && input.documentInstructions.page_limit
      ? input.documentInstructions.page_limit
      : null,
  };

  fs.writeFileSync(artifactPath, html);
  fs.writeFileSync(adaptationPlanPath, renderAdaptationPlan(input, model, documentType, evidenceMap));
  fs.writeFileSync(changeLogPath, renderChangeLog(input, model, documentType, override));
  fs.writeFileSync(evidenceMapPath, yaml.dump(evidenceMap, { lineWidth: 100 }));

  const artifacts = {
    adaptation_plan: rel(rootDir, adaptationPlanPath),
    artifact: rel(rootDir, artifactPath),
    change_log: rel(rootDir, changeLogPath),
    evidence_map: rel(rootDir, evidenceMapPath),
  };
  const links = Object.fromEntries(
    Object.entries(artifacts).map(([key, value]) => [key, markdownLink(labelForArtifact(key), value)])
  );

  return {
    programId,
    documentType,
    override,
    reviewStatus: REVIEW_STATUS,
    sectionOrder: model.sectionOrder,
    evidenceIdsUsed: model.evidenceIdsUsed,
    evidenceIdsOmitted: model.evidenceIdsOmitted,
    artifacts,
    links,
    estimatedPages: evidenceMap.estimated_pages,
  };
}

function validateCvAdaptationPlan(evaluation, documentInstructions = {}, evidence = null, options = {}) {
  const cliOverride = options.cliOverride || null;
  const plan = evaluation && evaluation.cv_adaptation_plan;
  const programLabel = evaluation && evaluation.id ? evaluation.id : "evaluation";
  if (!plan || typeof plan !== "object") {
    failPlanPreflight(programLabel, "missing cv_adaptation_plan");
  }

  const instructions = documentInstructions || {};
  if (instructions.document_type || instructions.requested_document_type) {
    failPlanPreflight(
      programLabel,
      "document_instructions must stay a faithful transcription of the official text and may not carry " +
        "document_type or requested_document_type; record the choice in cv_adaptation_plan.document_type " +
        "with a document_type_rationale when it overrides the official instructions"
    );
  }

  assertDocumentType(plan.document_type);
  const summary = String(plan.summary || "").trim();
  if (summary.length < MIN_PLAN_SUMMARY_LENGTH) {
    failPlanPreflight(
      programLabel,
      `cv_adaptation_plan.summary must be at least ${MIN_PLAN_SUMMARY_LENGTH} characters`
    );
  }

  const profileSummary = String(plan.profile_summary || "").trim();
  if (profileSummary.length < MIN_PROFILE_SUMMARY_LENGTH) {
    failPlanPreflight(
      programLabel,
      `cv_adaptation_plan.profile_summary must be an agent-authored applicant summary line of at least ${MIN_PROFILE_SUMMARY_LENGTH} characters`
    );
  }

  const priorities = Array.isArray(plan.evidence_priorities)
    ? plan.evidence_priorities.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  if (priorities.length < MIN_PLAN_PRIORITIES) {
    failPlanPreflight(
      programLabel,
      `cv_adaptation_plan.evidence_priorities must contain at least ${MIN_PLAN_PRIORITIES} entries`
    );
  }

  const categories = evidenceCategoryIndex(evidence);
  const seen = new Set();
  for (const id of priorities) {
    if (!categories.has(id)) {
      failPlanPreflight(
        programLabel,
        `cv_adaptation_plan.evidence_priorities entry is not an evidence ID from the selected student's evidence.yml: ${id}`
      );
    }
    if (seen.has(id)) {
      failPlanPreflight(programLabel, `cv_adaptation_plan.evidence_priorities repeats evidence ID ${id}`);
    }
    seen.add(id);
  }
  if (!priorities.some((id) => categories.get(id) === "education")) {
    failPlanPreflight(
      programLabel,
      "cv_adaptation_plan.evidence_priorities must include at least one education evidence ID"
    );
  }

  const chosenType = resolveDocumentType(plan, cliOverride);
  if (chosenType === "admissions_resume") {
    const unsupported = priorities.filter((id) => !RESUME_CATEGORIES.has(categories.get(id)));
    if (unsupported.length > 0) {
      failPlanPreflight(
        programLabel,
        `an admissions resume cannot render these evidence categories; remove the IDs from evidence_priorities or choose academic_cv: ${unsupported.join(", ")}`
      );
    }
  }

  const derivedType = instructionDerivedDocumentType(instructions);
  if (derivedType && derivedType !== chosenType && !effectiveOverrideRationale(plan, cliOverride)) {
    failPlanPreflight(
      programLabel,
      `cv_adaptation_plan.document_type ${chosenType} overrides the official document instructions (which derive ${derivedType}); record cv_adaptation_plan.document_type_rationale`
    );
  }
}

function failPlanPreflight(programLabel, reason) {
  throw new Error(`CV adaptation plan preflight failed for ${programLabel}: ${reason}. ${PLAN_PREFLIGHT_HINT}`);
}

// Maps evidence ID -> category name for every known evidence category.
function evidenceCategoryIndex(evidence) {
  const index = new Map();
  for (const category of EVIDENCE_CATEGORIES) {
    for (const entry of (evidence && evidence[category]) || []) {
      if (entry && entry.id) index.set(entry.id, category);
    }
  }
  return index;
}

function attachCvArtifactsToEvaluation(evaluation, result) {
  return {
    ...evaluation,
    tailored_cv: `${result.links.artifact} (${REVIEW_STATUS})`,
    cv_adaptation_plan: {
      ...evaluation.cv_adaptation_plan,
      document_type: result.documentType,
      section_order: result.sectionOrder,
      evidence_ids_used: result.evidenceIdsUsed,
      evidence_ids_omitted: result.evidenceIdsOmitted,
      review_status: REVIEW_STATUS,
      artifacts: {
        adaptation_plan: result.links.adaptation_plan,
        artifact: result.links.artifact,
        change_log: result.links.change_log,
        evidence_map: result.links.evidence_map,
      },
    },
  };
}

// Both model builders serialize the agent's plan: every rendered evidence
// entry comes from cv_adaptation_plan.evidence_priorities, in the plan's
// order within each section. The renderer never re-ranks or supplements the
// agent's selection.
function buildAcademicCvModel({ profile, evidence, evaluation }) {
  const claims = [];
  const evidenceIdsUsed = new Set();
  const allEvidenceIds = flattenEvidence(evidence).map((entry) => entry.id);
  const plan = evaluation.cv_adaptation_plan;
  const selected = selectPlannedEvidence(evidence, plan.evidence_priorities);

  // Coursework renders once as its own section: the evidence schema does not
  // link courses to an institution, so nesting the list under an education
  // entry would misattribute grades when more than one degree is selected.
  const education = selected.education.map((item) =>
    entry(item.id, [
      `<div class="entry-title">${escapeHtml(item.degree)}</div>`,
      `<div>${escapeHtml(item.institution)}</div>`,
      metaWithStatus([item.dates], item.status),
    ].join("\n"), claims, evidenceIdsUsed, protectedFacts(item, ["degree", "institution", "dates", "status"]))
  ).join("\n");

  const coursework = renderCoursework(selected.courses, claims, evidenceIdsUsed);

  const researchInterests = selected.research.map((item) =>
    entry(item.id, `<p>${escapeHtml(item.title)}; ${escapeHtml(item.methods.join("; "))}.</p>`, claims, evidenceIdsUsed, protectedFacts(item, ["title", "methods"]))
  ).join("\n");

  const research = selected.research.map((item) =>
    entry(item.id, [
      `<div class="entry-title">${escapeHtml(item.title)}</div>`,
      metaWithStatus([item.role, item.dates], item.status),
      `<p>${escapeHtml(item.summary)}</p>`,
      `<ul>${item.methods.map((method) => `<li>${escapeHtml(method)}</li>`).join("")}</ul>`,
    ].join("\n"), claims, evidenceIdsUsed, protectedFacts(item, ["title", "role", "dates", "status"]))
  ).join("\n");

  const publicationsPresentations = [
    renderPublications(selected.publications, claims, evidenceIdsUsed),
    renderPresentations(selected.presentations, claims, evidenceIdsUsed),
  ].filter(Boolean).join("\n") || "<p>None selected in the adaptation plan.</p>";

  const projects = selected.projects.map((item) =>
    entry(item.id, [
      `<div class="entry-title">${escapeHtml(item.title)}</div>`,
      `<div class="meta">${escapeHtml(item.dates)}</div>`,
      `<p>${escapeHtml(item.summary)}</p>`,
      `<p>Tools: ${escapeHtml(item.tools.join(", "))}</p>`,
    ].join("\n"), claims, evidenceIdsUsed, protectedFacts(item, ["title", "dates"]))
  ).join("\n");

  const teachingService = [
    ...selected.teaching.map((item) =>
      entry(item.id, [
        `<div class="entry-title">${escapeHtml(item.role)}</div>`,
        `<div>${escapeHtml(item.course)}</div>`,
        `<div class="meta">${escapeHtml(item.dates)}</div>`,
      ].join("\n"), claims, evidenceIdsUsed, protectedFacts(item, ["role", "course", "dates"]))
    ),
    ...selected.service.map((item) =>
      entry(item.id, `<div class="entry-title">${escapeHtml(item.title || item.role)}</div>`, claims, evidenceIdsUsed, protectedFacts(item, ["title", "role", "dates"]))
    ),
  ].join("\n") || "<p>None selected in the adaptation plan.</p>";

  const awards = selected.awards.map((item) =>
    entry(item.id, [
      `<div class="entry-title">${escapeHtml(item.title)}</div>`,
      `<div>${escapeHtml(item.issuer)}</div>`,
      `<div class="meta">${escapeHtml(item.date)}</div>`,
    ].join("\n"), claims, evidenceIdsUsed, protectedFacts(item, ["title", "issuer", "date"]))
  ).join("\n");

  const methodsTools = renderMethodsTools(
    { research: selected.research, projects: selected.projects },
    claims,
    evidenceIdsUsed
  );
  const sectionOrder = REQUIRED_SECTIONS.academic_cv;

  return {
    placeholders: commonPlaceholders(profile, {
      PROGRAM_SPECIFIC_SUMMARY: renderProfileSummary(plan),
      EDUCATION: education,
      COURSEWORK: coursework,
      RESEARCH_INTERESTS: researchInterests,
      RESEARCH: research,
      PUBLICATIONS_PRESENTATIONS: publicationsPresentations,
      PROJECTS: projects,
      TEACHING_SERVICE: teachingService,
      AWARDS: awards,
      METHODS_TOOLS: methodsTools,
    }),
    sectionOrder,
    claims,
    evidenceIdsUsed: [...evidenceIdsUsed],
    evidenceIdsOmitted: allEvidenceIds.filter((id) => !evidenceIdsUsed.has(id)),
    terminologyChanges: [`Mirrored ${evaluation.program} terminology only where supported by evidence titles and methods.`],
  };
}

function buildAdmissionsResumeModel({ profile, evidence, evaluation }) {
  const claims = [];
  const evidenceIdsUsed = new Set();
  const allEvidenceIds = flattenEvidence(evidence).map((entry) => entry.id);
  const plan = evaluation.cv_adaptation_plan;
  const selected = selectPlannedEvidence(evidence, plan.evidence_priorities);

  const education = selected.education.map((item) =>
    entry(item.id, [
      `<div class="entry-title">${escapeHtml(item.degree)}</div>`,
      `<div>${escapeHtml(item.institution)}</div>`,
      metaWithStatus([item.dates], item.status),
    ].join("\n"), claims, evidenceIdsUsed, protectedFacts(item, ["degree", "institution", "dates", "status"]))
  ).join("\n");

  // Research and project entries interleave in the plan's priority order so
  // the agent's ranking, not the evidence category, decides what leads.
  const selectedResearchProjects = selected.ordered
    .filter(({ category }) => category === "research" || category === "projects")
    .map(({ category, item }) =>
      category === "research"
        ? entry(item.id, [
            `<div class="entry-title">${escapeHtml(item.title)}</div>`,
            metaWithStatus([item.role, item.dates], item.status),
            `<p>${escapeHtml(item.summary)}</p>`,
          ].join("\n"), claims, evidenceIdsUsed, protectedFacts(item, ["title", "role", "dates", "status"]))
        : entry(item.id, [
            `<div class="entry-title">${escapeHtml(item.title)}</div>`,
            `<div class="meta">${escapeHtml(item.dates)}</div>`,
            `<p>${escapeHtml(item.summary)}</p>`,
          ].join("\n"), claims, evidenceIdsUsed, protectedFacts(item, ["title", "dates"]))
    )
    .join("\n");

  const coursework = renderCoursework(selected.courses, claims, evidenceIdsUsed);
  const awards = selected.awards.map((item) =>
    entry(item.id, [
      `<div class="entry-title">${escapeHtml(item.title)}</div>`,
      `<div>${escapeHtml(item.issuer)}</div>`,
      `<div class="meta">${escapeHtml(item.date)}</div>`,
    ].join("\n"), claims, evidenceIdsUsed, protectedFacts(item, ["title", "issuer", "date"]))
  ).join("\n");

  const skills = renderMethodsTools(
    { research: selected.research, projects: selected.projects },
    claims,
    evidenceIdsUsed
  );
  const sectionOrder = REQUIRED_SECTIONS.admissions_resume;

  return {
    placeholders: commonPlaceholders(profile, {
      PROGRAM_SPECIFIC_SUMMARY: renderProfileSummary(plan),
      EDUCATION: education,
      SELECTED_RESEARCH_PROJECTS: selectedResearchProjects,
      COURSEWORK: coursework,
      AWARDS: awards,
      SKILLS: skills,
    }),
    sectionOrder,
    claims,
    evidenceIdsUsed: [...evidenceIdsUsed],
    evidenceIdsOmitted: allEvidenceIds.filter((id) => !evidenceIdsUsed.has(id)),
    terminologyChanges: [`Used ${evaluation.program} framing in the summary without adding unsupported claims.`],
  };
}

// The profile summary is the agent's line, rendered verbatim (escaped). It is
// authored in the plan rather than derived from a single evidence entry, so it
// carries no data-evidence-id and never falls back to renderer-generated text.
function renderProfileSummary(plan) {
  return `<p>${escapeHtml(String(plan.profile_summary).trim())}</p>`;
}

// Resolves the plan's ordered evidence IDs against evidence.yml, preserving
// plan order both per category and across categories. The preflight has
// already rejected unknown or duplicate IDs.
function selectPlannedEvidence(evidence, evidencePriorities) {
  const entriesById = new Map();
  for (const category of EVIDENCE_CATEGORIES) {
    for (const item of (evidence && evidence[category]) || []) {
      if (item && item.id) entriesById.set(item.id, { category, item });
    }
  }
  const ordered = (evidencePriorities || [])
    .map((id) => entriesById.get(String(id || "").trim()))
    .filter(Boolean);
  const selected = { ordered };
  for (const category of EVIDENCE_CATEGORIES) {
    selected[category] = ordered
      .filter((candidate) => candidate.category === category)
      .map((candidate) => candidate.item);
  }
  return selected;
}

function renderCoursework(courses, claims, evidenceIdsUsed) {
  if (!courses || courses.length === 0) return "";
  return `<ul>${courses.map((course) =>
    entry(course.id, `${escapeHtml(course.title)} (${escapeHtml(course.result)})`, claims, evidenceIdsUsed, protectedFacts(course, ["title", "result"]))
  ).map((content) => `<li>${content}</li>`).join("")}</ul>`;
}

function renderPublications(publications, claims, evidenceIdsUsed) {
  if (!publications || publications.length === 0) return "";
  return publications.map((item) =>
    entry(item.id, [
      `<div class="entry-title">${escapeHtml(item.title)}</div>`,
      metaWithStatus([], item.status),
    ].join("\n"), claims, evidenceIdsUsed, protectedFacts(item, ["title", "authors", "status"]))
  ).join("\n");
}

function renderPresentations(presentations, claims, evidenceIdsUsed) {
  if (!presentations || presentations.length === 0) return "";
  return presentations.map((item) =>
    entry(item.id, [
      `<div class="entry-title">${escapeHtml(item.title)}</div>`,
      `<div>${escapeHtml(item.venue)}</div>`,
      metaWithStatus([item.date], item.status),
    ].join("\n"), claims, evidenceIdsUsed, protectedFacts(item, ["title", "venue", "date", "status"]))
  ).join("\n");
}

function renderMethodsTools(evidence, claims, evidenceIdsUsed) {
  const rows = [];
  for (const item of evidence.research || []) {
    if (item.methods && item.methods.length > 0) {
      rows.push(entry(item.id, escapeHtml(item.methods.join(", ")), claims, evidenceIdsUsed, protectedFacts(item, ["methods"])));
    }
  }
  for (const item of evidence.projects || []) {
    if (item.tools && item.tools.length > 0) {
      rows.push(entry(item.id, escapeHtml(item.tools.join(", ")), claims, evidenceIdsUsed, protectedFacts(item, ["tools"])));
    }
  }
  return rows.length === 0 ? "<p>None selected in the adaptation plan.</p>" : `<ul>${rows.map((row) => `<li>${row}</li>`).join("")}</ul>`;
}

// Evidence statuses are controlled machine values (e.g. in_progress). The
// document shows a human-readable label, while data-status carries the raw
// value so protected facts remain byte-exact in the rendered artifact.
function statusLabel(status) {
  return String(status ?? "").replace(/_/g, " ");
}

function metaWithStatus(parts, status) {
  const label = escapeHtml(statusLabel(status));
  const text = parts.map(escapeHtml).join(" | ");
  return `<div class="meta" data-status="${escapeHtml(status)}">${text ? `${text} (${label})` : label}</div>`;
}

function entry(id, html, claims, evidenceIdsUsed, facts) {
  evidenceIdsUsed.add(id);
  claims.push({
    evidence_id: id,
    protected_facts: facts,
  });
  return `<div class="entry" data-evidence-id="${escapeHtml(id)}">${html}</div>`;
}

function protectedFacts(item, keys) {
  const facts = [];
  for (const key of keys) {
    const value = item[key];
    if (Array.isArray(value)) facts.push(...value.map(String));
    else if (value !== undefined && value !== null && value !== "") facts.push(String(value));
  }
  return facts;
}

function commonPlaceholders(profile, values) {
  return {
    LANG: "en",
    NAME: escapeHtml(profile.student.name),
    CONTACT: escapeHtml([profile.student.email, profile.student.location].filter(Boolean).join(" | ")),
    ...values,
  };
}

function fillTemplate(templatePath, placeholders) {
  let html = fs.readFileSync(templatePath, "utf8");
  for (const [key, value] of Object.entries(placeholders)) {
    html = html.replace(new RegExp(`{{${key}}}`, "g"), value);
  }
  return html;
}

function renderAdaptationPlan(input, model, documentType, evidenceMap) {
  const omitted = model.evidenceIdsOmitted.length === 0 ? ["None."] : model.evidenceIdsOmitted;
  return `# Adaptation Plan: ${input.evaluation.institution} - ${input.evaluation.program}

**Document type:** ${documentType}
**Profile summary:** ${String(input.evaluation.cv_adaptation_plan.profile_summary).trim()}
**Review status:** ${REVIEW_STATUS}
**Artifact:** ${evidenceMap.artifact}

## Section Order

${model.sectionOrder.map((section) => `- ${section}`).join("\n")}

## Evidence IDs Used

${model.evidenceIdsUsed.map((id) => `- \`${id}\``).join("\n")}

## Evidence Omitted

${omitted.map((id) => `- ${id === "None." ? id : `\`${id}\``}`).join("\n")}

## Terminology Changes

${model.terminologyChanges.map((item) => `- ${item}`).join("\n")}

## Unresolved Document Questions

${list(input.evaluation.questions).map((item) => `- ${item}`).join("\n") || "- None recorded."}

## Human Review

- Status: ${REVIEW_STATUS}
- Required before this draft is marked final or ready for submission.
`;
}

function renderChangeLog(input, model, documentType, override = null) {
  const masterCvLabel = input.sourceLabels && input.sourceLabels.master_cv
    ? input.sourceLabels.master_cv
    : "selected student's master-cv.md";
  const overrideLine = override
    ? `\n- Document type override: official instructions ("${override.officialText}") derive ${override.instructionDerived}; rendered ${override.chosenType} instead. Rationale: ${override.rationale}`
    : "";
  return `# Change Log: ${input.evaluation.institution} - ${input.evaluation.program}

**Document type:** ${documentType}
**Review status:** ${REVIEW_STATUS}

- Created a program-specific draft from structured evidence and the canonical master CV.${overrideLine}
- Reordered sections as: ${model.sectionOrder.join("; ")}.
- Used evidence IDs: ${model.evidenceIdsUsed.map((id) => `\`${id}\``).join(", ")}.
- Omitted evidence IDs from this draft: ${model.evidenceIdsOmitted.length === 0 ? "none" : model.evidenceIdsOmitted.map((id) => `\`${id}\``).join(", ")}.
- Did not edit \`${masterCvLabel}\`.
`;
}

function list(value) {
  return Array.isArray(value) ? value.filter((item) => item !== undefined && item !== null && String(item).trim()) : [];
}

function estimateHtmlPages(html) {
  const visibleText = html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return Math.max(1, Math.ceil(visibleText.length / 3000));
}

function flattenEvidence(evidence) {
  return Object.values(evidence)
    .filter(Array.isArray)
    .flat()
    .filter((entry) => entry && entry.id);
}

function programIdFromEvaluation(evaluation) {
  return [evaluation.institution, evaluation.program, evaluation.intake].map(slugify).join("-");
}

function rel(rootDir, filePath) {
  return path.relative(rootDir, filePath).split(path.sep).join("/");
}

function markdownLink(label, target) {
  return `[${label}](../${target})`;
}

function labelForArtifact(key) {
  return {
    adaptation_plan: "Adaptation plan",
    artifact: "Review Required draft",
    change_log: "Change log",
    evidence_map: "Evidence map",
  }[key];
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

module.exports = {
  CLI_OVERRIDE_RATIONALE,
  DOCUMENT_TYPES,
  REQUIRED_SECTIONS,
  REVIEW_STATUS,
  attachCvArtifactsToEvaluation,
  estimateHtmlPages,
  flattenEvidence,
  instructionDerivedDocumentType,
  renderCvAdaptation,
  validateCvAdaptationPlan,
};
