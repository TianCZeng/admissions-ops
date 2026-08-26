// Language guards for the English-artifact rule.
//
// See `AGENTS.md` -> Language and `modes/_shared.md` -> Output Language:
// conversation follows the user, but every generated artifact and every stored
// student record is English. "English" here means *script, not ASCII* --
// `Saarbrücken`, `Kovač`, and `naïve` are valid English-document content and
// must keep working end to end. These helpers reject CJK/Kana/Hangul only.

// A Unicode word token: a run of letters/digits/underscore that may contain
// internal apostrophes or hyphens.
//
// `\w` and `\b` are ASCII-only in JavaScript even under the `u` flag, so the
// previous `/\b[\w'-]+\b/g` counted `Saarbrücken` as two words (inflating the
// count against `word_limit`) and a CJK draft as zero (passing any limit
// silently). This token class is equivalent to that regex for ASCII input --
// `state-of-the-art`, `don't`, `U.S.`, and `a--b` all count the same.
const WORD_TOKEN = /[\p{L}\p{N}_]['\-\p{L}\p{N}_]*[\p{L}\p{N}_]|[\p{L}\p{N}_]/gu;

// Scripts that may never appear in a generated document or a stored record
// field that reaches one. Deliberately script-based: the templates ship
// `font-family: Arial, sans-serif` with no CJK stack, so these characters
// cannot render at all.
const NON_ENGLISH_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

const SCRIPT_LABELS = [
  ["Han (Chinese/Japanese)", /\p{Script=Han}/u],
  ["Hiragana (Japanese)", /\p{Script=Hiragana}/u],
  ["Katakana (Japanese)", /\p{Script=Katakana}/u],
  ["Hangul (Korean)", /\p{Script=Hangul}/u],
];

const NON_ENGLISH_SCRIPT_HINT =
  "generated documents and stored records are English (script, not ASCII, so accented Latin is fine); " +
  "agree the English wording in chat and store that, keeping any original in a field the renderer " +
  "never reads such as original_title";

function countWords(value) {
  const words = String(value || "").match(WORD_TOKEN);
  return words ? words.length : 0;
}

// Returns { script, sample } for the first blocked character, or null.
function findNonEnglishScript(value) {
  if (typeof value !== "string") return null;
  const match = NON_ENGLISH_SCRIPT.exec(value);
  if (!match) return null;
  const label = SCRIPT_LABELS.find(([, pattern]) => pattern.test(match[0]));
  return {
    script: label ? label[0] : "non-English script",
    sample: sampleAround(value, match.index),
  };
}

// Recursive walk over strings, arrays, and plain objects. Returns
// { path, script, sample } for the first blocked character, or null. The path
// is dotted so the failure message names the offending field.
function findNonEnglishScriptDeep(value, basePath = "") {
  if (typeof value === "string") {
    const hit = findNonEnglishScript(value);
    return hit ? { path: basePath, ...hit } : null;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const hit = findNonEnglishScriptDeep(value[index], `${basePath}[${index}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      const hit = findNonEnglishScriptDeep(entry, basePath ? `${basePath}.${key}` : key);
      if (hit) return hit;
    }
    return null;
  }
  return null;
}

// One shared reason string so the CV and statement preflights fail identically.
function nonEnglishScriptReason(hit) {
  return `${hit.path || "value"} contains ${hit.script} characters ("${hit.sample}"); ${NON_ENGLISH_SCRIPT_HINT}`;
}

function sampleAround(value, index) {
  const start = Math.max(0, index - 12);
  const excerpt = value.slice(start, start + 32).replace(/\s+/g, " ").trim();
  return excerpt;
}

module.exports = {
  NON_ENGLISH_SCRIPT_HINT,
  countWords,
  findNonEnglishScript,
  findNonEnglishScriptDeep,
  nonEnglishScriptReason,
};
