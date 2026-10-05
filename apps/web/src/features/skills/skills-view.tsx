import { PAGE_PATH } from "@majhi/shared";
import { useNavigate } from "@tanstack/react-router";
import { Plug, Plus, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { PageHeader } from "@/components/ui/page-header";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { useConnectStatus } from "@/lib/connect-queries";
import { useConnectionCommand, useConnections } from "@/lib/connection-queries";
import { describeError } from "@/lib/errors";
import { GLASS } from "@/lib/glass";
import { useSkills, useSkillsCommand } from "@/lib/skills-queries";
import { useAgents, useOrgs } from "@/lib/studio-queries";
import { useSearchParam } from "@/pages/parts/url-state";
import { AddDialog } from "./add-dialog";
import { BulkBar } from "./bulk-bar";
import { type ItemKind, matches, mcpItem, type RowAction, skillItem, sortItems } from "./catalog";
import { McpDetail, SkillDetail } from "./detail";
import { agentChoices } from "./parts";
import { ItemRow, rowDomId } from "./rows";
import type { Review } from "./skills-tab";

const EXPLAIN: Record<ItemKind, string> = {
  skill:
    "Written instructions an agent follows for a kind of work. A new skill is on for every agent; switch it off per agent.",
  mcp: "Tools agents can call, like a database or a tracker. Each server reaches the agents of its workspace.",
};

function typing(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
  );
}

/**
 * `/skills`: skills and MCP servers as one list per tab, one line each. A row opens its detail on
 * the right; Add finds, previews and installs either kind. `?tab=mcp` opens the servers.
 */
export function SkillsView() {
  const [param, setTab] = useSearchParam("tab");
  const tab: ItemKind = param === "mcp" ? "mcp" : "skill";
  const skills = useSkills();
  const connections = useConnections();
  const statuses = useConnectStatus();
  const agents = agentChoices(useAgents().data);
  const orgs = useOrgs().data ?? [];
  const toast = useToast();
  const navigate = useNavigate();
  const enableAll = useSkillsCommand("skills.enableAll");
  const update = useSkillsCommand("skills.update");
  const test = useConnectionCommand("connections.test");

  const [query, setQuery] = useState("");
  const [focusKey, setFocusKey] = useState<string>();
  const [openKey, setOpenKey] = useState<string>();
  const [adding, setAdding] = useState<{ kind: ItemKind; review?: Review }>();
  const [highlight, setHighlight] = useState<string>();
  const [checks, setChecks] = useState<Record<string, { updating: boolean; failed?: string | undefined }>>(
    {},
  );
  const [testing, setTesting] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const searchRef = useRef<HTMLInputElement>(null);
  // Ticked skills (by row key), and the last tick for a shift-click range.
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const lastTick = useRef<string | undefined>(undefined);

  const mcpServers = useMemo(
    () => (connections.data ?? []).filter((c) => c.type === "mcp"),
    [connections.data],
  );
  const all = useMemo(() => {
    const skillItems = (skills.data ?? []).map((s) =>
      skillItem(s, agents, checks[s.name] ?? { updating: false, failed: undefined }),
    );
    const mcpItems = mcpServers.map((c) =>
      mcpItem(
        c,
        statuses.data?.find((s) => s.connection === c.id),
        { testing: testing.has(c.id) },
      ),
    );
    return { skill: sortItems(skillItems), mcp: sortItems(mcpItems) };
  }, [skills.data, mcpServers, statuses.data, checks, testing, agents.length, agents]);
  const items = all[tab].filter((i) => matches(i, query));
  const loading = tab === "skill" ? skills.isPending : connections.isPending;
  const failed = tab === "skill" ? skills.error : connections.error;

  const setBusyKey = (key: string, on: boolean) =>
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const checkSkill = useCallback(
    (name: string, patch: { updating: boolean; failed?: string | undefined }) =>
      setChecks((prev) => ({ ...prev, [name]: patch })),
    [],
  );
  const openDetail = (key: string) => {
    setFocusKey(key);
    setOpenKey(key);
  };

  const act = (key: string, action: RowAction) => {
    const [kind, ...rest] = key.split(":");
    const id = rest.join(":");
    if (action === "fix") return openDetail(key);
    if (action === "sign-in") {
      void navigate({ to: PAGE_PATH.connections, search: { connection: id } });
      return;
    }
    if (action === "enable-all") {
      setBusyKey(key, true);
      enableAll.mutate(
        { name: id },
        {
          onError: (e) => toast(`Could not enable ${id}`, { detail: describeError(e), tone: "error" }),
          onSettled: () => setBusyKey(key, false),
        },
      );
    } else if (action === "retry") {
      checkSkill(id, { updating: true });
      update.mutate(
        { name: id },
        {
          onSuccess: (r) => {
            checkSkill(id, { updating: false });
            if (r.status === "preview") setAdding({ kind: "skill", review: { kind: "update", preview: r } });
            else toast(`${id} is already the newest copy.`);
          },
          onError: (e) => checkSkill(id, { updating: false, failed: describeError(e) }),
        },
      );
    } else if (action === "test" && kind === "mcp") {
      setTesting((prev) => new Set(prev).add(id));
      test.mutate(
        { id },
        {
          onError: (e) => toast(`Could not test ${id}`, { detail: describeError(e), tone: "error" }),
          onSettled: () =>
            setTesting((prev) => {
              const next = new Set(prev);
              next.delete(id);
              return next;
            }),
        },
      );
    }
  };

  // The new row: switch to its tab, light it for a few seconds, and bring it into view.
  const added = (key: string) => {
    const kind: ItemKind = key.startsWith("mcp:") ? "mcp" : "skill";
    setTab(kind === "mcp" ? "mcp" : undefined);
    setQuery("");
    setHighlight(key);
    setFocusKey(key);
  };
  useEffect(() => {
    if (highlight === undefined) return;
    const timer = setTimeout(() => setHighlight(undefined), 6000);
    return () => clearTimeout(timer);
  }, [highlight]);
  useEffect(() => {
    if (focusKey !== undefined)
      document.getElementById(rowDomId(focusKey))?.scrollIntoView({ block: "nearest" });
  }, [focusKey]);

  // Keys: j and k move, Enter opens, / searches, a adds.
  const live = useRef({ items, focusKey, tab });
  live.current = { items, focusKey, tab };
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey)
        return;
      const target = event.target;
      if (document.querySelector("dialog[open]") || typing(target)) return;
      if (target instanceof HTMLElement && target.closest('[role="menu"], [role="listbox"]')) return;
      const { items: rows, focusKey: at, tab: current } = live.current;
      const index = rows.findIndex((r) => r.key === at);
      const move = (to: number) => {
        const next = rows[Math.max(0, Math.min(rows.length - 1, to))];
        if (next === undefined) return;
        event.preventDefault();
        // Focus on the tabs or the search box would swallow Enter: the row takes the keys now.
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        setFocusKey(next.key);
      };
      if (event.key === "j" || event.key === "ArrowDown") move(index + 1);
      else if (event.key === "k" || event.key === "ArrowUp") move(index < 0 ? 0 : index - 1);
      else if (event.key === "/") {
        event.preventDefault();
        searchRef.current?.focus();
      } else if (event.key === "x" && current === "skill" && at !== undefined) {
        event.preventDefault();
        selectRef.current(at, false);
      } else if (event.key === "a") {
        event.preventDefault();
        setAdding({ kind: current });
      } else if (event.key === "Enter" && at !== undefined) {
        if (target instanceof HTMLElement && target.closest("button, a")) return;
        event.preventDefault();
        setOpenKey(at);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const openItem =
    openKey === undefined ? undefined : [...all.skill, ...all.mcp].find((i) => i.key === openKey);
  const openSkill =
    openItem?.kind === "skill" ? skills.data?.find((s) => `skill:${s.name}` === openKey) : undefined;
  const openServer = openItem?.kind === "mcp" ? mcpServers.find((c) => `mcp:${c.id}` === openKey) : undefined;
  const total = all[tab].length;
  const select = (key: string, range: boolean) => {
    const rows = live.current.items;
    const from = lastTick.current === undefined ? -1 : rows.findIndex((r) => r.key === lastTick.current);
    const to = rows.findIndex((r) => r.key === key);
    setSelected((prev) => {
      const next = new Set(prev);
      if (range && from >= 0 && to >= 0) {
        const on = !prev.has(key);
        for (const r of rows.slice(Math.min(from, to), Math.max(from, to) + 1)) {
          if (on) next.add(r.key);
          else next.delete(r.key);
        }
      } else if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    lastTick.current = key;
  };
  const selectRef = useRef(select);
  selectRef.current = select;
  // Ticks of skills that were removed or filtered out do not count.
  const ticked = items.filter((i) => i.kind === "skill" && selected.has(i.key)).map((i) => i.name);
  const shown = items.filter((i) => i.kind === "skill").map((i) => i.name);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader title="Skills & MCP" subtitle="What your agents follow and which tools they can call.">
        <Input
          ref={searchRef}
          aria-label="Search skills and MCP servers"
          type="search"
          value={query}
          placeholder="Search"
          className="w-[220px]"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setQuery("");
              event.currentTarget.blur();
            }
          }}
        />
        <Button variant="primary" onClick={() => setAdding({ kind: tab })}>
          <Plus aria-hidden="true" />
          Add
          <Kbd>a</Kbd>
        </Button>
      </PageHeader>
      <div className="mb-2 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1">
        <Segmented
          label="Skills or MCP servers"
          value={tab}
          onChange={(next) => {
            setTab(next === "mcp" ? "mcp" : undefined);
            setFocusKey(undefined);
            setSelected(new Set());
          }}
          segments={[
            { value: "skill", label: "Skills", count: all.skill.length },
            { value: "mcp", label: "MCP servers", count: all.mcp.length },
          ]}
        />
        <p className="min-w-0 flex-1 truncate text-sm text-fg-muted" title={EXPLAIN[tab]}>
          {EXPLAIN[tab]}
        </p>
      </div>
      {tab === "skill" && (skills.data?.length ?? 0) > 0 && (
        <BulkBar
          names={ticked.length > 0 ? ticked : shown}
          ticked={ticked.length}
          filtered={query.trim() !== ""}
          agents={agents}
          orgs={orgs}
          onClear={() => setSelected(new Set())}
        />
      )}
      <section
        aria-label={tab === "skill" ? "Skills" : "MCP servers"}
        className={cn("flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl", GLASS)}
      >
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-6 scroll-fade">
          {failed ? (
            <p role="alert" className="p-6 text-base text-red">
              Could not load {tab === "skill" ? "skills" : "MCP servers"}: {describeError(failed)}
            </p>
          ) : loading ? (
            <div aria-busy="true" className="flex flex-col gap-px p-2">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-11 rounded-md" />
              ))}
            </div>
          ) : total === 0 ? (
            <Empty kind={tab} onAdd={() => setAdding({ kind: tab })} />
          ) : items.length === 0 ? (
            <div className="flex flex-col items-start gap-2 p-6">
              <p className="text-base text-fg-muted">Nothing matches "{query.trim()}".</p>
              <Button size="sm" onClick={() => setQuery("")}>
                Clear search
              </Button>
            </div>
          ) : (
            <ul
              aria-label={tab === "skill" ? "Installed skills" : "Installed MCP servers"}
              className="m-0 list-none p-0"
            >
              {items.map((item) => (
                <ItemRowEntry
                  key={item.key}
                  item={item}
                  server={
                    item.kind === "mcp" ? mcpServers.find((c) => `mcp:${c.id}` === item.key) : undefined
                  }
                  orgs={orgs}
                  focused={focusKey === item.key}
                  highlighted={highlight === item.key}
                  selected={selected.has(item.key)}
                  onSelect={item.kind === "skill" ? select : undefined}
                  busy={busy.has(item.key) || (item.kind === "mcp" && testing.has(item.key.slice(4)))}
                  onFocus={setFocusKey}
                  onOpen={openDetail}
                  onAction={act}
                />
              ))}
            </ul>
          )}
        </div>
      </section>
      {openItem && openSkill && (
        <SkillDetail
          key={openSkill.name}
          skill={openSkill}
          item={openItem}
          agents={agents}
          orgs={orgs}
          onClose={() => setOpenKey(undefined)}
          onUpdating={checkSkill}
          onUpdatePreview={(p) => {
            setOpenKey(undefined);
            setAdding({ kind: "skill", review: { kind: "update", preview: p } });
          }}
        />
      )}
      {openItem && openServer && (
        <McpDetail
          key={openServer.id}
          server={openServer}
          status={statuses.data?.find((s) => s.connection === openServer.id)}
          item={openItem}
          agents={agents}
          orgs={orgs}
          onClose={() => setOpenKey(undefined)}
        />
      )}
      {adding && (
        <AddDialog
          initialKind={adding.kind}
          initialReview={adding.review}
          orgs={orgs}
          skills={skills.data ?? []}
          onClose={() => setAdding(undefined)}
          onAdded={added}
        />
      )}
    </div>
  );
}

function ItemRowEntry(props: React.ComponentProps<typeof ItemRow>) {
  return (
    <li>
      <ItemRow {...props} />
    </li>
  );
}

function Empty({ kind, onAdd }: { kind: ItemKind; onAdd: () => void }) {
  const Icon = kind === "skill" ? Sparkles : Plug;
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
      <span className="flex size-10 items-center justify-center rounded-xl border border-line-strong bg-raised text-fg-muted">
        <Icon aria-hidden="true" className="size-5" />
      </span>
      <h2 className="text-md font-semibold">{kind === "skill" ? "No skills yet" : "No MCP servers yet"}</h2>
      <p className="max-w-[420px] text-base text-fg-muted text-pretty">
        {kind === "skill"
          ? "Add one from the directory or paste a link. It is on for every agent as soon as it lands."
          : "Add one from the registry, or paste a URL or command. Agents of its workspace get it."}
      </p>
      <Button variant="primary" onClick={onAdd}>
        <Plus aria-hidden="true" />
        {kind === "skill" ? "Add a skill" : "Add an MCP server"}
        <Kbd>a</Kbd>
      </Button>
    </div>
  );
}
