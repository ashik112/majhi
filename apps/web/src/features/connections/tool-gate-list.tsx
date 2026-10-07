import type { ToolGate } from "@majhi/shared";

const GROUPS: readonly { gate: ToolGate["gate"]; title: string; says: string }[] = [
  { gate: "read", title: "Only read", says: "Run without asking." },
  { gate: "ask", title: "Change something", says: "Ask you first." },
  { gate: "destructive", title: "Destructive", says: "Always ask, even if you allow the others." },
  { gate: "allowed", title: "Allowed changes", says: "Run without asking, because you allowed them." },
];

/** What the gate does for each tool the server listed, from its last Test. */
export function ToolGateList({ tools }: { tools: readonly ToolGate[] }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {GROUPS.map((group) => {
        const rows = tools.filter((t) => t.gate === group.gate);
        if (rows.length === 0) return null;
        return (
          <div key={group.gate} className="flex min-w-0 flex-col gap-1">
            <p className="m-0 text-base text-fg">
              <span className="font-medium">{group.title}</span>
              <span className="text-fg-muted">. {group.says}</span>
            </p>
            <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
              {rows.map((t) => (
                <li
                  key={t.tool}
                  title={t.why}
                  className="rounded-md border border-line-strong bg-sunken px-2 py-0.5 font-mono text-sm text-fg-soft"
                >
                  {t.tool}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
