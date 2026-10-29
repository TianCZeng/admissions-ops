const fs = require("fs");
const path = require("path");
const { emptyTracker } = require("../lib/program-writer");
const { REPO_ROOT, STUDENT_INPUT_EXAMPLES, resolveWorkspace } = require("../lib/workspace");

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = runInit(options);
    console.log(nextSteps(result));
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

// Writes the inputs of a new workspace and nothing else: evaluations, reports,
// checklists, and output belong to the program pipeline. Every target is checked
// before the first write, so a refusal leaves the workspace exactly as it was.
// An existing workspace directory is accepted, because the user may have put a
// CV or transcript in raw/ first.
function runInit(options) {
  const workspace = resolveWorkspace(options);
  const files = {};
  for (const [name, example] of Object.entries(STUDENT_INPUT_EXAMPLES)) {
    files[name] = fs.readFileSync(path.join(REPO_ROOT, example), "utf8");
  }
  files["tracker.md"] = emptyTracker();

  const existing = Object.keys(files).filter((name) => fs.existsSync(path.join(workspace.root, name)));
  if (existing.length) {
    throw new Error(
      `Refusing to overwrite existing ${existing.join(", ")} in ${display(workspace.root)}/; ` +
        "init only creates a new workspace and never replaces a student's files"
    );
  }

  fs.mkdirSync(workspace.root, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(workspace.root, name), text, { flag: "wx" });
  }
  return {
    studentId: workspace.studentId,
    root: workspace.root,
    created: Object.keys(files).map((name) => path.join(workspace.root, name)),
  };
}

function nextSteps(result) {
  const id = result.studentId;
  const root = display(result.root);
  return `Created ${root}/ from the shipped examples:
${result.created.map((file) => `  ${display(file)}`).join("\n")}

The first four still hold example content. Replace it with the student's own,
or let the agent do it from a CV or transcript placed in ${root}/raw/:

  $admissions-ops setup for student ${id}

Then confirm the inputs:

  npm run check -- --student ${id}

Then evaluate one program:

  $admissions-ops program for student ${id}:
  <official university or department program URL>

  Run the full one-program admissions pipeline for the intended intake <term/year>.`;
}

function display(file) {
  return path.relative(process.cwd(), file).split(path.sep).join("/") || ".";
}

function printHelp() {
  console.log(`Usage: npm run init -- --student <student-id> [--workspace <path>]

Creates students/<student-id>/ with copies of the example profile, preferences,
evidence, and master CV, plus an empty tracker. Refuses to overwrite any
existing file and writes no evaluations, reports, checklists, or output.
An existing students/<student-id>/raw/ is left as it is.`);
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  runInit,
};
