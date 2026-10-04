import {
  APPROVAL_PRESETS,
  type ApprovalGroup,
  type ApprovalGroupId,
  type ApprovalMode,
  type ApprovalPresetId,
  type ApprovalStats,
  applyPreset,
  approvalGroups,
  type CardCounts,
  EMPTY_COUNTS,
  effectiveMode,
  isDestructiveCommand,
  type ModeChange,
  type PolicyModes,
  policyChanges,
  type Settings,
  sumCounts,
  withCommandMode,
} from "@majhi/shared";
import { ArrowRight, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { ChoiceChip } from "@/components/ui/choice-chip";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { SaveSection, type SaveState } from "@/components/ui/save-section";
import { Select } from "@/components/ui/select";
import { MODE_LABEL } from "@/features/boss/model";
import { useCardStats, useSavePolicy } from "@/lib/boss-queries";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";

const MODES: readonly ApprovalMode[] = ["auto", "when-asked", "confirm"];
const IDLE: SaveState = { kind: "idle" };
const STATS_DAYS = 14;
const MIXED = "mixed";

/** The approval page's choices and what each command does now, from the saved policy. */
export function modesOf(policy: Settings["policy"]): PolicyModes {
  const { read, change, destructive, outbound, commands } = policy;
  return { read, change, destructive, outbound, commands };
}

/** One word for the setup list: the preset the saved policy matches, or how many commands differ. */
export function policyStatus(policy: Settings["policy"]): string {
  const groups = approvalGroups();
  const modes = modesOf(policy);
  for (const id of ["hands-off", "careful"] as const) {
    if (policyChanges(modes, applyPreset(modes, id, groups), groups).length === 0) {
      return APPROVAL_PRESETS[id].label;
    }
  }
  const own = Object.keys(policy.commands).length;
  return own === 0 ? "Defaults" : `${own} ${own === 1 ? "command" : "commands"} set`;
}

/**
 * What agents may do without asking, in plain categories. Each category's select sets every command
 * in it; opening one sets a command on its own. Presets fill the draft; Save asks first, since the
 * policy decides what agents can do alone.
 */
export function ApprovalsSection({ settings }: { settings: Settings }) {
  const groups = useMemo(() => approvalGroups(), []);
  const save = useSavePolicy();
  const stats = useCardStats(STATS_DAYS);
  const saved = modesOf(settings.policy);
  const [draft, setDraft] = useState<PolicyModes>();
  const [open, setOpen] = useState<ReadonlySet<ApprovalGroupId>>(new Set());
  const [state, setState] = useState<SaveState>(IDLE);
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string>();
  const modes = draft ?? saved;
  const changes = policyChanges(saved, modes, groups);
  const dirty = changes.length > 0;
  const counts = useMemo(() => countsByCommand(stats.data), [stats.data]);

  function edit(next: PolicyModes) {
    if (state.kind !== "saving") setState(IDLE);
    setDraft(next);
  }

  function setGroup(group: ApprovalGroup, mode: ApprovalMode) {
    let next = modes;
    for (const c of group.commands) next = withCommandMode(next, c.name, c.risk, mode);
    edit(next);
  }

  const presetPressed = (id: ApprovalPresetId) =>
    policyChanges(modes, applyPreset(modes, id, groups), groups).length === 0;

  return (
    <SaveSection
      title="What agents may do"
      note="Saved to majhi.yaml. Save asks you first."
      className="border-t-0"
      dirty={dirty}
      state={state}
      onSave={() => setConfirming(true)}
      onDiscard={() => {
        setDraft(undefined);
        setState(IDLE);
      }}
    >
      <div className="flex flex-col gap-2">
        <fieldset className="m-0 flex min-w-0 flex-wrap items-center gap-2 border-0 p-0">
          <legend className="sr-only">Start from</legend>
          <span aria-hidden="true" className="text-sm text-fg-muted">
            Start from
          </span>
          {(["hands-off", "careful"] as const).map((id) => (
            <ChoiceChip
              key={id}
              pressed={presetPressed(id)}
              title={APPROVAL_PRESETS[id].about}
              onClick={() => edit(applyPreset(modes, id, groups))}
            >
              {APPROVAL_PRESETS[id].label}
            </ChoiceChip>
          ))}
          <ChoiceChip
            pressed={!dirty}
            title="What is saved now"
            onClick={() => {
              setDraft(undefined);
              setState(IDLE);
            }}
          >
            Current
          </ChoiceChip>
        </fieldset>
        <ul className="flex flex-col gap-0.5 text-sm text-fg-faint">
          {(["hands-off", "careful"] as const).map((id) => (
            <li key={id} className="text-pretty">
              <span className="text-fg-muted">{APPROVAL_PRESETS[id].label}:</span>{" "}
              {APPROVAL_PRESETS[id].about}
            </li>
          ))}
        </ul>
      </div>

      {dirty && <ChangeList changes={changes} groups={groups} />}

      <div className="flex flex-col gap-1.5">
        <StatsLine stats={stats.data} error={stats.isError ? describeError(stats.error) : undefined} />
        <ul aria-label="Categories" className="flex flex-col gap-2">
          {groups.map((group) => (
            <GroupRow
              key={group.id}
              group={group}
              modes={modes}
              saved={saved}
              counts={counts}
              expanded={open.has(group.id)}
              onToggle={() => {
                const next = new Set(open);
                if (next.has(group.id)) next.delete(group.id);
                else next.add(group.id);
                setOpen(next);
              }}
              onGroup={(mode) => setGroup(group, mode)}
              onCommand={(name, risk, mode) => edit(withCommandMode(modes, name, risk, mode))}
            />
          ))}
        </ul>
        <p className="text-sm text-fg-faint text-pretty">
          Reads never ask. A command you do not set follows its risk class: changes run when you asked for
          them, deletes and outbound actions always ask.
        </p>
      </div>

      {confirming && (
        <ConfirmDialog
          title="Change what agents may do?"
          body={
            <>
              {changes.length} {changes.length === 1 ? "command changes" : "commands change"}. This decides
              what agents can do without asking you, so it needs your yes.
            </>
          }
          confirmLabel="Change policy"
          busy={save.isPending}
          error={problem}
          onCancel={() => {
            setConfirming(false);
            setProblem(undefined);
          }}
          onConfirm={() => {
            setState({ kind: "saving" });
            save.mutate(modes, {
              onSuccess: () => {
                setConfirming(false);
                setProblem(undefined);
                setDraft(undefined);
                setState({ kind: "saved" });
              },
              onError: (error) => {
                setState(IDLE);
                setProblem(describeError(error));
              },
            });
          }}
        />
      )}
    </SaveSection>
  );
}

function countsByCommand(stats: ApprovalStats | undefined): Map<string, CardCounts> {
  return new Map((stats?.commands ?? []).map(({ command, ...counts }) => [command, counts]));
}

/** "46 cards, you approved 32, rejected 1", leaving out the parts that are zero. */
function CountsText({ counts }: { counts: CardCounts }) {
  if (counts.shown === 0) return <span className="text-fg-dim">No cards</span>;
  const parts: [string, number][] = [
    ["you approved", counts.approved],
    ["ran on their own", counts.ranAlone],
    ["rejected", counts.rejected],
    ["failed", counts.failed],
    ["waiting", counts.waiting],
  ];
  return (
    <span className="tabular-nums">
      <span className="font-mono text-fg-soft">{counts.shown}</span> {counts.shown === 1 ? "card" : "cards"}
      {parts
        .filter(([, n]) => n > 0)
        .map(([word, n]) => (
          <span key={word}>
            , {word} <span className="font-mono text-fg-soft">{n}</span>
          </span>
        ))}
    </span>
  );
}

function StatsLine({ stats, error }: { stats: ApprovalStats | undefined; error: string | undefined }) {
  return (
    <p className="flex flex-wrap items-baseline gap-x-1.5 text-sm text-fg-muted">
      <span className="font-medium text-fg">Last {STATS_DAYS} days</span>
      {error !== undefined ? (
        <span className="text-red">Could not count the cards: {error}</span>
      ) : stats === undefined ? (
        <span className="text-fg-faint">Counting cards</span>
      ) : (
        <CountsText counts={sumCounts(stats.commands)} />
      )}
    </p>
  );
}

function ModeSelect({
  label,
  value,
  onChange,
  locked = false,
}: {
  label: string;
  value: ApprovalMode | typeof MIXED;
  onChange: (mode: ApprovalMode) => void;
  /** A destructive command: it always asks, so its mode cannot change. */
  locked?: boolean;
}) {
  return (
    <Select
      aria-label={label}
      value={value}
      disabled={locked}
      title={locked ? "Deletes and removals always ask you" : undefined}
      className="w-[208px] shrink-0"
      onChange={(e) => {
        const mode = MODES.find((m) => m === e.target.value);
        if (mode !== undefined) onChange(mode);
      }}
    >
      {value === MIXED && (
        <option value={MIXED} disabled>
          Mixed
        </option>
      )}
      {MODES.map((mode) => (
        <option key={mode} value={mode}>
          {MODE_LABEL[mode]}
        </option>
      ))}
    </Select>
  );
}

function GroupRow({
  group,
  modes,
  saved,
  counts,
  expanded,
  onToggle,
  onGroup,
  onCommand,
}: {
  group: ApprovalGroup;
  modes: PolicyModes;
  saved: PolicyModes;
  counts: Map<string, CardCounts>;
  expanded: boolean;
  onToggle: () => void;
  onGroup: (mode: ApprovalMode) => void;
  onCommand: (name: string, risk: ApprovalGroup["commands"][number]["risk"], mode: ApprovalMode) => void;
}) {
  const each = group.commands.map((c) => effectiveMode(modes, c.name, c.risk));
  const first = each[0];
  const value = first !== undefined && each.every((m) => m === first) ? first : MIXED;
  const total = sumCounts(group.commands.map((c) => counts.get(c.name) ?? EMPTY_COUNTS));
  const edited = group.commands.filter(
    (c) => effectiveMode(modes, c.name, c.risk) !== effectiveMode(saved, c.name, c.risk),
  ).length;
  const sensitive = group.commands.filter((c) => c.sensitive).length;
  const listId = `approval-group-${group.id}`;
  if (group.commands.length === 0) return null;

  return (
    <li className="rounded-[10px] border border-line-strong bg-card">
      <div className="flex min-w-0 items-start gap-3 py-2.5 pr-2.5 pl-1.5">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={onToggle}
          className="flex min-w-0 flex-1 cursor-pointer items-start gap-1.5 rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "mt-0.5 size-4 shrink-0 text-fg-faint transition-transform duration-150",
              expanded && "rotate-90",
            )}
          />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="text-md font-medium text-fg">{group.label}</span>
              <span className="text-sm text-fg-faint tabular-nums">
                <span className="font-mono">{group.commands.length}</span>{" "}
                {group.commands.length === 1 ? "command" : "commands"}
                {sensitive > 0 && (
                  <>
                    , <span className="font-mono">{sensitive}</span> sensitive
                  </>
                )}
              </span>
              {edited > 0 && (
                <Badge tone="amber">
                  <span className="font-mono">{edited}</span> not saved
                </Badge>
              )}
            </span>
            <span className="text-sm text-fg-muted text-pretty">{group.about}</span>
            <span className="text-sm text-fg-faint">
              <CountsText counts={total} />
            </span>
          </span>
        </button>
        <ModeSelect
          label={`${group.label}: every command`}
          value={value}
          locked={group.commands.every((c) => isDestructiveCommand(c.name))}
          onChange={onGroup}
        />
      </div>
      {expanded && (
        <ul
          id={listId}
          aria-label={`${group.label} commands`}
          className="flex flex-col border-t border-line py-1"
        >
          {group.commands.map((c) => {
            const mode = effectiveMode(modes, c.name, c.risk);
            const changed = mode !== effectiveMode(saved, c.name, c.risk);
            return (
              <li key={c.name} className="flex min-w-0 items-center gap-3 py-1.5 pr-2.5 pl-7">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="text-base text-fg">{c.label}</span>
                    <span className="font-mono text-xs text-fg-faint">{c.name}</span>
                    {c.sensitive && <Badge tone="amber">Sensitive</Badge>}
                    {changed && <span className="text-xs text-accent-text">Not saved</span>}
                  </span>
                  <span className="text-xs text-fg-faint">
                    <CountsText counts={counts.get(c.name) ?? EMPTY_COUNTS} />
                  </span>
                </span>
                <ModeSelect
                  label={c.label}
                  value={mode}
                  locked={isDestructiveCommand(c.name)}
                  onChange={(m) => onCommand(c.name, c.risk, m)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

/** What Save would change, by category: each move from one mode to another, with its commands. */
function ChangeList({ changes, groups }: { changes: ModeChange[]; groups: ApprovalGroup[] }) {
  const byGroup = groups
    .map((g) => {
      const mine = changes.filter((c) => c.group === g.id);
      const moves = new Map<string, ModeChange[]>();
      for (const c of mine) moves.set(`${c.from}>${c.to}`, [...(moves.get(`${c.from}>${c.to}`) ?? []), c]);
      return { group: g, mine, moves: [...moves.values()] };
    })
    .filter((g) => g.mine.length > 0);
  return (
    <section
      aria-label="Changes to save"
      className="flex flex-col gap-2 rounded-[10px] border border-accent-line bg-accent-wash p-3"
    >
      <h4 className="text-base font-semibold text-fg">
        <span className="font-mono tabular-nums">{changes.length}</span>{" "}
        {changes.length === 1 ? "command changes" : "commands change"} when you save
      </h4>
      <ul className="flex flex-col gap-2">
        {byGroup.map(({ group, mine, moves }) => (
          <li key={group.id} className="flex flex-col gap-1">
            <span className="text-sm font-medium text-fg">
              {group.label}{" "}
              <span className="font-normal text-fg-muted">
                <span className="font-mono">{mine.length}</span> of{" "}
                <span className="font-mono">{group.commands.length}</span>
              </span>
            </span>
            {moves.map((list) => {
              const head = list[0];
              if (head === undefined) return null;
              return (
                <div key={`${head.from}>${head.to}`} className="flex flex-col gap-0.5 pl-3 text-sm">
                  <span className="flex flex-wrap items-center gap-1.5 text-fg-soft">
                    {MODE_LABEL[head.from]}
                    <ArrowRight aria-label="to" className="size-3.5 text-fg-faint" />
                    <span className="font-medium text-fg">{MODE_LABEL[head.to]}</span>
                  </span>
                  <ul className="flex flex-wrap gap-x-1 gap-y-0.5 text-fg-muted">
                    {list.map((c, i) => (
                      <li key={c.command} title={c.command}>
                        {c.label}
                        {i < list.length - 1 && (
                          <span aria-hidden="true" className="pl-1 text-fg-dim">
                            ·
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </li>
        ))}
      </ul>
    </section>
  );
}
