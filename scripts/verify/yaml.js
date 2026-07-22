const fs = require("fs");
const yaml = require("js-yaml");

const files = [
  "students/profile.example.yml",
  "students/preferences.example.yml",
  "students/evidence.example.yml",
  "programs/inbox.example.yml",
  "templates/states.yml",
  "examples/fictional-student/profile.yml",
  "examples/fictional-student/preferences.yml",
  "examples/fictional-student/evidence.yml",
  "examples/fictional-programs/inbox.yml",
  "examples/fictional-programs/northbridge-evaluation.yml",
  "examples/fictional-programs/lakeside-evaluation.yml",
  "examples/stress-benchmark/students.yml",
  "examples/stress-benchmark/programs.yml",
];

for (const file of files) {
  yaml.load(fs.readFileSync(file, "utf8"));
}

console.log(`YAML fixtures parse (${files.length} files)`);
