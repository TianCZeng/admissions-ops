const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const { RENDERED_EVIDENCE_FIELDS, RENDERED_PROFILE_FIELDS } = require("../lib/cv-writer");
const { findNonEnglishScriptDeep, nonEnglishScriptReason } = require("../lib/language");
const { REPO_ROOT, STUDENT_INPUT_EXAMPLES, resolveWorkspace } = require("../lib/workspace");

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = runCheck(options);
    const root = path.relative(process.cwd(), result.root).split(path.sep).join("/") || ".";
    if (result.problems.length === 0) {
      console.log(`Check passed for ${root}/: ${Object.keys(STUDENT_INPUT_EXAMPLES).join(", ")}`);
      return;
    }
    console.error(`Check failed for ${root}/ (${result.problems.length} problem(s)):`);
    for (const problem of result.problems) console.error(`- ${problem}`);
    process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--student") {
      options.student = requireValue(args, ++index, arg);
    } else if (arg === "--workspace") {
      options.workspace = requireValue(args, ++index, arg);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
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

// Read-only. It adds no schema for profile, preferences, or evidence: it checks
// only what a later run cannot recover from quietly -- a missing or unparseable
// input, an example that was never replaced, an evidence entry a plan cannot
// name, and CJK script in a field a CV puts on the page. Each problem names the
// file and the entry; the fix belongs to the user or the agent, never to this.
function runCheck(options) {
  const workspace = resolveWorkspace(options);
  const problems = [];
  const parsed = {};

  for (const [name, example] of Object.entries(STUDENT_INPUT_EXAMPLES)) {
    const file = path.join(workspace.root, name);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      problems.push(`${name}: missing`);
      continue;
    }
    const text = fs.readFileSync(file, "utf8");
    // The examples open with a line no real file needs (`# Example only. ...`,
    // `# Example Student`), so a file still opening with it was copied and not
    // finished. This is what keeps example content out of a real application.
    const exampleHeader = firstLine(fs.readFileSync(path.join(REPO_ROOT, example), "utf8"));
    if (firstLine(text) === exampleHeader) {
      problems.push(
        `${name}: still begins with the example line "${exampleHeader}"; replace the example content, that line included, with the student's own`
      );
    }
    if (name.endsWith(".md")) {
      if (!text.trim()) problems.push(`${name}: empty`);
      continue;
    }
    let data;
    try {
      data = yaml.load(text);
    } catch (error) {
      problems.push(`${name}: does not parse as YAML: ${error.reason || error.message}`);
      continue;
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      problems.push(`${name}: must be a YAML mapping`);
      continue;
    }
    parsed[name] = data;
  }

  if (parsed["evidence.yml"]) checkEvidence(parsed["evidence.yml"], problems);
  if (parsed["profile.yml"]) checkProfile(parsed["profile.yml"], problems);
  return { studentId: workspace.studentId, root: workspace.root, problems };
}

// Plans select evidence by id, so an entry without one cannot be rendered and a
// repeated id would let a plan name two entries at once.
function checkEvidence(evidence, problems) {
  const seen = new Map();
  for (const [category, entries] of Object.entries(evidence)) {
    if (!Array.isArray(entries)) continue;
    entries.forEach((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        problems.push(`evidence.yml: ${category}[${index}] is not a mapping`);
        return;
      }
      const id = typeof entry.id === "string" ? entry.id.trim() : "";
      if (!id) {
        problems.push(`evidence.yml: ${category}[${index}] has no id`);
      } else if (seen.has(id)) {
        problems.push(`evidence.yml: ${category}[${index}] repeats id "${id}" already used in ${seen.get(id)}; ids must be unique across categories`);
      } else {
        seen.set(id, category);
      }
      for (const field of RENDERED_EVIDENCE_FIELDS[category] || []) {
        const hit = findNonEnglishScriptDeep(entry[field], `evidence.${category}[${id || index}].${field}`);
        if (hit) problems.push(`evidence.yml: ${nonEnglishScriptReason(hit)}`);
      }
    });
  }
}

function checkProfile(profile, problems) {
  const student = profile.student && typeof profile.student === "object" ? profile.student : {};
  for (const field of RENDERED_PROFILE_FIELDS) {
    const hit = findNonEnglishScriptDeep(student[field], `profile.student.${field}`);
    if (hit) problems.push(`profile.yml: ${nonEnglishScriptReason(hit)}`);
  }
}

function firstLine(text) {
  return text.split(/\r?\n/, 1)[0].trimEnd();
}

function printHelp() {
  console.log(`Usage: npm run check -- --student <student-id> [--workspace <path>]

Read-only check of students/<student-id>/profile.yml, preferences.yml,
evidence.yml, and master-cv.md: each exists and parses, none still opens with
its example's first line, every evidence entry has a unique id, and no field a
CV renders contains Chinese, Japanese, or Korean script. Exits 1 and names the
file and entry for every problem; it never rewrites anything.`);
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  runCheck,
};
