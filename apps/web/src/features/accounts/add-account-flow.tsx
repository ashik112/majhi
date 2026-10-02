import type { HealthCheck } from "@majhi/shared";
import { type AuthMode, IdSchema, PRIVATE, type ToolId, type ToolInfo } from "@majhi/shared";
import { type FormEvent, lazy, type ReactNode, Suspense, useEffect, useRef, useState } from "react";
import { CommandLine } from "@/components/command-line";
import { Button } from "@/components/ui/button";
import { ChoiceGroup } from "@/components/ui/choice-group";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { type LoginState, nextLoginState, type TerminalEvent } from "@/features/terminal/terminal-model";
import { describeError } from "@/lib/errors";
import {
  useAccountHealth,
  useCreateAccount,
  useOrgs,
  useStartLogin,
  useSuggestAccountId,
  useTools,
} from "@/lib/studio-queries";
import { HealthSteps } from "./health-steps";
import { defaultOrgId } from "./model";
import { NewOrgForm } from "./new-org-form";

// xterm is about 300 kB, so it loads only when a sign-in terminal opens.
const TerminalView = lazy(() =>
  import("@/features/terminal/terminal-view").then((m) => ({ default: m.TerminalView })),
);

const NEW_ORG = "__new__";

export type Stage =
  | { kind: "form" }
  | {
      kind: "login";
      accountId: string;
      loginHint: string;
      terminalId: string;
      command: string;
      state: LoginState;
    }
  | { kind: "checking"; accountId: string }
  | { kind: "result"; accountId: string; health: HealthCheck }
  /** The account exists but a step after creating it failed before any health result. */
  | { kind: "stuck"; accountId: string; mode: AuthMode; loginHint: string; message: string };

export interface AddAccountFlowProps {
  /** Called once when the new account passes its health check. */
  onHealthy?: (accountId: string) => void;
  /** The org to preselect, like the org filter's. Default: Private, or the only other org. */
  defaultOrg?: string | undefined;
  /** What to offer after a healthy account: "Create an agent", "Continue". */
  renderDone: (accountId: string, addAnother: () => void) => ReactNode;
}

/**
 * SPEC 3.3 add-account flow: tool, org (Private by default), id, then sign in through a terminal or paste
 * an API key. The account is created first; every later step can be retried without re-adding it.
 */
export function AddAccountFlow({ onHealthy, renderDone, defaultOrg }: AddAccountFlowProps) {
  const tools = useTools();
  const [stage, setStage] = useState<Stage>({ kind: "form" });
  const announced = useRef<string | undefined>(undefined);

  const healthyId = stage.kind === "result" && stage.health.ok ? stage.accountId : undefined;
  const loginId = stage.kind === "login" && stage.state.phase === "signed-in" ? stage.accountId : undefined;
  const doneId = healthyId ?? loginId;
  useEffect(() => {
    if (doneId && announced.current !== doneId) {
      announced.current = doneId;
      onHealthy?.(doneId);
    }
  }, [doneId, onHealthy]);

  if (tools.isError) {
    return (
      <p role="alert" className="text-base text-red">
        Could not load the tools: {describeError(tools.error)}
      </p>
    );
  }
  if (!tools.data) return <p className="text-base text-fg-faint">Loading tools</p>;

  if (stage.kind === "form") {
    return <AccountForm tools={tools.data} defaultOrg={defaultOrg} onCreated={(next) => setStage(next)} />;
  }

  if (doneId) {
    return (
      <div className="flex flex-col gap-4">
        <p role="status" className="text-base font-medium text-green">
          {doneId} is signed in and healthy
        </p>
        {stage.kind === "result" && <HealthSteps health={stage.health} />}
        {stage.kind === "login" && stage.state.phase === "signed-in" && (
          <HealthSteps health={stage.state.health} />
        )}
        {renderDone(doneId, () => setStage({ kind: "form" }))}
      </div>
    );
  }

  return <AccountProgress stage={stage} setStage={setStage} />;
}

function AccountForm({
  tools,
  defaultOrg,
  onCreated,
}: {
  tools: ToolInfo[];
  defaultOrg: string | undefined;
  onCreated: (stage: Stage) => void;
}) {
  const orgs = useOrgs();
  const [toolId, setToolId] = useState<ToolId | undefined>(tools[0]?.id);
  const [pickedOrg, setOrg] = useState<string>();
  const org = pickedOrg ?? defaultOrgId(orgs.data ?? [], defaultOrg);
  const [id, setId] = useState("");
  const [idEdited, setIdEdited] = useState(false);
  const [auth, setAuth] = useState<AuthMode>("login");
  const [apiKey, setApiKey] = useState("");
  const [problem, setProblem] = useState<string>();

  const tool = tools.find((t) => t.id === toolId);
  const suggestion = useSuggestAccountId(toolId ?? "", org === NEW_ORG ? "" : org);
  const shownId = idEdited ? id : (suggestion.data?.id ?? "");
  const create = useCreateAccount();
  const login = useStartLogin();
  const health = useAccountHealth();

  // A tool that lacks the chosen mode falls back to one it has.
  const modes = tool?.authModes ?? [];
  const effectiveAuth: AuthMode = modes.includes(auth) ? auth : (modes[0] ?? "login");
  const busy = create.isPending || login.isPending || health.isPending;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!tool || busy) return;
    const parsedId = IdSchema.safeParse(shownId);
    if (!parsedId.success) return setProblem(parsedId.error.issues[0]?.message ?? "Invalid id");
    if (org === NEW_ORG) return setProblem("Create the workspace first, or pick another");
    if (effectiveAuth === "api-key" && apiKey.trim().length < 8) return setProblem("Paste the API key");
    setProblem(undefined);

    let accountId: string;
    try {
      const account = await create.mutateAsync({
        id: parsedId.data,
        tool: tool.id,
        org,
        auth: effectiveAuth,
        ...(effectiveAuth === "api-key" ? { apiKey: apiKey.trim() } : {}),
      });
      accountId = account.id;
    } catch (error) {
      return setProblem(describeError(error));
    }
    // The key is stored server side; drop it from the page.
    setApiKey("");

    try {
      if (effectiveAuth === "login") {
        const started = await login.mutateAsync(accountId);
        onCreated({
          kind: "login",
          accountId,
          loginHint: tool.loginHint,
          terminalId: started.terminalId,
          command: started.command,
          state: { phase: "running" },
        });
      } else {
        onCreated({ kind: "checking", accountId });
        const result = await health.mutateAsync(accountId);
        onCreated({ kind: "result", accountId, health: result.health });
      }
    } catch (error) {
      onCreated({
        kind: "stuck",
        accountId,
        mode: effectiveAuth,
        loginHint: tool.loginHint,
        message: describeError(error),
      });
    }
  }

  return (
    <form onSubmit={submit} aria-label="Add an account" className="flex flex-col gap-4">
      <ChoiceGroup
        label="Tool"
        value={toolId}
        onChange={setToolId}
        choices={tools.map((t) => ({ value: t.id, label: t.name }))}
      />
      <Field label="Belongs to">
        {(p) => (
          <Select {...p} value={org} onChange={(e) => setOrg(e.target.value)}>
            {(orgs.data ?? []).map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
            <option value={NEW_ORG}>New workspace...</option>
          </Select>
        )}
      </Field>
      {org === NEW_ORG && (
        <NewOrgForm
          orgCount={orgs.data?.length ?? 0}
          onCreated={(orgId) => setOrg(orgId)}
          onCancel={() => setOrg(PRIVATE)}
        />
      )}
      <Field label="Account id" hint="Suggested from the tool and workspace. You can change it.">
        {(p) => (
          <Input
            {...p}
            className="font-mono"
            value={shownId}
            onChange={(e) => {
              setIdEdited(true);
              setId(e.target.value);
            }}
          />
        )}
      </Field>
      {modes.length > 1 && (
        <ChoiceGroup
          label="How it signs in"
          value={effectiveAuth}
          onChange={setAuth}
          choices={modes.map((m) => ({ value: m, label: m === "login" ? "Sign in" : "API key" }))}
        />
      )}
      {effectiveAuth === "api-key" && tool && (
        <Field label={tool.apiKeyLabel} hint="Stored encrypted. It is never shown again.">
          {(p) => (
            <Input
              {...p}
              type="password"
              autoComplete="new-password"
              className="font-mono"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          )}
        </Field>
      )}
      {problem && (
        <p role="alert" className="text-base text-red text-pretty">
          {problem}
        </p>
      )}
      <Button type="submit" variant="primary" disabled={busy || org === NEW_ORG || !tool}>
        {effectiveAuth === "login" ? "Add account and sign in" : "Add account and check it"}
      </Button>
    </form>
  );
}

/** Every stage after the form. */
export type ProgressStage = Exclude<Stage, { kind: "form" }>;

export function AccountProgress({
  stage,
  setStage,
}: {
  stage: ProgressStage;
  setStage: (stage: ProgressStage) => void;
}) {
  const login = useStartLogin();
  const health = useAccountHealth();

  async function checkAgain(accountId: string, loginHint: string) {
    setStage({ kind: "checking", accountId });
    try {
      const result = await health.mutateAsync(accountId);
      setStage({ kind: "result", accountId, health: result.health });
    } catch (error) {
      setStage({ kind: "stuck", accountId, mode: "api-key", loginHint, message: describeError(error) });
    }
  }

  async function signInAgain(accountId: string, loginHint: string) {
    try {
      const started = await login.mutateAsync(accountId);
      setStage({
        kind: "login",
        accountId,
        loginHint,
        terminalId: started.terminalId,
        command: started.command,
        state: { phase: "running" },
      });
    } catch (error) {
      setStage({ kind: "stuck", accountId, mode: "login", loginHint, message: describeError(error) });
    }
  }

  if (stage.kind === "checking") {
    return (
      <p role="status" className="text-base text-fg-muted">
        Checking {stage.accountId}
      </p>
    );
  }

  if (stage.kind === "stuck") {
    return (
      <div className="flex flex-col gap-3">
        <p role="alert" className="text-base text-red text-pretty">
          {stage.accountId} was added, but the next step failed: {stage.message}
        </p>
        <div>
          <Button
            onClick={() =>
              stage.mode === "login"
                ? void signInAgain(stage.accountId, stage.loginHint)
                : void checkAgain(stage.accountId, stage.loginHint)
            }
          >
            Retry
          </Button>
        </div>
      </div>
    );
  }

  if (stage.kind === "result") {
    return (
      <div className="flex flex-col gap-3">
        <HealthSteps health={stage.health} />
        <div>
          <Button onClick={() => void checkAgain(stage.accountId, "")}>Retry</Button>
        </div>
      </div>
    );
  }

  const onEvent = (event: TerminalEvent) => setStage({ ...stage, state: nextLoginState(stage.state, event) });
  const failed = stage.state.phase === "failed" ? stage.state : undefined;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-base text-fg-soft text-pretty">{stage.loginHint}</p>
      <CommandLine command={stage.command} />
      <Suspense fallback={<p className="text-sm text-fg-faint">Opening the terminal</p>}>
        <TerminalView
          key={stage.terminalId}
          terminalId={stage.terminalId}
          onEvent={onEvent}
          label="Sign-in terminal"
          className="h-[260px]"
        />
      </Suspense>
      {stage.state.phase === "running" && (
        <p className="text-sm text-fg-faint">Waiting for the sign-in to finish.</p>
      )}
      {failed && (
        <div className="flex flex-col gap-3" role="alert">
          <p className="text-base text-red">
            {failed.health
              ? "Signed in, but the health check failed."
              : `The sign-in ended with exit code ${failed.code}.`}
          </p>
          {failed.health && <HealthSteps health={failed.health} />}
          <div className="flex gap-2">
            <Button onClick={() => void signInAgain(stage.accountId, stage.loginHint)}>Retry sign-in</Button>
            <Button variant="ghost" onClick={() => void checkAgain(stage.accountId, stage.loginHint)}>
              Run the check again
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
