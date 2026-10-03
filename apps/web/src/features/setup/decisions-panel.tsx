import {
  EFFORT_TIER_LABEL,
  EffortTierSchema,
  hostOsOf,
  MODEL_TIER_LABEL,
  ModelTierSchema,
  type ProviderId,
  type Role,
  RoleSchema,
  type Tier,
} from "@majhi/shared";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { DetailSection } from "@/components/ui/list-detail";
import { SaveSection, type SaveState } from "@/components/ui/save-section";
import { Select, Textarea } from "@/components/ui/select";
import { Dot } from "@/components/ui/status-dot";
import { useToast } from "@/components/ui/toast";
import {
  type DecisionsStatus,
  useAskDecision,
  useDecisionsStatus,
  useInstallLaya,
  useSaveJevKey,
  useSetDecisions,
} from "@/lib/decisions-queries";
import { describeError } from "@/lib/errors";
import { useHostStatus } from "@/lib/queries";
import { RecentDecisions } from "./recent-decisions";

const NAME: Record<ProviderId, string> = {
  laya: "Laya",
  jev: "Jev",
  acp: "Stand-in agent",
  rules: "Rules",
};
const ALL: readonly ProviderId[] = ["laya", "jev", "acp", "rules"];
const IDLE: SaveState = { kind: "idle" };

/** The first provider in the order, for the list row: "Laya first". */
export function firstProvider(status: DecisionsStatus | undefined): string | undefined {
  const first = status?.settings.order[0];
  return first === undefined ? undefined : `${NAME[first]} first`;
}

/** The decision provider: who answers small typed questions, in what order, and a box to try it. */
export function DecisionsSection() {
  const status = useDecisionsStatus();
  if (status.isPending) return <p className="pt-5 text-sm text-fg-faint">Loading</p>;
  if (status.isError) return <p className="pt-5 text-sm text-red">{describeError(status.error)}</p>;
  return (
    <>
      <DetailSection
        title="Provider order"
        note="Quick picks for agents, tried in this order"
        className="border-t-0"
      >
        <Providers status={status.data} />
      </DetailSection>
      <Picks key={JSON.stringify(status.data.settings)} status={status.data} />
      <DetailSection title="Jev key">
        <JevKey status={status.data} />
      </DetailSection>
      <DetailSection title="Ask the decision model" note="Try a question against the order above">
        <AskBox />
      </DetailSection>
      <RecentDecisions />
    </>
  );
}

function Providers({ status }: { status: DecisionsStatus }) {
  const toast = useToast();
  const save = useSetDecisions();
  const install = useInstallLaya();
  const host = useHostStatus().data?.info;
  const order = status.settings.order;
  const off = ALL.filter((id) => !order.includes(id));
  const info = (id: ProviderId) => status.providers.find((p) => p.id === id);
  const change = (next: ProviderId[]) =>
    save.mutate(
      { order: next },
      { onError: (e) => toast("Could not save the order", { detail: describeError(e), tone: "error" }) },
    );
  const move = (i: number, by: -1 | 1) => {
    const next = [...order];
    const [item] = next.splice(i, 1);
    if (item !== undefined) next.splice(i + by, 0, item);
    change(next);
  };
  const { laya } = status;
  const busy = laya.state === "installing" || laya.state === "downloading";
  // The native install needs a Mac with Apple silicon. Elsewhere Laya runs in Docker, built with the rest.
  const canInstall = hostOsOf(host) === "macos" && host?.laya?.state !== "unsupported";

  return (
    <div className="flex max-w-[720px] flex-col gap-2">
      <ol aria-label="Provider order" className="m-0 flex list-none flex-col p-0">
        {order.map((id, i) => {
          const p = info(id);
          return (
            <li key={id} className="flex min-h-10 items-center gap-3 border-t border-line first:border-t-0">
              <span className="tnum w-4 shrink-0 font-mono text-xs text-fg-faint">{i + 1}</span>
              <span className="flex w-[130px] shrink-0 items-center gap-2">
                <Dot tone={p?.available ? "green" : "neutral"} size={7} />
                <span className="text-base font-medium">{NAME[id]}</span>
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-fg-muted">
                {id === "laya" ? layaLine(status) : (p?.detail ?? "")}
              </span>
              <span className="flex shrink-0 items-center gap-0.5">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Move ${NAME[id]} up`}
                  title="Move up"
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                >
                  <ArrowUp aria-hidden="true" />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Move ${NAME[id]} down`}
                  title="Move down"
                  disabled={i === order.length - 1}
                  onClick={() => move(i, 1)}
                >
                  <ArrowDown aria-hidden="true" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Turn ${NAME[id]} off`}
                  disabled={order.length === 1}
                  onClick={() => change(order.filter((o) => o !== id))}
                >
                  Off
                </Button>
              </span>
            </li>
          );
        })}
      </ol>
      {off.length > 0 && (
        <p className="m-0 flex flex-wrap items-center gap-2 text-sm text-fg-faint">
          Off:
          {off.map((id) => (
            <Button key={id} size="sm" onClick={() => change([...order, id])}>
              Add {NAME[id]}
            </Button>
          ))}
        </p>
      )}
      {busy && laya.progress !== undefined && (
        <progress aria-label="Laya download" className="h-1.5 w-full" value={laya.progress} max={1} />
      )}
      {canInstall && (laya.state === "not-installed" || laya.state === "error") && (
        <div>
          <Button
            size="sm"
            variant="primary"
            disabled={install.isPending}
            onClick={() =>
              install.mutate(undefined, {
                onError: (e) =>
                  toast("Could not start the install", { detail: describeError(e), tone: "error" }),
              })
            }
          >
            {laya.state === "error" ? "Try the Laya install again" : "Install Laya"}
          </Button>
        </div>
      )}
    </div>
  );
}

const BAR: Record<"min_lift" | "min_margin", { label: string; hint: string }> = {
  min_lift: {
    label: "Least lift over chance",
    hint: "0 to 1. 0 is a random pick, 1 is certain. The same bar for 2 options or 20.",
  },
  min_margin: {
    label: "Least lead over the next option",
    hint: "0 to 1. How far the answer must lead the runner-up.",
  },
};

/** When an answer counts, and what each role falls back to when it does not. */
function Picks({ status }: { status: DecisionsStatus }) {
  const save = useSetDecisions();
  const { settings } = status;
  const [bars, setBars] = useState<Partial<Record<Bar, string>>>({});
  const [tiers, setTiers] = useState<Partial<Record<Role, Tier>>>({});
  const [state, setState] = useState<SaveState>(IDLE);
  const [showErrors, setShowErrors] = useState(false);
  const text = (key: Bar) => bars[key] ?? String(settings[key]);
  const value = (key: Bar) => parseBar(text(key));
  const tierOf = (role: Role) => tiers[role] ?? settings.tiers[role];
  const changedBars = BARS.filter((k) => text(k) !== String(settings[k]));
  const changedTiers = RoleSchema.options.filter((r) => {
    const t = tierOf(r);
    return t.model !== settings.tiers[r].model || t.effort !== settings.tiers[r].effort;
  });
  const dirty = changedBars.length > 0 || changedTiers.length > 0;
  const touch = () => {
    if (state.kind !== "saving") setState(IDLE);
  };
  const discard = () => {
    setBars({});
    setTiers({});
    setShowErrors(false);
    setState(IDLE);
  };
  const submit = () => {
    setShowErrors(true);
    if (BARS.some((k) => value(k) === undefined) || !dirty) return;
    setState({ kind: "saving" });
    save.mutate(
      {
        ...Object.fromEntries(changedBars.map((k) => [k, value(k)])),
        ...(changedTiers.length > 0
          ? { tiers: Object.fromEntries(RoleSchema.options.map((r) => [r, tierOf(r)])) }
          : {}),
      },
      {
        onSuccess: () => {
          setBars({});
          setTiers({});
          setShowErrors(false);
          setState({ kind: "saved" });
        },
        onError: (e) => setState({ kind: "error", message: e.message, details: e.details }),
      },
    );
  };
  const setTier = (role: Role, tier: Tier) => {
    touch();
    setTiers((t) => ({ ...t, [role]: tier }));
  };
  return (
    <SaveSection
      title="When an answer counts"
      note="An answer that falls short, or says none of the options fits, is not used: the fallback is"
      dirty={dirty}
      state={state}
      onSave={submit}
      onDiscard={discard}
    >
      <div className="grid max-w-[640px] gap-3 @[480px]:grid-cols-2">
        {BARS.map((key) => (
          <Field
            key={key}
            label={BAR[key].label}
            hint={BAR[key].hint}
            error={showErrors && value(key) === undefined ? "Use a number from 0 to 1" : undefined}
          >
            {(p) => (
              <Input
                {...p}
                inputMode="decimal"
                className="w-28 font-mono"
                value={text(key)}
                onChange={(e) => {
                  touch();
                  setBars((b) => ({ ...b, [key]: e.target.value }));
                }}
              />
            )}
          </Field>
        ))}
      </div>
      <table aria-label="Fallback by role" className="w-full max-w-[640px] border-collapse text-sm">
        <thead>
          <tr className="text-left text-fg-faint">
            <th className="py-1 pr-2 font-normal">Role</th>
            <th className="py-1 pr-2 font-normal">Model fallback</th>
            <th className="py-1 font-normal">Effort fallback</th>
          </tr>
        </thead>
        <tbody>
          {RoleSchema.options.map((role) => {
            const tier = tierOf(role);
            return (
              <tr key={role} className="border-t border-line">
                <td className="py-1.5 pr-2 font-medium">{role}</td>
                <td className="py-1 pr-2">
                  <Select
                    aria-label={`${role} model fallback`}
                    value={tier.model}
                    onChange={(e) => setTier(role, { ...tier, model: ModelTierSchema.parse(e.target.value) })}
                  >
                    {ModelTierSchema.options.map((t) => (
                      <option key={t} value={t}>
                        {MODEL_TIER_LABEL[t]}
                      </option>
                    ))}
                  </Select>
                </td>
                <td className="py-1">
                  <Select
                    aria-label={`${role} effort fallback`}
                    value={tier.effort}
                    onChange={(e) =>
                      setTier(role, { ...tier, effort: EffortTierSchema.parse(e.target.value) })
                    }
                  >
                    {EffortTierSchema.options.map((t) => (
                      <option key={t} value={t}>
                        {EFFORT_TIER_LABEL[t]}
                      </option>
                    ))}
                  </Select>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="max-w-[72ch] text-sm text-fg-faint text-pretty">
        For an auto agent, the task's size moves its role's tiers one step: down for trivial or small work, up
        for large work. Models rank by the price table, else by the CLI's order. Workspaces and agents can
        override a role.
      </p>
    </SaveSection>
  );
}

type Bar = "min_lift" | "min_margin";
const BARS: readonly Bar[] = ["min_lift", "min_margin"];

function parseBar(text: string): number | undefined {
  const value = Number(text.trim().replace(",", "."));
  return text.trim() !== "" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

/** Laya in Docker says so in `detail`; the native one leaves it out of these states. */
function layaLine({ laya }: DecisionsStatus): string {
  switch (laya.state) {
    case "not-installed":
      return laya.detail ?? "Not installed. About 850 MB, once.";
    case "installing":
      return laya.detail ?? "Installing";
    case "downloading":
      return `Downloading the model${laya.progress === undefined ? "" : `, ${Math.round(laya.progress * 100)}%`}`;
    case "ready":
      return laya.detail ?? "Ready. The model loads on the first question.";
    case "loaded":
      return laya.detail ?? "Ready, model loaded";
    case "error":
    case "unsupported":
      return laya.detail ?? laya.state;
  }
}

function JevKey({ status }: { status: DecisionsStatus }) {
  const toast = useToast();
  const save = useSaveJevKey();
  const [value, setValue] = useState("");
  const has = status.settings.jev_key !== undefined;
  return (
    <form
      aria-label="Jev key"
      className="flex max-w-[640px] items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (value === "") return;
        save.mutate(value, {
          onSuccess: () => {
            setValue("");
            toast("Jev key saved");
          },
          onError: (e) => toast("Could not save the key", { detail: describeError(e), tone: "error" }),
        });
      }}
    >
      <Field
        label="Jev API key"
        className="flex-1"
        hint={has ? "A key is saved. Type a new one to replace it." : "Optional. Jev is off without a key."}
      >
        {(p) => (
          <Input
            {...p}
            type="password"
            autoComplete="off"
            className="font-mono"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        )}
      </Field>
      <Button type="submit" size="sm" disabled={value === "" || save.isPending}>
        Save key
      </Button>
    </form>
  );
}

/** Ask the decision model typed questions about some text (5.12). Also behind the palette's command. */
export function AskBox() {
  const ask = useAskDecision();
  const toast = useToast();
  const [state, setState] = useState("");
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState("");
  const list = options
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o !== "");
  const ready = state.trim() !== "" && question.trim() !== "" && list.length >= 2;
  const answer = ask.data?.answers.pick;
  return (
    <form
      aria-label="Ask the decision model"
      className="flex max-w-[640px] flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        ask.mutate(
          { state, questions: { pick: { type: "choice", instructions: question, options: list } } },
          { onError: (e) => toast("Could not ask", { detail: describeError(e), tone: "error" }) },
        );
      }}
    >
      <Field label="Text">
        {(p) => <Textarea {...p} rows={3} value={state} onChange={(e) => setState(e.target.value)} />}
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Question">
          {(p) => <Input {...p} value={question} onChange={(e) => setQuestion(e.target.value)} />}
        </Field>
        <Field label="Options, separated by commas">
          {(p) => (
            <Input
              {...p}
              className="font-mono"
              value={options}
              onChange={(e) => setOptions(e.target.value)}
            />
          )}
        </Field>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" variant="primary" disabled={!ready || ask.isPending}>
          {ask.isPending ? "Asking" : "Ask"}
        </Button>
        {answer && ask.data && (
          <p role="status" className="m-0 text-sm text-fg-muted">
            <strong className="text-fg">{String(answer.value)}</strong>, confidence{" "}
            {answer.confidence.toFixed(2)}, {NAME[ask.data.provider]}
            {ask.data.estimated ? " (estimated)" : ""}, {ask.data.durationMs} ms
            {answer.gate !== undefined &&
              `. ${answer.gate.accepted ? "Counts" : "Does not count"}: ${answer.gate.reason}`}
            {ask.data.skipped.length > 0 &&
              `. Skipped: ${ask.data.skipped.map((s) => `${NAME[s.provider]} (${s.reason})`).join("; ")}`}
          </p>
        )}
      </div>
    </form>
  );
}
