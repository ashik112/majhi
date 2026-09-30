import {
  EFFORT_TIER_LABEL,
  EffortTierSchema,
  MODEL_TIER_LABEL,
  ModelTierSchema,
  type ProviderId,
  type Role,
  RoleSchema,
  type Tier,
} from "@majhi/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, Textarea } from "@/components/ui/select";
import { Dot } from "@/components/ui/status-dot";
import { useToast } from "@/components/ui/toast";
import {
  type DecisionsStatus,
  useAskDecision,
  useDecisionsStatus,
  useInstallLaya,
  useRecentDecisions,
  useSaveJevKey,
  useSetDecisions,
} from "@/lib/decisions-queries";
import { describeError } from "@/lib/errors";

const NAME: Record<ProviderId, string> = {
  laya: "Laya",
  jev: "Jev",
  acp: "Stand-in agent",
  rules: "Rules",
};
const ALL: readonly ProviderId[] = ["laya", "jev", "acp", "rules"];

/** The decision provider: who answers small typed questions, in what order, and a box to try it. */
export function DecisionsPanel() {
  const status = useDecisionsStatus();
  return (
    <section aria-label="Decisions" className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <h2 className="text-md font-semibold">Decisions</h2>
        <span className="text-sm text-fg-faint">Quick picks for agents, tried in this order</span>
      </div>
      {status.isPending && <p className="text-sm text-fg-faint">Loading</p>}
      {status.isError && <p className="text-sm text-red">{describeError(status.error)}</p>}
      {status.data && (
        <div className="flex flex-col gap-3 rounded-[10px] border border-line-strong bg-raised p-3">
          <Providers status={status.data} />
          <Picks status={status.data} />
          <JevKey status={status.data} />
          <AskBox />
          <Recent />
        </div>
      )}
    </section>
  );
}

function Providers({ status }: { status: DecisionsStatus }) {
  const toast = useToast();
  const save = useSetDecisions();
  const install = useInstallLaya();
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

  return (
    <div className="flex flex-col gap-1.5">
      <ol aria-label="Provider order" className="m-0 flex list-none flex-col gap-1.5 p-0">
        {order.map((id, i) => {
          const p = info(id);
          return (
            <li key={id} className="flex items-center gap-2">
              <Dot tone={p?.available ? "green" : "neutral"} />
              <span className="w-[110px] shrink-0 text-base font-semibold">{NAME[id]}</span>
              <span className="min-w-0 flex-1 truncate text-sm text-fg-muted">
                {id === "laya" ? layaLine(status) : (p?.detail ?? "")}
              </span>
              <Button
                size="sm"
                aria-label={`Move ${NAME[id]} up`}
                disabled={i === 0}
                onClick={() => move(i, -1)}
              >
                Up
              </Button>
              <Button
                size="sm"
                aria-label={`Move ${NAME[id]} down`}
                disabled={i === order.length - 1}
                onClick={() => move(i, 1)}
              >
                Down
              </Button>
              <Button
                size="sm"
                aria-label={`Turn ${NAME[id]} off`}
                disabled={order.length === 1}
                onClick={() => change(order.filter((o) => o !== id))}
              >
                Off
              </Button>
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
      {(laya.state === "not-installed" || laya.state === "error") && (
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
  const toast = useToast();
  const save = useSetDecisions();
  const { settings } = status;
  const failed = (e: unknown) => toast("Could not save", { detail: describeError(e), tone: "error" });
  const setBar = (key: "min_lift" | "min_margin", text: string) => {
    const value = Number(text);
    if (text.trim() === "" || !Number.isFinite(value) || value < 0 || value > 1) return;
    if (value !== settings[key]) save.mutate({ [key]: value }, { onError: failed });
  };
  const setTier = (role: Role, tier: Tier) =>
    save.mutate({ tiers: { ...settings.tiers, [role]: tier } }, { onError: failed });
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-base font-semibold">When an answer counts</h3>
      <p className="m-0 text-sm text-fg-faint">
        An answer that falls short, or says none of the options fits, is not used: the fallback is.
      </p>
      <div className="grid grid-cols-2 gap-2">
        {(["min_lift", "min_margin"] as const).map((key) => (
          <Field key={`${key}-${settings[key]}`} label={BAR[key].label} hint={BAR[key].hint}>
            {(p) => (
              <Input
                {...p}
                type="number"
                min={0}
                max={1}
                step={0.05}
                defaultValue={settings[key]}
                onBlur={(e) => setBar(key, e.target.value)}
              />
            )}
          </Field>
        ))}
      </div>
      <table aria-label="Fallback by role" className="w-full border-collapse text-sm">
        <thead>
          <tr className="text-left text-fg-faint">
            <th className="py-1 pr-2 font-normal">Role</th>
            <th className="py-1 pr-2 font-normal">Model fallback</th>
            <th className="py-1 font-normal">Effort fallback</th>
          </tr>
        </thead>
        <tbody>
          {RoleSchema.options.map((role) => {
            const tier = settings.tiers[role];
            return (
              <tr key={role}>
                <td className="py-1 pr-2 font-semibold">{role}</td>
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
      <p className="m-0 text-sm text-fg-faint">
        For an auto agent, the task's size moves its role's tiers one step: down for trivial or small work, up
        for large work. Models rank by the price table, else by the CLI's order. Orgs and agents can override
        a role.
      </p>
    </div>
  );
}

function layaLine({ laya }: DecisionsStatus): string {
  switch (laya.state) {
    case "not-installed":
      return "Not installed. About 850 MB, once.";
    case "installing":
      return laya.detail ?? "Installing";
    case "downloading":
      return `Downloading the model${laya.progress === undefined ? "" : `, ${Math.round(laya.progress * 100)}%`}`;
    case "ready":
      return "Ready. The model loads on the first question.";
    case "loaded":
      return "Ready, model loaded";
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
      className="flex items-end gap-2"
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

function AskBox() {
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
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        ask.mutate(
          { state, questions: { pick: { type: "choice", instructions: question, options: list } } },
          { onError: (e) => toast("Could not ask", { detail: describeError(e), tone: "error" }) },
        );
      }}
    >
      <h3 className="text-base font-semibold">Ask the decision model</h3>
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
            {ask.data.skipped.length > 0 &&
              `. Skipped: ${ask.data.skipped.map((s) => `${NAME[s.provider]} (${s.reason})`).join("; ")}`}
          </p>
        )}
      </div>
    </form>
  );
}

function Recent() {
  const recent = useRecentDecisions();
  if (!recent.data || recent.data.length === 0)
    return <p className="m-0 text-sm text-fg-faint">No decisions yet.</p>;
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-base font-semibold">Recent decisions</h3>
      <ul aria-label="Recent decisions" className="m-0 flex list-none flex-col gap-1 p-0">
        {recent.data.map((d) => (
          <li key={d.id} className="flex gap-2 text-sm text-fg-muted">
            <span className="w-[90px] shrink-0">{NAME[d.provider]}</span>
            <span className="min-w-0 flex-1 truncate font-mono">
              {Object.entries(d.answers)
                .map(([k, a]) => `${k}=${String(a.value)}`)
                .join(" ")}
            </span>
            <span className="shrink-0 text-fg-faint">{d.use}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
