import { parse } from "shell-quote";

// This is an allowlist for literal, read-only invocations, not a shell sandbox.
// Unknown commands, options, and syntax always retain model review.
type ReadCommand = { short: string; flags?: string[]; values?: string[]; numbers?: string[] };
const READ_COMMANDS: Record<string, ReadCommand> = {
  pwd: { short: "LP" },
  ls: { short: "aAbBcCdFfgGhHiIklLmnoOpqQrRsStTuUvwx1", flags: ["--all", "--almost-all", "--directory", "--human-readable", "--classify", "--recursive", "--reverse", "--size", "--inode", "--numeric-uid-gid"] },
  cat: { short: "AbenEstTuv", flags: ["--show-all", "--number", "--number-nonblank", "--squeeze-blank", "--show-ends", "--show-tabs", "--show-nonprinting"] },
  head: { short: "qv", numbers: ["-n", "-c", "--lines", "--bytes"], flags: ["--quiet", "--silent", "--verbose"] },
  tail: { short: "qv", numbers: ["-n", "-c", "--lines", "--bytes"], flags: ["--quiet", "--silent", "--verbose"] },
  wc: { short: "clmwL", flags: ["--bytes", "--chars", "--lines", "--words", "--max-line-length"] },
  grep: {
    short: "EFGivwxnHhlLcoqsrRaIUZz",
    flags: ["--extended-regexp", "--fixed-strings", "--basic-regexp", "--ignore-case", "--invert-match", "--word-regexp", "--line-regexp", "--line-number", "--with-filename", "--no-filename", "--files-with-matches", "--files-without-match", "--count", "--only-matching", "--quiet", "--silent", "--no-messages", "--recursive", "--text"],
    values: ["-e", "-f", "--regexp", "--file"],
    numbers: ["-A", "-B", "-C", "-m", "--after-context", "--before-context", "--context", "--max-count"],
  },
  rg: {
    short: "nNHIlLisSvwxaFcoqU",
    flags: ["--files", "--hidden", "--no-ignore", "--no-ignore-vcs", "--no-ignore-parent", "--no-config", "--fixed-strings", "--ignore-case", "--smart-case", "--case-sensitive", "--line-number", "--no-line-number", "--files-with-matches", "--files-without-match", "--count", "--count-matches", "--only-matching", "--word-regexp", "--line-regexp", "--text", "--quiet", "--json", "--stats", "--multiline"],
    values: ["-g", "-t", "-T", "-e", "-f", "--glob", "--iglob", "--type", "--type-not", "--regexp", "--file"],
    numbers: ["-A", "-B", "-C", "-m", "--after-context", "--before-context", "--context", "--max-count", "--max-depth"],
  },
};

function isReadCommand(words: string[]): boolean {
  // Only standard system paths may substitute for a bare command name.
  const name = words[0]?.replace(/^\/(?:usr\/)?bin\//, "");
  const rule = name && Object.hasOwn(READ_COMMANDS, name) ? READ_COMMANDS[name] : undefined;
  if (!rule || (name === "rg" && process.env.RIPGREP_CONFIG_PATH)) return false;
  let optionsEnded = false;
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (optionsEnded || word === "-" || !word.startsWith("-")) continue;
    if (word === "--") { optionsEnded = true; continue; }
    if (rule.flags?.includes(word)) continue;
    const longEquals = word.startsWith("--") ? word.indexOf("=") : -1;
    const option = longEquals >= 0 ? word.slice(0, longEquals)
      : word.startsWith("--") ? word : word.slice(0, 2);
    if (rule.values?.includes(option) || rule.numbers?.includes(option)) {
      const value = longEquals >= 0 ? word.slice(longEquals + 1)
        : !word.startsWith("--") && word.length > 2 ? word.slice(2) : words[++i];
      if (value === undefined || (rule.numbers?.includes(option) && !/^\d+$/.test(value))) return false;
      continue;
    }
    if (word.startsWith("--") || ![...word.slice(1)].every((flag) => rule.short.includes(flag))) return false;
  }
  return true;
}

export function isSafeBashCommand(command: string): boolean {
  // shell-quote is a tokenizer, not a full Bash parser. Restrict its input first:
  // no expansions, escapes, line breaks, control characters, or unmatched quotes.
  // Even quoted forms of these unsupported constructs retain review.
  if (!command || /[$`\\\x00-\x08\x0a-\x1f\x7f]/u.test(command) || /[^\S \t]/u.test(command)) return false;
  if (!/^(?:[^'"]|'[^']*'|"[^"]*")*$/.test(command)) return false;
  const unquoted = command.replace(/'[^']*'|"[^"]*"/g, "");
  if (/[~*?\[\]{}#]/.test(unquoted)) return false;
  try {
    const tokens = parse(command);
    let words: string[] = [];
    for (const token of tokens) {
      if (typeof token === "string") { words.push(token); continue; }
      if (!("op" in token) || !["|", "&&", "||", ";"].includes(token.op) || !isReadCommand(words)) return false;
      words = [];
    }
    return isReadCommand(words);
  } catch { return false; }
}
