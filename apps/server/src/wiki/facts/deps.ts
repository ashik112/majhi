import { pythonName } from "./formats.ts";
import { lineContaining } from "./located.ts";
import type { Member } from "./read.ts";

/** One dependency of a member, with the line of its manifest that names it. */
export interface Dep {
  /** npm names as written, Python names normalized. */
  name: string;
  python: boolean;
  path: string;
  line: number;
  /** A development dependency: a build tool or a test library, not part of what runs. */
  dev: boolean;
}

const NPM_SECTIONS = [
  ["dependencies", false],
  ["optionalDependencies", false],
  ["peerDependencies", false],
  ["devDependencies", true],
] as const;

/** Every dependency the member's manifests name: `package.json`, `pyproject.toml` (PEP 621 and Poetry) and `requirements*.txt`. */
export function depsOf(member: Member): Dep[] {
  const out: Dep[] = [];
  const { pkg, py } = member;
  if (pkg !== undefined) {
    for (const [section, dev] of NPM_SECTIONS) {
      for (const name of Object.keys(pkg.data[section] ?? {})) {
        const line = pkg.located.lineOf([section, name]) ?? lineContaining(pkg.text, `"${name}"`) ?? 1;
        out.push({ name, python: false, path: pkg.path, line, dev });
      }
    }
  }
  if (py !== undefined) {
    for (const raw of py.data.project?.dependencies ?? []) {
      out.push({
        name: pythonName(raw),
        python: true,
        path: py.path,
        line: lineContaining(py.text, raw) ?? 1,
        dev: false,
      });
    }
    const poetry = Object.keys(py.data.tool?.poetry?.dependencies ?? {}).filter(
      (n) => n.toLowerCase() !== "python",
    );
    const section = lineContaining(py.text, "[tool.poetry.dependencies]") ?? 1;
    for (const key of poetry) {
      out.push({
        name: pythonName(key),
        python: true,
        path: py.path,
        line: lineContaining(py.text, key, section) ?? section,
        dev: false,
      });
    }
  }
  for (const r of member.requirements) {
    for (const item of r.items) {
      if (item.name !== "")
        out.push({ name: item.name, python: true, path: r.path, line: item.line, dev: false });
    }
  }
  return out.filter((d) => d.name !== "");
}
