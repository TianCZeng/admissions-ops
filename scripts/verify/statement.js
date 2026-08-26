const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const { flattenEvidence } = require("../lib/cv-writer");
const { countWords } = require("../lib/language");
const {
  REVIEW_STATUS,
  estimateStatementPages,
  selectStatementTypeFromInstructions,
} = require("../lib/statement-writer");
const { runLiveStatement } = require("../cli/statement");
const {
  parseTracker,
  renderReport,
  renderTracker,
  reportFileName,
  trackerRowFromEvaluation,
} = require("../lib/program-writer");

const repoRoot = path.resolve(__dirname, "..", "..");
const validationRoot = path.join(repoRoot, "validation-output", "verify", "statement");
const sourceRoot = path.join(validationRoot, "source");
const studentId = "statement-fixture";
const programId = "northbridge-msc-ai-fall-2027";
const sourceFiles = [
  `students/${studentId}/evidence.yml`,
  `students/${studentId}/master-cv.md`,
  `students/${studentId}/statement-brief.md`,
  `students/${studentId}/evaluations/${programId}.yml`,
  `students/${studentId}/tracker.md`,
  `students/${studentId}/reports/001-northbridge-university-2026-06-18.md`,
];

function main() {
  resetValidationRoot();
  validateTypeSelection();
  validateWordCounting();
  const evaluation = setupSourceWorkspace(sourceRoot, "statement_of_purpose");
  const beforeDryRun = hashFiles(sourceRoot, sourceFiles);
  const dryRun = runLiveStatement({
    program: programId,
    workspace: sourceRoot,
    student: studentId,
    dryRunRoot: path.join(validationRoot, "dry-run", programId),
  });
  assertHashes(sourceRoot, sourceFiles, beforeDryRun, "Dry-run mutated source workspace");
  validateStatementResult(dryRun, "dry-run");
  assert(!fs.existsSync(path.join(sourceRoot, "students", studentId, "output", programId)), "Dry-run wrote into source output");

  validatePersonalStatementDryRun();
  validateWriteMode(evaluation);
  validateFailures();
  validateLegacyTrackerParse();

  console.log(`Statement workflow verifies in ${path.relative(process.cwd(), validationRoot)}`);
}

function resetValidationRoot() {
  assert(validationRoot.startsWith(path.join(repoRoot, "validation-output")), `Refusing reset outside validation-output: ${validationRoot}`);
  fs.rmSync(validationRoot, { recursive: true, force: true });
  fs.mkdirSync(validationRoot, { recursive: true });
}

function validateWordCounting() {
  // The counter is Unicode-aware but must stay byte-equivalent to the old
  // ASCII-only regex for ASCII input, or every committed word_count drifts.
  assert(countWords("Saarbrücken") === 1, "Accented Latin must count as one word");
  assert(countWords("naïve café résumé") === 3, "Accented Latin words must not split");
  assert(countWords("state-of-the-art") === 1, "Hyphenated compounds must count as one word");
  assert(countWords("don't") === 1, "Apostrophes must not split a word");
  assert(countWords("U.S.") === 2, "Sentence punctuation must still split tokens");
  assert(countWords("") === 0 && countWords(null) === 0, "Empty input must count as zero");
}

function validateTypeSelection() {
  assert(
    selectStatementTypeFromInstructions({ text: "Upload a statement of purpose." }).statementType === "statement_of_purpose",
    "SOP instructions should select statement_of_purpose"
  );
  assert(
    selectStatementTypeFromInstructions({ text: "Upload a personal history statement." }).statementType === "personal_statement",
    "PS instructions should select personal_statement"
  );
  const ambiguous = selectStatementTypeFromInstructions({ text: "Upload a statement of purpose and a personal statement." });
  assert(ambiguous.statementType === "unknown" && ambiguous.unresolvedQuestion, "Ambiguous statement wording should remain unresolved");
}

function setupSourceWorkspace(root, statementType, overrides = {}) {
  const base = readYaml(path.join(repoRoot, "examples", "fictional-programs", "northbridge-evaluation.yml"));
  const evaluation = withStatementPlan(base, statementType, overrides);
  const targetStudentRoot = path.join(root, "students", studentId);
  copyFile("examples/fictional-student/evidence.yml", path.join(targetStudentRoot, "evidence.yml"));
  copyFile("examples/fictional-student/master-cv.md", path.join(targetStudentRoot, "master-cv.md"));
  writeText(path.join(targetStudentRoot, "statement-brief.md"), statementBrief());
  writeYaml(path.join(targetStudentRoot, "evaluations", `${evaluation.id}.yml`), evaluation);
  const reportName = reportFileName(evaluation);
  writeText(path.join(targetStudentRoot, "reports", reportName), renderReport(evaluation));
  writeText(path.join(targetStudentRoot, "tracker.md"), renderTracker("# Programs Tracker\n\n", [
    trackerRowFromEvaluation(evaluation, reportName),
  ]));
  return evaluation;
}

function withStatementPlan(base, statementType, overrides = {}) {
  const text = statementType === "personal_statement"
    ? "Upload a personal statement about background and motivation for graduate study."
    : "Upload a statement of purpose describing academic objectives and preparation.";
  return {
    ...base,
    statement: "pending",
    document_instructions: {
      ...(base.document_instructions || {}),
      text,
    },
    statement_plan: {
      statement_type: statementType,
      prompt_source_url: "https://example.edu/graduate/artificial-intelligence/documents",
      prompt_text: text,
      word_limit: 1000,
      page_limit: 2,
      strategy_summary: "Northbridge University MSc Artificial Intelligence statement should connect AI evaluation, HCI coursework, and the student's stated direction without inventing unpublished outcomes.",
      core_argument: "The applicant is prepared for graduate AI study through documented computing education, HCI-facing AI evaluation work, and a stated goal to study reliable human-centered AI systems.",
      paragraph_plan: [
        {
          purpose: "Academic preparation for MSc Artificial Intelligence",
          evidence_ids: ["edu-pmc-bsc-cs", "course-machine-learning"],
          program_sources: [],
          brief_inputs: ["Why graduate study now"],
        },
        {
          purpose: "Program-specific fit with Northbridge University AI evaluation",
          evidence_ids: ["project-rubric-eval-dashboard"],
          program_sources: ["https://example.edu/graduate/artificial-intelligence"],
          brief_inputs: ["Program-Specific Notes"],
        },
        {
          purpose: statementType === "personal_statement" ? "Personal motivation allowed by the student brief" : "Future purpose in human-centered AI",
          evidence_ids: ["presentation-feedback-interfaces"],
          program_sources: ["https://example.edu/graduate/artificial-intelligence"],
          brief_inputs: statementType === "personal_statement" ? ["Personal Background Allowed For Use"] : ["Long-term goal"],
        },
      ],
      required_program_terms: ["artificial intelligence", "human-centered AI"],
      claims_to_avoid: ["Do not describe the poster as a peer-reviewed publication."],
      unresolved_questions: ["Confirm exact portal prompt before final submission."],
      review_status: REVIEW_STATUS,
      draft_markdown: agentDraftMarkdown(statementType),
      claim_map: claimMap(statementType),
      ...(overrides.statement_plan || {}),
    },
    ...withoutStatementPlan(overrides),
  };
}

function withoutStatementPlan(value) {
  const copy = { ...value };
  delete copy.statement_plan;
  return copy;
}

function agentDraftMarkdown(statementType) {
  const personalSentence = statementType === "personal_statement"
    ? "The personal context I am permitted to use is narrow: I am drawn to human-facing AI systems because I have repeatedly worked on interfaces where evaluation decisions shape how people understand model behavior."
    : "The purpose of this application is to deepen that preparation in a program where AI evaluation and human-centered AI are treated as connected technical problems.";
  return `My preparation for graduate study in artificial intelligence began in the BSc Computer Science at Paris Metropolitan College (2023-2027), where I have treated computing as both a technical discipline and a way to study how people work with systems. Machine Learning (A) gave me the formal base for model evaluation, while Human-Computer Interaction (A) helped me examine how interface choices affect interpretation and trust. Those two areas now define the academic direction I want to pursue at Northbridge University.

The clearest example is the Rubric Evaluation Dashboard (2026), a project where I built a local dashboard for reviewing model outputs, assigning rubric scores, and exporting analysis tables. That work made the abstract problem of reliable AI evaluation more concrete for me because it required decisions about rubrics, review flow, and analyzable records. It also connected directly with my undergraduate thesis, Human Feedback Interfaces for Model Evaluation, where I study how evaluators use rubric interfaces to compare AI-generated answers through controlled user study, rubric design, and Python analysis.

Northbridge University's MSc Artificial Intelligence is a strong fit because the program record emphasizes artificial intelligence and human-centered AI as areas where my current evidence can develop into more rigorous graduate work. I am not presenting the dashboard or thesis as finished publications; I am using them as evidence that I can define an evaluation problem, build tooling around it, and reflect on the human decisions involved. My presentation, Designing Feedback Interfaces for Model Evaluation, at the Fictional Undergraduate Research Forum (2026-04), presented this direction to an academic audience and helped me sharpen the questions I want to keep studying.

${personalSentence} My longer-term goal is to build reliable AI evaluation tools, and graduate study is the next step because I need deeper research preparation after the current degree. At Northbridge, I would bring a documented record in computing, HCI-adjacent evaluation work, and careful attention to truthful evidence. I would use the MSc to strengthen my foundations, test better evaluation methods, and prepare for research or applied work focused on AI systems that people can assess with more clarity.`;
}

function claimMap(statementType) {
  return [
    {
      claim_id: "claim-education-1",
      claim_summary: "Draft identifies the student's degree institution and dates.",
      source_type: "evidence",
      evidence_id: "edu-pmc-bsc-cs",
      protected_facts: ["BSc Computer Science", "Paris Metropolitan College", "2023-2027"],
    },
    {
      claim_id: "claim-coursework-1",
      claim_summary: "Draft uses machine learning and HCI coursework results.",
      source_type: "evidence",
      evidence_id: "course-machine-learning",
      protected_facts: ["Machine Learning", "A"],
    },
    {
      claim_id: "claim-project-1",
      claim_summary: "Draft describes the Rubric Evaluation Dashboard project.",
      source_type: "evidence",
      evidence_id: "project-rubric-eval-dashboard",
      protected_facts: ["Rubric Evaluation Dashboard", "2026"],
    },
    {
      claim_id: "claim-presentation-1",
      claim_summary: "Draft names the feedback interfaces presentation.",
      source_type: "evidence",
      evidence_id: "presentation-feedback-interfaces",
      protected_facts: ["Designing Feedback Interfaces for Model Evaluation", "2026-04", "Fictional Undergraduate Research Forum"],
    },
    {
      claim_id: "claim-program-1",
      claim_summary: "Draft connects the statement to the official Northbridge program source.",
      source_type: "official_program_source",
      source_url: "https://example.edu/graduate/artificial-intelligence",
    },
    {
      claim_id: "claim-brief-1",
      claim_summary: "Draft uses the student's stated long-term goal.",
      source_type: "student_brief",
      brief_section: statementType === "personal_statement" ? "Personal Background Allowed For Use" : "General Direction",
    },
  ];
}

function validateStatementResult(result, label) {
  assert(result.reviewStatus === REVIEW_STATUS, `${label} missing review status`);
  for (const file of [
    path.join(result.outputRoot, result.artifacts.statement_plan),
    path.join(result.outputRoot, result.artifacts.statement_draft),
    path.join(result.outputRoot, result.artifacts.statement_change_log),
    path.join(result.outputRoot, result.artifacts.statement_evidence_map),
    result.reportPath,
    result.trackerPath,
  ]) {
    assert(fs.existsSync(file), `${label} expected output file: ${file}`);
  }
  const draft = fs.readFileSync(path.join(result.outputRoot, result.artifacts.statement_draft), "utf8");
  const expectedDraftBody = agentDraftMarkdown(result.statementType);
  const changeLog = fs.readFileSync(path.join(result.outputRoot, result.artifacts.statement_change_log), "utf8");
  const evidenceMap = readYaml(path.join(result.outputRoot, result.artifacts.statement_evidence_map));
  assert(draft.includes(REVIEW_STATUS), `${label} draft missing Review Required`);
  assert(draft.includes(expectedDraftBody), `${label} draft did not preserve supplied LLM-authored prose`);
  assert(!/(status:\s*(final|ready|submitted)|ready for submission|safe for submission)/i.test(expectedDraftBody), `${label} draft body has unsafe readiness language`);
  assert(!/The factual basis is|program-specific fit should be reviewed|narrative direction comes from|Draft uses evidence/i.test(expectedDraftBody), `${label} draft body leaked renderer meta-language`);
  assert(!/A central part of my preparation is|This matches my stated direction|Together, these examples make|documented trajectory/.test(expectedDraftBody), `${label} draft body contains retired renderer phrase`);
  assert(!/\.\./.test(draft), `${label} draft has doubled punctuation`);
  assert(/\bI\b|\bmy\b/i.test(draft), `${label} draft should render statement-style first-person prose`);
  assert(result.wordCount >= 300, `${label} draft is too thin for realistic statement review: ${result.wordCount} words`);
  assert(result.wordCount === countWords(expectedDraftBody), `${label} word count should be computed from supplied draft body`);
  assert(changeLog.includes("LLM-authored statement draft"), `${label} change log must name LLM-authored prose`);
  assert(changeLog.includes("Did not synthesize, rewrite, or improve statement prose"), `${label} change log must not imply Node drafted prose`);
  assert(changeLog.includes("Did not edit `students/statement-fixture/master-cv.md`"), `${label} change log missing master CV preservation`);
  assert(changeLog.includes("Did not edit `students/statement-fixture/evidence.yml`"), `${label} change log missing evidence preservation`);
  assert(changeLog.includes("Did not edit `students/statement-fixture/statement-brief.md`"), `${label} change log missing brief preservation`);
  assert(evidenceMap.review_status === REVIEW_STATUS, `${label} evidence map missing review status`);
  assert(evidenceMap.word_count === result.wordCount, `${label} word count mismatch`);
  assert(evidenceMap.estimated_pages === estimateStatementPages(result.wordCount), `${label} page estimate mismatch`);
  validateEvidenceMap(evidenceMap, draft);
  validateReportAndTrackerLinks(result);
}

function validatePersonalStatementDryRun() {
  const root = path.join(validationRoot, "personal-source");
  setupSourceWorkspace(root, "personal_statement");
  const result = runLiveStatement({
    program: programId,
    workspace: root,
    student: studentId,
    dryRunRoot: path.join(validationRoot, "dry-run-ps", programId),
  });
  assert(result.statementType === "personal_statement", "PS dry-run rendered wrong statement type");
  validateStatementResult(result, "personal-statement dry-run");
}

function validateWriteMode(evaluation) {
  const root = path.join(validationRoot, "write-source");
  setupSourceWorkspace(root, "statement_of_purpose");
  const evalRel = `students/${studentId}/evaluations/${programId}.yml`;
  const evalPath = path.join(root, evalRel);
  const beforeEvalText = fs.readFileSync(evalPath, "utf8");
  const before = hashFiles(root, sourceFiles);
  const result = runLiveStatement({ program: programId, workspace: root, student: studentId, write: true });
  validateStatementResult(result, "write");
  for (const file of [
    `students/${studentId}/evidence.yml`,
    `students/${studentId}/master-cv.md`,
    `students/${studentId}/statement-brief.md`,
  ]) {
    assert(hashFile(path.join(root, file)) === before[file], `Write mutated protected source file: ${file}`);
  }
  // The approved write persists only the derived `statement:` status line back
  // into the evaluation; every other line stays byte-identical.
  const afterEvalText = fs.readFileSync(evalPath, "utf8");
  const normalizeStatementLine = (text) => text.replace(/^statement:.*$/m, "statement: <STATUS>");
  assert(
    normalizeStatementLine(beforeEvalText) === normalizeStatementLine(afterEvalText),
    "Write changed the evaluation beyond the statement status line"
  );
  assert(
    /^statement: ".*statement-draft\.md.*Review Required.*"$/m.test(afterEvalText),
    "Write did not persist the statement draft link into the evaluation statement field"
  );
  assert(hashFile(path.join(root, `students/${studentId}/reports/${reportFileName(evaluation)}`)) !== before[`students/${studentId}/reports/${reportFileName(evaluation)}`], "Write did not refresh report statement link");
  assert(hashFile(path.join(root, `students/${studentId}/tracker.md`)) !== before[`students/${studentId}/tracker.md`], "Write did not refresh tracker statement link");
  const outputDir = path.join(root, "students", studentId, "output", programId);
  assert(fs.existsSync(path.join(outputDir, "statement-draft.md")), "Write missing statement draft");
  assert(!fs.existsSync(path.join(outputDir, "academic-cv.html")), "Statement write created unrelated CV artifact");
}

function validateFailures() {
  assertRunFails("missing-brief", (root) => {
    setupSourceWorkspace(root, "statement_of_purpose");
    fs.unlinkSync(path.join(root, "students", studentId, "statement-brief.md"));
  }, /Missing required file/, "Missing statement brief should fail");

  assertRunFails("missing-plan", (root) => {
    const evaluation = withStatementPlan(readYaml(path.join(repoRoot, "examples", "fictional-programs", "northbridge-evaluation.yml")), "statement_of_purpose");
    delete evaluation.statement_plan;
    setupCustomEvaluation(root, evaluation);
  }, /missing statement_plan/, "Missing statement plan should fail");

  assertRunFails("missing-draft", (root) => {
    setupSourceWorkspace(root, "statement_of_purpose", { statement_plan: { draft_markdown: "" } });
  }, /missing statement_plan\.draft_markdown/, "Missing LLM-authored draft should fail");

  assertRunFails("missing-claim-map", (root) => {
    setupSourceWorkspace(root, "statement_of_purpose", { statement_plan: { claim_map: [] } });
  }, /missing statement_plan\.claim_map/, "Missing claim map should fail");

  assertRunFails("draft-artifact-path", (root) => {
    setupSourceWorkspace(root, "statement_of_purpose", { statement_plan: { draft_artifact: "../../outside.md" } });
  }, /draft_artifact path inputs are unsupported/, "Draft artifact path input should fail");

  assertRunFails("unsupported-plan", (root) => {
    setupSourceWorkspace(root, "statement_of_purpose", { statement_plan: { statement_type: "diversity_essay" } });
  }, /unsupported statement_type/, "Unsupported statement type should fail");

  assertRunFails("missing-review-status", (root) => {
    setupSourceWorkspace(root, "statement_of_purpose", { statement_plan: { review_status: "Ready" } });
  }, /review_status must be Review Required/, "Missing Review Required status should fail");

  assertRunFails("thin-plan", (root) => {
    setupSourceWorkspace(root, "statement_of_purpose", { statement_plan: { strategy_summary: "Use a statement.", core_argument: "Too short." } });
  }, /strategy_summary must be at least/, "Thin statement plan should fail");

  assertRunFails("generic-plan", (root) => {
    setupSourceWorkspace(root, "statement_of_purpose", {
      statement_plan: {
        strategy_summary: "This statement should explain preparation, interests, goals, and fit in a careful and truthful way with selected examples from the file.",
      },
    });
  }, /program-specific/, "Generic statement plan should fail");

  assertRunFails("conflict-plan", (root) => {
    setupSourceWorkspace(root, "statement_of_purpose", {
      document_instructions: { text: "Upload a personal statement about background." },
    });
  }, /conflicts with official instructions/, "SOP/PS conflict should fail");

  assertRunFails("ambiguous-plan", (root) => {
    setupSourceWorkspace(root, "statement_of_purpose", {
      document_instructions: { text: "Upload a statement of purpose and a personal statement." },
    });
  }, /ambiguous official statement instructions/, "Ambiguous instructions should fail");

  assertRunFails("bad-evidence", (root) => {
    setupSourceWorkspace(root, "statement_of_purpose", {
      statement_plan: {
        paragraph_plan: [
          { purpose: "Academic preparation", evidence_ids: ["missing-evidence"], program_sources: [], brief_inputs: ["Why graduate study now"] },
          { purpose: "Program-specific fit", evidence_ids: ["project-rubric-eval-dashboard"], program_sources: ["https://example.edu/graduate/artificial-intelligence"], brief_inputs: ["Program-Specific Notes"] },
          { purpose: "Future purpose", evidence_ids: ["presentation-feedback-interfaces"], program_sources: ["https://example.edu/graduate/artificial-intelligence"], brief_inputs: ["Long-term goal"] },
        ],
      },
    });
  }, /unsupported evidence ID/, "Unsupported evidence ID should fail");

  assertRunFails("bad-claim-evidence", (root) => {
    setupSourceWorkspace(root, "statement_of_purpose", {
      statement_plan: {
        claim_map: [{ ...claimMap("statement_of_purpose")[0], evidence_id: "missing-evidence" }],
      },
    });
  }, /unsupported evidence ID in statement claim_map/, "Unsupported claim-map evidence ID should fail");

  assertRunFails("unsupported-claim-source", (root) => {
    setupSourceWorkspace(root, "statement_of_purpose", {
      statement_plan: {
        claim_map: [{ ...claimMap("statement_of_purpose")[0], source_type: "memory" }],
      },
    });
  }, /unsupported statement claim source_type/, "Unsupported claim source type should fail");

  assertRunFails("unknown-official-source", (root) => {
    setupSourceWorkspace(root, "statement_of_purpose", {
      statement_plan: {
        claim_map: [{ ...claimMap("statement_of_purpose")[4], source_url: "https://unofficial.example.com/program" }],
      },
    });
  }, /references unknown source_url/, "Unknown official source URL should fail");

  assertRunFails("non-url-official-source", (root) => {
    setupSourceWorkspace(root, "statement_of_purpose", {
      statement_plan: {
        claim_map: [{ ...claimMap("statement_of_purpose")[4], source_url: "pending official source" }],
      },
    });
  }, /requires an official source_url/, "Non-URL official source should fail");

  assertRunFails("unknown-brief-section", (root) => {
    setupSourceWorkspace(root, "statement_of_purpose", {
      statement_plan: {
        claim_map: [{ ...claimMap("statement_of_purpose")[5], brief_section: "Invented Background" }],
      },
    });
  }, /unknown brief_section/, "Unknown brief section should fail");

  assertRunFails("protected-fact-mismatch", (root) => {
    setupSourceWorkspace(root, "statement_of_purpose", {
      statement_plan: {
        draft_markdown: agentDraftMarkdown("statement_of_purpose").replace("BSc Computer Science", "Bachelor of Computing"),
      },
    });
  }, /protected fact mismatch/, "Protected fact mismatch should fail");

  assertRunFails("unsafe-readiness", (root) => {
    setupSourceWorkspace(root, "statement_of_purpose", {
      statement_plan: {
        draft_markdown: `${agentDraftMarkdown("statement_of_purpose")}\n\nThis draft is ready for submission.`,
      },
    });
  }, /claims final, ready, submitted, or externally safe status/, "Unsafe readiness language should fail");

  assertRunFails("cjk-draft", (root) => {
    setupSourceWorkspace(root, "statement_of_purpose", {
      statement_plan: {
        draft_markdown: "\u6211\u7684\u7814\u7a76\u65b9\u5411\u662f\u8ba1\u7b97\u795e\u7ecf\u79d1\u5b66\u3002\n\n" + agentDraftMarkdown("statement_of_purpose"),
      },
    });
  }, /statement_plan\.draft_markdown contains Han .* characters/, "A CJK statement draft should be refused, not counted");

  assertRunFails("legacy-renderer-phrase", (root) => {
    setupSourceWorkspace(root, "statement_of_purpose", {
      statement_plan: {
        draft_markdown: `${agentDraftMarkdown("statement_of_purpose")}\n\nA central part of my preparation is this theme.`,
      },
    });
  }, /retired deterministic renderer phrase/, "Legacy deterministic renderer phrase should fail");

  assertRunFails("word-overflow", (root) => {
    setupSourceWorkspace(root, "statement_of_purpose", { statement_plan: { word_limit: 30 } });
  }, /exceeds word_limit/, "Word-limit overflow should fail");

  assertRunFails("raw-record", (root) => {
    setupCustomEvaluation(root, {
      id: programId,
      report_number: 1,
      institution: "Raw University",
      program: "Raw Program",
      degree_type: "MSc",
      intake: "Fall 2027",
      retrieved_at: "2026-06-18",
      document_instructions: { text: "Upload a statement of purpose." },
      statement_plan: withStatementPlan(readYaml(path.join(repoRoot, "examples", "fictional-programs", "northbridge-evaluation.yml")), "statement_of_purpose").statement_plan,
    });
  }, /raw or incomplete evaluation record/, "Raw or incomplete record should fail");

  const catalogRoot = path.join(validationRoot, "catalog-only");
  fs.mkdirSync(path.join(catalogRoot, "programs", "catalog"), { recursive: true });
  writeYaml(path.join(catalogRoot, "programs", "catalog", `${programId}.yml`), { id: programId, official_url: "https://example.edu" });
  writeText(path.join(catalogRoot, "students", studentId, "evidence.yml"), yaml.dump(readYaml(path.join(repoRoot, "examples", "fictional-student", "evidence.yml"))));
  writeText(path.join(catalogRoot, "students", studentId, "master-cv.md"), "CV");
  writeText(path.join(catalogRoot, "students", studentId, "statement-brief.md"), statementBrief());
  writeText(path.join(catalogRoot, "students", studentId, "tracker.md"), "# Programs Tracker\n");
  let catalogFailed = false;
  try {
    runLiveStatement({ program: programId, workspace: catalogRoot, student: studentId, dryRunRoot: path.join(validationRoot, "catalog-dry-run") });
  } catch (error) {
    catalogFailed = /catalog-only program/.test(error.message);
  }
  assert(catalogFailed, "Catalog-only statement input should fail");
}

function assertRunFails(name, setup, pattern, message) {
  const root = path.join(validationRoot, name);
  setup(root);
  let failed = false;
  try {
    runLiveStatement({ program: programId, workspace: root, student: studentId, dryRunRoot: path.join(validationRoot, `${name}-dry-run`) });
  } catch (error) {
    failed = pattern.test(error.message);
  }
  assert(failed, message);
  assert(!fs.existsSync(path.join(validationRoot, `${name}-dry-run`, "output", programId)), `${name} failure generated output`);
}

function setupCustomEvaluation(root, evaluation) {
  const targetStudentRoot = path.join(root, "students", studentId);
  copyFile("examples/fictional-student/evidence.yml", path.join(targetStudentRoot, "evidence.yml"));
  copyFile("examples/fictional-student/master-cv.md", path.join(targetStudentRoot, "master-cv.md"));
  writeText(path.join(targetStudentRoot, "statement-brief.md"), statementBrief());
  writeYaml(path.join(targetStudentRoot, "evaluations", `${programId}.yml`), evaluation);
  const reportName = reportFileName(evaluation);
  writeText(path.join(targetStudentRoot, "reports", reportName), "# Raw\n\n**Tailored CV:** pending\n\n## H. Remaining application package and action plan\n\n## I. Questions for the university or potential supervisor\n");
  writeText(path.join(targetStudentRoot, "tracker.md"), renderTracker("# Programs Tracker\n\n", [{
    "#": "001",
    Institution: evaluation.institution,
    Program: evaluation.program,
    Degree: evaluation.degree_type,
    Intake: evaluation.intake,
    Deadline: "unknown",
    Eligibility: "unknown",
    Fit: "unknown",
    Status: "Evaluated",
    CV: "pending",
    Statement: "pending",
    Report: `[001](${path.posix.join("reports", reportName)})`,
    "Next Action": "Review",
    Notes: "Raw fixture",
  }]));
}

function validateEvidenceMap(evidenceMap, draft) {
  const evidence = readYaml(path.join(repoRoot, "examples", "fictional-student", "evidence.yml"));
  const allowed = new Set(flattenEvidence(evidence).map((entry) => entry.id));
  assert(evidenceMap.generated_claims.length > 0, "Evidence map missing claims");
  for (const claim of evidenceMap.generated_claims) {
    if (claim.source_type === "evidence") {
      assert(allowed.has(claim.evidence_id), `Unsupported evidence ID in map: ${claim.evidence_id}`);
      for (const fact of claim.protected_facts || []) {
        assert(draft.includes(fact), `Protected fact not preserved in packaged draft: ${fact}`);
      }
    } else if (claim.source_type === "official_program_source") {
      assert(/^https:\/\//.test(claim.source_url), `Program source must be URL: ${claim.source_url}`);
    } else if (claim.source_type === "student_brief") {
      assert(claim.brief_section, "Brief claim missing section");
    } else {
      throw new Error(`Unsupported statement claim source type: ${claim.source_type}`);
    }
  }
}

function validateReportAndTrackerLinks(result) {
  const report = fs.readFileSync(result.reportPath, "utf8");
  const tracker = fs.readFileSync(result.trackerPath, "utf8");
  const parsed = parseTracker(tracker);
  assert(report.includes(`**Statement:** ${result.links.statement_draft} (${REVIEW_STATUS})`), "Report header missing statement link");
  assert(report.includes("Statement output links:"), "Report missing statement output block");
  assert(parsed.rows[0].Statement.includes(REVIEW_STATUS), "Tracker Statement column missing Review Required");
  for (const link of Object.values(result.links)) {
    assert(report.includes(link), `Report missing statement link: ${link}`);
    assert(resolveMarkdownLink(result.reportPath, link, result.outputRoot), `Report link does not resolve: ${link}`);
  }
  assert(resolveMarkdownLink(result.trackerPath, parsed.rows[0].Statement, result.outputRoot), "Tracker statement link does not resolve");
}

function validateLegacyTrackerParse() {
  const legacy = `# Programs Tracker

| # | Institution | Program | Degree | Intake | Deadline | Eligibility | Fit | Status | CV | Report | Next Action | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | A | B | MSc | Fall 2027 | unknown | likely | 4/5 | Evaluated | pending | [001](reports/001.md) | Next | Note |
`;
  const parsed = parseTracker(legacy);
  assert(parsed.rows.length === 1 && parsed.rows[0].Statement === "pending", "Legacy tracker should normalize missing Statement column");
}

function statementBrief() {
  return `# Statement Brief

## General Direction
- Target field: human-centered AI
- Long-term goal: build reliable AI evaluation tools
- Why graduate study now: deepen research preparation after the current degree
- Preferred tone: direct and evidence-grounded

## Must Include
- Connect AI evaluation work to graduate study.

## Avoid
- Do not claim publications that are not listed.

## Program-Specific Notes
- Emphasize Northbridge AI evaluation and HCI-adjacent coursework.

## Personal Background Allowed For Use
- It is acceptable to mention interest in human-facing AI systems.

## Questions Or Concerns
- Confirm the exact portal prompt before final submission.
`;
}

function copyFile(relativeSource, target) {
  const source = path.join(repoRoot, relativeSource);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function readYaml(file) {
  return yaml.load(fs.readFileSync(file, "utf8"));
}

function writeYaml(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, yaml.dump(value, { lineWidth: 100 }));
}

function writeText(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

function hashFiles(root, files) {
  return Object.fromEntries(files.map((file) => [file, hashFile(path.join(root, file))]));
}

function assertHashes(root, files, expected, message) {
  for (const file of files) {
    assert(hashFile(path.join(root, file)) === expected[file], `${message}: ${file}`);
  }
}

function hashFile(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function resolveMarkdownLink(baseFile, markdownLink, rootDir) {
  const match = markdownLink.match(/\]\(([^)]+)\)/);
  if (!match) return false;
  const resolved = path.resolve(path.dirname(baseFile), match[1]);
  return resolved.startsWith(path.resolve(rootDir)) && fs.existsSync(resolved);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

if (require.main === module) {
  main();
}

// Exported so the consistency validator can reuse this proven fixture builder
// (a complete student workspace with an evaluation that carries both a
// cv_adaptation_plan and a valid statement_plan) instead of duplicating it.
module.exports = {
  setupSourceWorkspace,
  STATEMENT_FIXTURE_STUDENT: studentId,
  STATEMENT_FIXTURE_PROGRAM: programId,
};
