#!/usr/bin/env node
// A stand-in for the Vercel `skills` CLI, so tests never download one or reach a git host.
// It checks that it is called the way majhi must call it, then does what `skills add` does:
// finds skills in the source and copies each to `.agents/skills/<name>` and `.claude/skills/<name>`
// of the working folder, with a `skills-lock.json` beside them.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CATALOG = {
  "acme/agent-skills": {
    "lint-fixes": "Fix lint errors the Acme way",
    "release-notes": "Write release notes from merged changes",
  },
};

function fail(message) {
  process.stderr.write(`fake skills: ${message}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args[0] !== "add") fail(`unexpected command ${args[0]}`);
const source = args[1];
const rest = args.slice(2);
for (const flag of ["-y", "--copy"]) if (!rest.includes(flag)) fail(`missing ${flag}`);
const agentAt = rest.indexOf("--agent");
if (agentAt < 0 || rest[agentAt + 1] !== "claude-code" || rest[agentAt + 2] !== "codex") {
  fail("missing --agent claude-code codex");
}
const only = rest.includes("--skill") ? rest[rest.indexOf("--skill") + 1] : undefined;
if (process.env.DISABLE_TELEMETRY !== "1") fail("telemetry is not off");
const home = process.env.HOME ?? "";
if (!home.startsWith(process.cwd())) fail(`HOME ${home} is not inside the working folder`);
for (const name of Object.keys(process.env)) {
  if (/TOKEN|SECRET|PASSWORD/i.test(name)) fail(`majhi's environment leaked ${name}`);
}

const found = []; // { name, from } or { name, text }
if (existsSync(source) && statSync(source).isDirectory()) {
  const roots = existsSync(join(source, "SKILL.md"))
    ? [source]
    : readdirSync(source)
        .map((n) => join(source, n))
        .filter((p) => statSync(p).isDirectory() && existsSync(join(p, "SKILL.md")));
  for (const dir of roots) {
    const text = readFileSync(join(dir, "SKILL.md"), "utf8");
    const name = /^name:\s*(\S+)/m.exec(text)?.[1] ?? dir.split("/").pop();
    found.push({ name, from: dir });
  }
} else if (CATALOG[source]) {
  for (const [name, description] of Object.entries(CATALOG[source])) {
    found.push({
      name,
      text: `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\nSteps for ${name}.\n`,
    });
  }
} else {
  fail(`could not clone ${source}`);
}

const chosen = found.filter((s) => only === undefined || s.name === only);
if (chosen.length === 0) fail(`no skill named ${only} in ${source}`);

const lock = { version: 1, skills: {} };
for (const skill of chosen) {
  for (const base of [".agents/skills", ".claude/skills"]) {
    const dest = join(process.cwd(), base, skill.name);
    mkdirSync(dest, { recursive: true });
    if (skill.from) cpSync(skill.from, dest, { recursive: true, dereference: true });
    else writeFileSync(join(dest, "SKILL.md"), skill.text);
  }
  lock.skills[skill.name] = skill.from
    ? { source: "./src", sourceType: "local", computedHash: "fake" }
    : {
        source,
        sourceType: "github",
        computedHash: "fake",
        commit: "0123456789abcdef0123456789abcdef01234567",
      };
}
writeFileSync(join(process.cwd(), "skills-lock.json"), JSON.stringify(lock, null, 2));
