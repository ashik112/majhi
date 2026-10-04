/**
 * robots.txt, read the way RFC 9309 asks. A feed is fetched only when its host's robots.txt does not
 * disallow the path for majhi. The group for the most specific matching agent wins (majhi, else `*`);
 * inside a group the longest matching rule wins and an allow beats a disallow of equal length.
 */

export const ROBOTS_AGENT = "majhi-sensors";

interface Rule {
  allow: boolean;
  path: string;
}

interface Group {
  agents: string[];
  rules: Rule[];
}

function groupsOf(text: string): Group[] {
  const groups: Group[] = [];
  let current: Group | undefined;
  let collecting = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (!collecting || current === undefined) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      collecting = true;
    } else if (key === "allow" || key === "disallow") {
      collecting = false;
      current?.rules.push({ allow: key === "allow", path: value });
    } else {
      collecting = false;
    }
  }
  return groups;
}

/** Whether a rule path (with * and a trailing $) matches the start of a request path. */
function matches(rule: string, path: string): boolean {
  if (rule === "") return false;
  const anchored = rule.endsWith("$");
  const body = anchored ? rule.slice(0, -1) : rule;
  const re = new RegExp(
    `^${body
      .split("*")
      .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}${anchored ? "$" : ""}`,
  );
  return re.test(path);
}

/** May `agent` fetch `path` (with its query) under this robots.txt? An empty file allows everything. */
export function robotsAllows(text: string, path: string, agent: string = ROBOTS_AGENT): boolean {
  const groups = groupsOf(text);
  const name = agent.toLowerCase();
  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && name.includes(a)));
  const chosen = specific.length > 0 ? specific : groups.filter((g) => g.agents.includes("*"));
  let best: { len: number; allow: boolean } | undefined;
  for (const g of chosen) {
    for (const r of g.rules) {
      if (!matches(r.path, path)) continue;
      const len = r.path.length;
      if (best === undefined || len > best.len || (len === best.len && r.allow)) {
        best = { len, allow: r.allow };
      }
    }
  }
  return best === undefined ? true : best.allow;
}
