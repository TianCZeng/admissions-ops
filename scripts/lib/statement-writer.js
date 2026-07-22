const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const { flattenEvidence, REVIEW_STATUS } = require("./cv-writer");
const { slugify } = require("./program-writer");

const STATEMENT_TYPES = new Set(["statement_of_purpose", "personal_statement"]);
const CLAIM_SOURCE_TYPES = new Set(["evidence", "official_program_source", "student_brief"]);
const MIN_STRATEGY_LENGTH = 80;
const MIN_CORE_ARGUMENT_LENGTH = 80;
const MIN_PARAGRAPHS = 3;
const WORDS_PER_PAGE = 500;
const LEGACY_RENDERER_PATTERNS = [
  "A central part of my preparation is",
  "This matches my stated direction",
  "Together, these examples make",
  "documented trajectory",
];
const UNSAFE_READINESS_PATTERN =
  /\b(final|ready for submission|submitted|externally safe|safe for submission)\b|status:\s*(final|ready|submitted)/i;
const PLAN_PREFLIGHT_HINT =
  "Run `$admissions-ops statement` or the full `$admissions-ops program for student <student-id>` pipeline before `npm run statement`.";

function selectStatementTypeFromInstructions(documentInstructions = {}) {
  const text = instructionText(documentInstructions);
  const normalized = text.toLowerCase();
  const sop = /\b(statement of purpose|statement of objectives|academic statement|research statement|purpose statement)\b/.test(normalized);
  const ps = /\b(personal statement|personal history|autobiographical statement|background statement|motivation statement|motivational statement)\b/.test(normalized);
  if (sop && !ps) return { statementType: "statement_of_purpose", status: "selected" };
  if (ps && !sop) return { statementType: "personal_statement", status: "selected" };
  return {
    statementType: "unknown",
    status: "unresolved",
    unresolvedQuestion: sop && ps
      ? "Official instructions mention both SOP-like and personal-statement-like wording."
      : "Official instructions do not clearly identify SOP or personal statement wording.",
  };
}

function renderStatementAdaptation(rootDir, input) {
  validateStatementPlan(input.evaluation, input.evidence, input.statementBrief, input.documentInstructions);
  const programId = input.evaluation.id || programIdFromEvaluation(input.evaluation);
  const outputDir = path.join(rootDir, "output", programId);
  const model = buildStatementPackage(input);
  enforceLimits(input.evaluation.statement_plan, model.wordCount);

  fs.mkdirSync(outputDir, { recursive: true });
  const planPath = path.join(outputDir, "statement-plan.md");
  const draftPath = path.join(outputDir, "statement-draft.md");
  const evidenceMapPath = path.join(outputDir, "statement-evidence-map.yml");
  const changeLogPath = path.join(outputDir, "statement-change-log.md");

  fs.writeFileSync(planPath, renderPlan(input, model));
  fs.writeFileSync(draftPath, model.draft);
  fs.writeFileSync(evidenceMapPath, yaml.dump(renderEvidenceMap(input, model, rootDir, draftPath), { lineWidth: 100 }));
  fs.writeFileSync(changeLogPath, renderChangeLog(input, model));

  const artifacts = {
    statement_plan: rel(rootDir, planPath),
    statement_draft: rel(rootDir, draftPath),
    statement_change_log: rel(rootDir, changeLogPath),
    statement_evidence_map: rel(rootDir, evidenceMapPath),
  };
  const links = Object.fromEntries(
    Object.entries(artifacts).map(([key, value]) => [key, markdownLink(labelForArtifact(key), value)])
  );

  return {
    programId,
    statementType: input.evaluation.statement_plan.statement_type,
    reviewStatus: REVIEW_STATUS,
    artifacts,
    links,
    wordCount: model.wordCount,
    estimatedPages: estimateStatementPages(model.wordCount),
    evidenceIdsUsed: model.evidenceIdsUsed,
  };
}

function validateStatementPlan(evaluation, evidence, statementBrief, documentInstructions = {}) {
  const plan = evaluation && evaluation.statement_plan;
  const programLabel = evaluation && evaluation.id ? evaluation.id : "evaluation";
  assertEvaluatedRecord(evaluation, programLabel);
  if (!statementBrief || !String(statementBrief).trim()) {
    failPlanPreflight(programLabel, "missing statement-brief.md content");
  }
  if (!plan || typeof plan !== "object") {
    failPlanPreflight(programLabel, "missing statement_plan");
  }
  if (!STATEMENT_TYPES.has(plan.statement_type)) {
    failPlanPreflight(programLabel, `unsupported statement_type: ${plan.statement_type}`);
  }
  if (plan.review_status !== REVIEW_STATUS) {
    failPlanPreflight(programLabel, "statement_plan.review_status must be Review Required");
  }
  if (plan.draft_artifact) {
    failPlanPreflight(programLabel, "statement_plan.draft_artifact path inputs are unsupported in Phase 6.4; use inline statement_plan.draft_markdown");
  }

  const selected = selectStatementTypeFromInstructions(documentInstructions);
  if (selected.statementType === "unknown") {
    failPlanPreflight(programLabel, `ambiguous official statement instructions: ${selected.unresolvedQuestion}`);
  }
  if (selected.statementType !== plan.statement_type) {
    failPlanPreflight(
      programLabel,
      `statement_plan.statement_type ${plan.statement_type} conflicts with official instructions requiring ${selected.statementType}`
    );
  }

  if (!plan.prompt_source_url && list(plan.unresolved_questions).length === 0) {
    failPlanPreflight(programLabel, "statement_plan requires prompt_source_url or unresolved_questions");
  }
  if (!String(plan.prompt_text || plan.prompt_summary || "").trim()) {
    failPlanPreflight(programLabel, "statement_plan requires prompt_text or prompt_summary");
  }
  if (String(plan.strategy_summary || "").trim().length < MIN_STRATEGY_LENGTH) {
    failPlanPreflight(programLabel, `statement_plan.strategy_summary must be at least ${MIN_STRATEGY_LENGTH} characters`);
  }
  if (String(plan.core_argument || "").trim().length < MIN_CORE_ARGUMENT_LENGTH) {
    failPlanPreflight(programLabel, `statement_plan.core_argument must be at least ${MIN_CORE_ARGUMENT_LENGTH} characters`);
  }
  if (isGenericPlanText(plan.strategy_summary, evaluation)) {
    failPlanPreflight(programLabel, "statement_plan.strategy_summary must be program-specific");
  }
  const paragraphs = Array.isArray(plan.paragraph_plan) ? plan.paragraph_plan : [];
  if (paragraphs.length < MIN_PARAGRAPHS) {
    failPlanPreflight(programLabel, `statement_plan.paragraph_plan must contain at least ${MIN_PARAGRAPHS} entries`);
  }
  if (!paragraphs.some((item) => list(item.program_sources).length > 0 || /program|fit|department|course|research|faculty/i.test(String(item.purpose || "")))) {
    failPlanPreflight(programLabel, "statement_plan.paragraph_plan must include a program-specific entry");
  }

  const allowedIds = new Set(flattenEvidence(evidence || {}).map((entry) => entry.id));
  for (const paragraph of paragraphs) {
    for (const id of list(paragraph.evidence_ids)) {
      if (!allowedIds.has(id)) {
        failPlanPreflight(programLabel, `unsupported evidence ID in statement_plan: ${id}`);
      }
    }
  }
  validateDraftAndClaimMap(plan, evaluation, evidence, statementBrief, programLabel);
}

function assertEvaluatedRecord(evaluation, programLabel) {
  for (const field of ["institution", "program", "degree_type", "intake", "sources", "eligibility", "fit", "report_number"]) {
    if (!evaluation || !(field in evaluation)) {
      failPlanPreflight(programLabel, `raw or incomplete evaluation record missing ${field}`);
    }
  }
}

function buildStatementPackage(input) {
  const plan = input.evaluation.statement_plan;
  const draftBody = normalizeDraftMarkdown(plan.draft_markdown);
  const claims = plan.claim_map.map((claim) => ({ ...claim }));
  const evidenceIdsUsed = [...new Set(claims
    .filter((claim) => claim.source_type === "evidence")
    .map((claim) => claim.evidence_id))];
  const draft = `# ${labelForStatementType(plan.statement_type)} Draft: ${input.evaluation.institution} - ${input.evaluation.program}

**Review status:** ${REVIEW_STATUS}

${draftBody}

---

Review required before this statement is treated as final, ready, submitted, or externally safe.
`;
  return {
    claims,
    draft,
    draftBody,
    evidenceIdsUsed,
    wordCount: countWords(draftBody),
  };
}

function validateDraftAndClaimMap(plan, evaluation, evidence, statementBrief, programLabel) {
  const draftBody = normalizeDraftMarkdown(plan.draft_markdown);
  if (!draftBody) {
    failPlanPreflight(programLabel, "missing statement_plan.draft_markdown");
  }
  if (UNSAFE_READINESS_PATTERN.test(draftBody)) {
    failPlanPreflight(programLabel, "statement_plan.draft_markdown claims final, ready, submitted, or externally safe status");
  }
  for (const pattern of LEGACY_RENDERER_PATTERNS) {
    if (draftBody.includes(pattern)) {
      failPlanPreflight(programLabel, `statement_plan.draft_markdown contains retired deterministic renderer phrase: ${pattern}`);
    }
  }
  if (!Array.isArray(plan.claim_map) || plan.claim_map.length === 0) {
    failPlanPreflight(programLabel, "missing statement_plan.claim_map");
  }

  const evidenceById = new Map(flattenEvidence(evidence || {}).map((entry) => [entry.id, entry]));
  const briefSections = parseBrief(statementBrief);
  const officialSources = officialSourceUrls(evaluation, plan);
  const claimIds = new Set();
  const evidenceSourceText = JSON.stringify(evidence || {});

  for (const claim of plan.claim_map) {
    validateClaimBase(claim, claimIds, programLabel);
    if (claim.source_type === "evidence") {
      validateEvidenceClaim(claim, evidenceById, evidenceSourceText, draftBody, programLabel);
    } else if (claim.source_type === "official_program_source") {
      validateOfficialSourceClaim(claim, officialSources, programLabel);
    } else if (claim.source_type === "student_brief") {
      validateBriefClaim(claim, briefSections, programLabel);
    }
  }
}

function renderPlan(input, model) {
  const plan = input.evaluation.statement_plan;
  return `# Statement Plan: ${input.evaluation.institution} - ${input.evaluation.program}

**Statement type:** ${plan.statement_type}  
**Review status:** ${REVIEW_STATUS}  
**Prompt source:** ${plan.prompt_source_url || "unresolved"}  
**Prompt:** ${plan.prompt_text || plan.prompt_summary}
**Word limit:** ${plan.word_limit || "not specified"}  
**Page limit:** ${plan.page_limit || "not specified"}  

## Strategy

${plan.strategy_summary}

## Core Argument

${plan.core_argument}

## Paragraph Plan

${plan.paragraph_plan.map((paragraph, index) => `${index + 1}. ${paragraph.purpose}
   - Evidence IDs: ${list(paragraph.evidence_ids).join(", ") || "none"}
   - Program sources: ${list(paragraph.program_sources).join(", ") || "none"}
   - Brief inputs: ${list(paragraph.brief_inputs).join(", ") || "none"}`).join("\n")}

## Required Program Terms

${bulletList(plan.required_program_terms)}

## Claims To Avoid

${bulletList(plan.claims_to_avoid)}

## Unresolved Questions

${bulletList(plan.unresolved_questions)}
`;
}

function renderEvidenceMap(input, model, rootDir, draftPath) {
  return {
    program_id: input.evaluation.id || programIdFromEvaluation(input.evaluation),
    institution: input.evaluation.institution,
    program: input.evaluation.program,
    statement_type: input.evaluation.statement_plan.statement_type,
    review_status: REVIEW_STATUS,
    artifact: rel(rootDir, draftPath),
    sources: input.sourceLabels || {
      evidence: "selected student evidence.yml",
      master_cv: "selected student master-cv.md",
      statement_brief: "selected student statement-brief.md",
    },
    generated_claims: model.claims,
    word_count: model.wordCount,
    estimated_pages: estimateStatementPages(model.wordCount),
    word_limit: input.evaluation.statement_plan.word_limit || null,
    page_limit: input.evaluation.statement_plan.page_limit || null,
  };
}

function renderChangeLog(input, model) {
  const sourceLabels = input.sourceLabels || {};
  const masterCvLabel = sourceLabels.master_cv || "selected student's master-cv.md";
  const evidenceLabel = sourceLabels.evidence || "selected student's evidence.yml";
  const briefLabel = sourceLabels.statement_brief || "selected student's statement-brief.md";
  return `# Statement Change Log: ${input.evaluation.institution} - ${input.evaluation.program}

**Statement type:** ${input.evaluation.statement_plan.statement_type}  
**Review status:** ${REVIEW_STATUS}

- Packaged and validated an LLM-authored statement draft created by the agent workflow.
- Did not synthesize, rewrite, or improve statement prose in the deterministic runner.
- Used evidence IDs: ${model.evidenceIdsUsed.map((id) => `\`${id}\``).join(", ") || "none"}.
- Mirrored required program terms: ${list(input.evaluation.statement_plan.required_program_terms).join("; ") || "none"}.
- Unresolved questions: ${list(input.evaluation.statement_plan.unresolved_questions).join("; ") || "none"}.
- Word count: ${model.wordCount}; estimated pages: ${estimateStatementPages(model.wordCount)} using ${WORDS_PER_PAGE} words per page.
- Did not edit \`${masterCvLabel}\`.
- Did not edit \`${evidenceLabel}\`.
- Did not edit \`${briefLabel}\`.
`;
}

function attachStatementArtifactsToEvaluation(evaluation, result) {
  return {
    ...evaluation,
    statement: `${result.links.statement_draft} (${REVIEW_STATUS})`,
    statement_plan: {
      ...evaluation.statement_plan,
      review_status: REVIEW_STATUS,
      word_count: result.wordCount,
      estimated_pages: result.estimatedPages,
      evidence_ids_used: result.evidenceIdsUsed,
      artifacts: {
        statement_plan: result.links.statement_plan,
        statement_draft: result.links.statement_draft,
        statement_change_log: result.links.statement_change_log,
        statement_evidence_map: result.links.statement_evidence_map,
      },
    },
  };
}

function enforceLimits(plan, wordCount) {
  if (plan.word_limit && wordCount > Number(plan.word_limit)) {
    failPlanPreflight("statement", `agent-authored statement exceeds word_limit ${plan.word_limit} with ${wordCount} words`);
  }
  if (plan.page_limit && estimateStatementPages(wordCount) > Number(plan.page_limit)) {
    failPlanPreflight(
      "statement",
      `agent-authored statement exceeds page_limit ${plan.page_limit} using ${WORDS_PER_PAGE} words per page`
    );
  }
}

function instructionText(documentInstructions = {}) {
  if (typeof documentInstructions === "string") return documentInstructions;
  // Statement-scoped fields take precedence over the general document text:
  // when a program requires several essays (for example a statement of
  // purpose and a personal history statement), the agent records the faithful
  // statement-scoped official wording in statement_text so the type selection
  // stays unambiguous. The ambiguity guard still fires when no statement-
  // scoped transcription exists.
  for (const value of [
    documentInstructions.statement_text,
    documentInstructions.statement_prompt,
    documentInstructions.prompt_text,
    documentInstructions.text,
    documentInstructions.summary,
  ]) {
    if (value && String(value).trim()) return String(value);
  }
  return "";
}

function isGenericPlanText(value, evaluation) {
  const text = String(value || "").toLowerCase();
  const anchors = [
    evaluation.institution,
    evaluation.program,
    evaluation.department,
    ...(list(evaluation.statement_plan && evaluation.statement_plan.required_program_terms)),
  ].filter(Boolean).map((item) => String(item).toLowerCase());
  return !anchors.some((anchor) => anchor && text.includes(anchor));
}

function protectedFacts(entry) {
  return ["title", "degree", "institution", "role", "dates", "status", "date", "course", "issuer"]
    .map((key) => entry[key])
    .filter((value) => value !== undefined && value !== null)
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .map(String);
}

function normalizeDraftMarkdown(value) {
  return String(value || "").trim();
}

function validateClaimBase(claim, claimIds, programLabel) {
  if (!claim || typeof claim !== "object" || Array.isArray(claim)) {
    failPlanPreflight(programLabel, "statement_plan.claim_map entries must be objects");
  }
  if (!String(claim.claim_id || "").trim()) {
    failPlanPreflight(programLabel, "statement_plan.claim_map entry missing claim_id");
  }
  if (claimIds.has(claim.claim_id)) {
    failPlanPreflight(programLabel, `duplicate statement claim_id: ${claim.claim_id}`);
  }
  claimIds.add(claim.claim_id);
  if (!String(claim.claim_text || claim.claim_summary || "").trim()) {
    failPlanPreflight(programLabel, `statement claim ${claim.claim_id} requires claim_text or claim_summary`);
  }
  if (!CLAIM_SOURCE_TYPES.has(claim.source_type)) {
    failPlanPreflight(programLabel, `unsupported statement claim source_type: ${claim.source_type}`);
  }
}

function validateEvidenceClaim(claim, evidenceById, evidenceSourceText, draftBody, programLabel) {
  if (!String(claim.evidence_id || "").trim()) {
    failPlanPreflight(programLabel, `evidence claim ${claim.claim_id} missing evidence_id`);
  }
  const evidenceEntry = evidenceById.get(claim.evidence_id);
  if (!evidenceEntry) {
    failPlanPreflight(programLabel, `unsupported evidence ID in statement claim_map: ${claim.evidence_id}`);
  }
  for (const fact of list(claim.protected_facts)) {
    if (!evidenceSourceText.includes(fact) && !protectedFacts(evidenceEntry).includes(fact)) {
      failPlanPreflight(programLabel, `protected fact is not present in evidence source for claim ${claim.claim_id}: ${fact}`);
    }
    if (!draftBody.includes(fact)) {
      failPlanPreflight(programLabel, `protected fact mismatch in draft for claim ${claim.claim_id}: ${fact}`);
    }
  }
}

function validateOfficialSourceClaim(claim, officialSources, programLabel) {
  const sourceUrl = String(claim.source_url || "").trim();
  if (!/^https?:\/\//.test(sourceUrl)) {
    failPlanPreflight(programLabel, `official source claim ${claim.claim_id} requires an official source_url`);
  }
  if (!officialSources.has(sourceUrl)) {
    failPlanPreflight(programLabel, `official source claim ${claim.claim_id} references unknown source_url: ${sourceUrl}`);
  }
}

function validateBriefClaim(claim, briefSections, programLabel) {
  if (!String(claim.brief_section || "").trim()) {
    failPlanPreflight(programLabel, `student brief claim ${claim.claim_id} missing brief_section`);
  }
  const normalized = normalizeBriefHeading(claim.brief_section);
  if (!briefSections[normalized]) {
    failPlanPreflight(programLabel, `student brief claim ${claim.claim_id} references unknown brief_section: ${claim.brief_section}`);
  }
}

function officialSourceUrls(evaluation, plan) {
  const sources = [
    evaluation.official_url,
    evaluation.application_url,
    plan.prompt_source_url,
    ...(Array.isArray(evaluation.sources) ? evaluation.sources.map((source) => source.url) : []),
    ...(Array.isArray(evaluation.statement_plan && evaluation.statement_plan.paragraph_plan)
      ? evaluation.statement_plan.paragraph_plan.flatMap((paragraph) => list(paragraph.program_sources))
      : []),
  ];
  return new Set(sources.filter((source) => /^https?:\/\//.test(String(source || ""))));
}

function parseBrief(markdown) {
  const sections = {};
  let current = "";
  for (const line of String(markdown || "").split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      current = normalizeBriefHeading(heading[1]);
      sections[current] = "";
    } else if (current) {
      sections[current] = `${sections[current]}\n${line}`.trim();
    }
  }
  return sections;
}

function normalizeBriefHeading(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function countWords(value) {
  const words = String(value || "").match(/\b[\w'-]+\b/g);
  return words ? words.length : 0;
}

function estimateStatementPages(wordCount) {
  return Math.max(1, Math.ceil(wordCount / WORDS_PER_PAGE));
}

function list(value) {
  return Array.isArray(value) ? value.filter((item) => item !== undefined && item !== null && String(item).trim()) : [];
}

function bulletList(items) {
  const values = list(items);
  return values.length ? values.map((item) => `- ${item}`).join("\n") : "- None.";
}

function failPlanPreflight(programLabel, reason) {
  throw new Error(`Statement plan preflight failed for ${programLabel}: ${reason}. ${PLAN_PREFLIGHT_HINT}`);
}

function labelForStatementType(statementType) {
  return statementType === "personal_statement" ? "Personal Statement" : "Statement Of Purpose";
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
    statement_plan: "Statement plan",
    statement_draft: "Review Required statement",
    statement_change_log: "Statement change log",
    statement_evidence_map: "Statement evidence map",
  }[key];
}

module.exports = {
  REVIEW_STATUS,
  STATEMENT_TYPES,
  WORDS_PER_PAGE,
  attachStatementArtifactsToEvaluation,
  estimateStatementPages,
  renderStatementAdaptation,
  selectStatementTypeFromInstructions,
  validateStatementPlan,
};
