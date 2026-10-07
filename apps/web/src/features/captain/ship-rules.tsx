import {
  type Authority,
  type AuthorityChoice,
  type CaptainOrg,
  SHIP_GUARDS,
  type ShipRule,
  type ShipStep,
  shipRuleSentence,
  TASK_TYPE_LABEL,
  TASK_TYPES,
  type TaskType,
} from "@majhi/shared";
import { ArrowDown, ArrowUp, Check, Filter, Plus, Sparkles, Trash2, TriangleAlert, X } from "lucide-react";
import { type CSSProperties, useState } from "react";
import { Button } from "@/components/ui/button";
import { Menu } from "@/components/ui/menu";
import { useToast } from "@/components/ui/toast";
import { TYPE_ICON, typeColor } from "@/features/tasks-ui/type-meta";
import { useAreaNames, useCaptainRules } from "@/lib/captain-queries";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { movedRule, newShipRule, productionByCaptain, whenWith, withRule } from "./model";

/** The four steps a rule can change, with the column word for each. */
const STEPS: readonly { step: ShipStep; column: string; name: string }[] = [
  { step: "merge", column: "Merge", name: "Merge" },
  { step: "deployStaging", column: "Staging", name: "Deploy staging" },
  { step: "deployProduction", column: "Production", name: "Deploy production" },
  { step: "tell", column: "Tell", name: "Tell the client" },
];

const STEP_WIDTH = "w-20 shrink-0";
const ACTIONS_WIDTH = "w-[84px] shrink-0";

/** One step of one rule: the captain does it, or you do. */
function RuleCell({
  value,
  label,
  disabled,
  onToggle,
}: {
  value: AuthorityChoice;
  label: string;
  disabled: boolean;
  onToggle: () => void;
}) {
  const captain = value === "decide";
  return (
    <button
      type="button"
      aria-pressed={captain}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "flex h-[26px] w-[76px] cursor-pointer items-center justify-center gap-1.5 rounded-md border text-xs transition-colors disabled:cursor-wait disabled:opacity-60",
        captain
          ? "border-accent-line bg-accent-wash font-medium text-fg"
          : "border-dashed border-line-control text-fg-muted hover:border-line-hover hover:text-fg",
      )}
    >
      {captain && <Check aria-hidden="true" className="size-3 text-accent-text" strokeWidth={2.5} />}
      {captain ? "Captain" : "You"}
    </button>
  );
}

/** A task type in a rule: its icon and word, and a cross that takes it out. */
function TypeTag({ type, onRemove, disabled }: { type: TaskType; onRemove: () => void; disabled: boolean }) {
  const Icon = TYPE_ICON[type];
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onRemove}
      title={`Remove ${TASK_TYPE_LABEL[type]}`}
      aria-label={`Remove ${TASK_TYPE_LABEL[type]}`}
      style={{ "--tc": typeColor(type) } as CSSProperties}
      className="inline-flex h-6 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-[7px] border border-[color-mix(in_srgb,var(--tc)_34%,transparent)] bg-[color-mix(in_srgb,var(--tc)_10%,transparent)] pr-1.5 pl-1.5 text-xs text-fg hover:border-line-hover disabled:cursor-wait"
    >
      <Icon aria-hidden="true" className="size-3.5 text-(--tc)" strokeWidth={1.8} />
      {TASK_TYPE_LABEL[type]}
      <X aria-hidden="true" className="size-3 text-fg-faint" />
    </button>
  );
}

const MINI =
  "grid size-[26px] shrink-0 cursor-pointer place-items-center rounded-md text-fg-faint hover:bg-raised hover:text-fg disabled:pointer-events-none disabled:opacity-30";

/** The changed-lines limit: a number committed when the field is left, empty for no limit. */
function LinesField({
  value,
  disabled,
  onCommit,
}: {
  value: number | undefined;
  disabled: boolean;
  onCommit: (next: number | undefined) => void;
}) {
  const [text, setText] = useState(value === undefined ? "" : String(value));
  const [shown, setShown] = useState(value);
  // A change from outside (an undo, another tab) replaces what is typed.
  if (shown !== value) {
    setShown(value);
    setText(value === undefined ? "" : String(value));
  }
  const typed = text.trim();
  const parsed = typed === "" ? undefined : Number(typed);
  const invalid = typed !== "" && !(Number.isInteger(parsed) && (parsed ?? 0) >= 1);
  const commit = () => {
    if (invalid || parsed === value) return;
    onCommit(parsed);
  };
  return (
    <input
      aria-label="Up to this many changed lines"
      inputMode="numeric"
      placeholder="any"
      value={text}
      aria-invalid={invalid}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") setText(value === undefined ? "" : String(value));
      }}
      className="tnum h-[22px] w-12 rounded-[5px] border border-line-control bg-field text-center font-mono text-xs text-fg outline-none placeholder:text-fg-faint focus-visible:border-accent aria-invalid:border-red"
    />
  );
}

function RuleRow({
  org,
  rules,
  index,
  busy,
  selected,
  areaNames,
  onChange,
  onSelect,
}: {
  org: CaptainOrg;
  rules: readonly ShipRule[];
  index: number;
  busy: boolean;
  selected: boolean;
  areaNames: readonly string[];
  onChange: (next: ShipRule[], note: string) => void;
  onSelect: () => void;
}) {
  const rule = rules[index];
  if (rule === undefined) return null;
  const { when } = rule;
  const update = (next: ShipRule, note: string) => {
    onSelect();
    onChange(withRule(rules, index, next), note);
  };
  const freeTypes = TASK_TYPES.filter((t) => !when.types.includes(t));
  const freeAreas = areaNames.filter((a) => !(when.areas ?? []).includes(a));
  return (
    <li
      aria-current={selected ? "true" : undefined}
      className="flex items-center gap-2 border-b border-line py-2"
      onFocusCapture={onSelect}
    >
      <div className="flex min-w-0 flex-1 basis-0 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-1">
          {when.types.length === 0 ? (
            <span className="inline-flex h-6 items-center rounded-md border border-line-strong bg-raised px-2 text-sm text-fg-soft">
              any type
            </span>
          ) : (
            when.types.map((type) => (
              <TypeTag
                key={type}
                type={type}
                disabled={busy}
                onRemove={() =>
                  update(
                    { ...rule, when: whenWith(when, { types: when.types.filter((t) => t !== type) }) },
                    `${org.name}: ${TASK_TYPE_LABEL[type]} left a rule`,
                  )
                }
              />
            ))
          )}
          {freeTypes.length > 0 && (
            <Menu
              label="Add a type to this rule"
              align="left"
              items={freeTypes.map((type) => {
                const Icon = TYPE_ICON[type];
                return {
                  label: TASK_TYPE_LABEL[type],
                  icon: <Icon className="size-3.5" style={{ color: typeColor(type) }} strokeWidth={1.8} />,
                  onSelect: () =>
                    update(
                      { ...rule, when: whenWith(when, { types: [...when.types, type] }) },
                      `${org.name}: ${TASK_TYPE_LABEL[type]} joined a rule`,
                    ),
                };
              })}
              trigger={({ ref, ...props }) => (
                <button
                  ref={ref}
                  type="button"
                  {...props}
                  disabled={busy}
                  aria-label="Add a type to this rule"
                  title="Add a type"
                  className={cn(MINI, "size-6")}
                >
                  <Plus aria-hidden="true" className="size-3.5" />
                </button>
              )}
            />
          )}
        </div>
        <div className="flex flex-wrap items-center gap-[5px] text-xs text-fg-muted">
          up to
          <LinesField
            value={when.maxChangedLines}
            disabled={busy}
            onCommit={(next) => {
              const { maxChangedLines: _dropped, ...rest } = when;
              update(
                { ...rule, when: next === undefined ? rest : { ...rest, maxChangedLines: next } },
                `${org.name}: the line limit of a rule`,
              );
            }}
          />
          lines
          {(when.areas ?? []).map((area) => (
            <button
              key={area}
              type="button"
              disabled={busy}
              title={`Remove ${area}`}
              aria-label={`Remove the area ${area}`}
              onClick={() =>
                update(
                  { ...rule, when: whenWith(when, { areas: (when.areas ?? []).filter((a) => a !== area) }) },
                  `${org.name}: ${area} left a rule`,
                )
              }
              className="inline-flex h-5 cursor-pointer items-center gap-1 rounded-md border border-line-strong bg-raised px-[7px] text-[11px] text-fg-muted hover:border-line-hover hover:text-fg"
            >
              {area}
              <X aria-hidden="true" className="size-3" />
            </button>
          ))}
          {freeAreas.length > 0 && (
            <Menu
              label="Limit this rule to an area"
              align="left"
              items={freeAreas.map((area) => ({
                label: area,
                onSelect: () =>
                  update(
                    { ...rule, when: whenWith(when, { areas: [...(when.areas ?? []), area] }) },
                    `${org.name}: ${area} joined a rule`,
                  ),
              }))}
              trigger={({ ref, ...props }) => (
                <button
                  ref={ref}
                  type="button"
                  {...props}
                  disabled={busy}
                  aria-label="Limit this rule to an area"
                  title="Limit to an area"
                  className={cn(MINI, "size-[22px]")}
                >
                  <Filter aria-hidden="true" className="size-3.5" />
                </button>
              )}
            />
          )}
        </div>
      </div>
      {STEPS.map(({ step, name }) => (
        <div key={step} className={STEP_WIDTH}>
          <RuleCell
            value={rule[step]}
            label={`${name} for this rule in ${org.name}: ${rule[step] === "decide" ? "the captain decides" : "you decide"}`}
            disabled={busy}
            onToggle={() =>
              update(
                { ...rule, [step]: rule[step] === "decide" ? "ask" : "decide" },
                `${org.name}: ${name} in a rule is ${rule[step] === "decide" ? "yours" : "the captain's"}`,
              )
            }
          />
        </div>
      ))}
      <span className={cn(ACTIONS_WIDTH, "flex")}>
        <button
          type="button"
          aria-label="Move this rule up"
          title="Earlier: the first rule that matches decides"
          disabled={busy || index === 0}
          onClick={() => onChange(movedRule(rules, index, -1), `${org.name}: moved a rule up`)}
          className={MINI}
        >
          <ArrowUp aria-hidden="true" className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label="Move this rule down"
          title="Later"
          disabled={busy || index === rules.length - 1}
          onClick={() => onChange(movedRule(rules, index, 1), `${org.name}: moved a rule down`)}
          className={MINI}
        >
          <ArrowDown aria-hidden="true" className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label="Delete this rule"
          title="Delete"
          disabled={busy}
          onClick={() =>
            onChange(
              rules.filter((_, i) => i !== index),
              `${org.name}: removed a rule`,
            )
          }
          className={MINI}
        >
          <Trash2 aria-hidden="true" className="size-3.5" />
        </button>
      </span>
    </li>
  );
}

/** The workspace picker of the section, small and in the section's own line. */
function Workspaces({
  orgs,
  value,
  onChange,
}: {
  orgs: readonly CaptainOrg[];
  value: string;
  onChange: (org: string) => void;
}) {
  return (
    <fieldset
      aria-label="Workspace"
      className="m-0 ml-auto flex min-w-0 max-w-full gap-0.5 overflow-x-auto rounded-lg border border-line-strong bg-field p-0.5"
    >
      {orgs.map((o) => (
        <button
          key={o.org}
          type="button"
          aria-pressed={o.org === value}
          onClick={() => onChange(o.org)}
          className={cn(
            "h-[22px] shrink-0 cursor-pointer whitespace-nowrap rounded-md px-[9px] text-xs transition-colors",
            o.org === value
              ? "bg-selected font-medium text-fg shadow-[inset_0_0_0_1px_var(--c-line-control)]"
              : "text-fg-muted hover:bg-raised hover:text-fg",
          )}
        >
          {o.name}
        </button>
      ))}
    </fieldset>
  );
}

/**
 * "By type": the ship rules of one workspace. Each rule says what it covers (types, up to how many
 * lines, which areas) and who does merge, staging, production and the reply. The first rule that
 * matches decides; no match, the rows above. Every change saves at once.
 */
export function ShipRules({ orgs }: { orgs: readonly CaptainOrg[] }) {
  const toast = useToast();
  const save = useCaptainRules();
  const [picked, setPicked] = useState<string>();
  const [selected, setSelected] = useState(0);
  const org = orgs.find((o) => o.org === picked) ?? orgs[0];
  const areas = useAreaNames(org?.org ?? "");
  if (org === undefined) return null;
  const rules = org.rules.ships ?? [];
  const rows: Authority = org.authority;
  const store = (next: ShipRule[], note: string) =>
    save.mutate(
      {
        input: { orgs: { [org.org]: { ships: next.length === 0 ? null : next } } },
        reason: `Owner changed the ship rules of ${org.name}`,
      },
      {
        onSuccess: () => toast(note),
        onError: (error) => toast("Could not save it", { detail: describeError(error), tone: "error" }),
      },
    );
  const current = rules[Math.min(selected, rules.length - 1)];
  return (
    <section
      aria-label="Ship rules by type"
      className="flex min-w-0 flex-col gap-3 border-t border-line py-4"
    >
      <div className="flex items-center gap-2.5">
        <h3 className="flex items-center gap-1.5 text-base font-medium text-fg">
          By type
          <span className="rounded-[4px] border border-accent-line px-1 py-px font-mono text-[10px] font-medium tracking-[0.06em] text-accent-text uppercase">
            new
          </span>
        </h3>
        <Workspaces
          orgs={orgs}
          value={org.org}
          onChange={(next) => {
            setPicked(next);
            setSelected(0);
          }}
        />
      </div>
      <div className="flex items-end gap-2 border-b border-line pb-1">
        <span className="min-w-0 flex-1 text-xs text-fg-faint">When the task is</span>
        {STEPS.map(({ column }) => (
          <span key={column} className={cn(STEP_WIDTH, "text-xs text-fg-faint")}>
            {column}
          </span>
        ))}
        <span className={ACTIONS_WIDTH} />
      </div>
      {rules.length === 0 ? (
        <p className="text-sm text-fg-faint">No exceptions. The rows above apply to every task.</p>
      ) : (
        <ol className="m-0 flex list-none flex-col p-0">
          {rules.map((rule, index) => (
            <RuleRow
              key={rule.id}
              org={org}
              rules={rules}
              index={index}
              busy={save.isPending}
              selected={index === Math.min(selected, rules.length - 1)}
              areaNames={areas.data?.names ?? []}
              onChange={store}
              onSelect={() => setSelected(index)}
            />
          ))}
        </ol>
      )}
      <Button
        size="sm"
        variant="secondary"
        className="self-start"
        disabled={save.isPending || rules.length >= 50}
        onClick={() => {
          setSelected(rules.length);
          store([...rules, newShipRule(rows)], `${org.name}: added a rule`);
        }}
      >
        <Plus aria-hidden="true" />
        Add a type
      </Button>
      {current !== undefined && (
        <div className="flex items-start gap-3 rounded-[10px] border border-line-strong bg-raised px-3 py-2.5">
          <Sparkles aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent-text" />
          <p className="text-[13px] leading-[1.55] text-fg text-pretty">{shipRuleSentence(current)}</p>
        </div>
      )}
      {productionByCaptain(orgs, org) && (
        <div
          role="note"
          className="flex flex-wrap items-center gap-2.5 rounded-[10px] border border-amber-line bg-amber-wash px-3 py-2 text-xs text-fg-soft"
        >
          <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0 text-amber" />A rule lets the captain
          deploy production by itself. Every guard below still applies.
        </div>
      )}
      <ul aria-label="Checked every time" className="m-0 flex list-none flex-wrap gap-1.5 p-0">
        {SHIP_GUARDS.map((guard) => (
          <li
            key={guard}
            className="inline-flex h-6 items-center gap-1.5 rounded-[7px] border border-line-strong bg-card px-[9px] text-xs text-fg-soft"
          >
            <Check aria-hidden="true" className="size-3 text-lamp-done" strokeWidth={2.5} />
            {guard}
          </li>
        ))}
      </ul>
    </section>
  );
}
