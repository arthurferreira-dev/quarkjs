#!/usr/bin/env node

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  existsSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  compileProject,
  missingDependencies,
  dependencyMessage,
} from "./jtx.mjs";

async function askExt() {
  const fallback = existsSync("tsconfig.json") ? "tsx" : "jsx";
  if (!process.stdin.isTTY) return fallback;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const answer = (
        await rl.question(`Generate .jsx or .tsx files? [${fallback}] `)
      )
        .trim()
        .toLowerCase()
        .replace(/^\./, "");
      if (answer === "") return fallback;
      if (answer === "jsx" || answer === "tsx") return answer;
      console.log("Type jsx or tsx (or press Enter to accept the suggestion).");
    }
  } finally {
    rl.close();
  }
}

const EXT = "." + (await askExt());

function findJtx(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) found.push(...findJtx(full));
    else if (name.endsWith(".jtx")) found.push(full);
  }
  return found;
}

const entries = findJtx(".").map((file) => ({
  file: file.split(sep).join("/"),
  source: readFileSync(file, "utf8"),
}));

let result;
try {
  result = compileProject(entries, { ext: EXT.slice(1) });
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}
const { files, warnings, dependencies } = result;

for (const f of files) {
  const outDir = resolve(dirname(f.path));
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(f.path, f.code);
  console.log(`${f.from} -> ${f.path}`);
}
for (const w of warnings) console.warn(`warning: ${w}`);

const missing = missingDependencies(dependencies, ".");
if (missing.length) console.log(`\n${dependencyMessage(missing)}`);