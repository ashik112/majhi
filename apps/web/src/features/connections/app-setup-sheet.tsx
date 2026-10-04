import type { AppSetupSaveResult, AppSetupView, ConnectAccess } from "@majhi/shared";
import { Check, Copy, ExternalLink, FileJson } from "lucide-react";
import { type DragEvent, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import { useAppSetup, useConnectCommand } from "@/lib/connect-queries";
import { describeError } from "@/lib/errors";
import { ScopeList } from "./connect-flow";

/** Google's client file is a few hundred bytes. Anything near this is not it. */
const JSON_MAX_BYTES = 64 * 1024;

function CopyValue({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md border border-line bg-sunken py-1 pr-1 pl-2.5">
      <span className="w-[130px] shrink-0 truncate text-sm text-fg-faint">{label}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-sm text-fg" title={value}>
        {value}
      </span>
      <Button
        size="sm"
        variant="ghost"
        aria-label={`Copy ${label}`}
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

/** A drop zone for Google's client file. The text stays in memory and is sent once; it is never shown. */
function FileDrop({
  label,
  help,
  fileName,
  onText,
}: {
  label: string;
  help: string;
  fileName: string | undefined;
  onText: (text: string, name: string) => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [problem, setProblem] = useState<string>();
  const take = (file: File | undefined) => {
    if (file === undefined) return;
    if (file.size > JSON_MAX_BYTES) {
      setProblem(`${file.name} is too big to be a client file.`);
      return;
    }
    setProblem(undefined);
    void file.text().then((text) => onText(text, file.name));
  };
  const drop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    take(event.dataTransfer.files[0]);
  };
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-sm text-fg-faint">{label}</span>
      <input
        ref={picker}
        type="file"
        accept=".json,application/json"
        tabIndex={-1}
        aria-hidden="true"
        className="hidden"
        onChange={(e) => {
          take(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <button
        type="button"
        onClick={() => picker.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
        className={cn(
          "flex min-h-[84px] w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed px-4 py-3 text-center",
          "focus-visible:outline-2 focus-visible:outline-accent",
          over ? "border-accent bg-accent-wash" : "border-line-strong bg-sunken hover:border-line-hover",
        )}
      >
        <FileJson aria-hidden="true" className="size-5 text-fg-faint" />
        {fileName === undefined ? (
          <span className="text-base text-fg-muted">Drop the JSON file here, or click to choose it</span>
        ) : (
          <span className="min-w-0 max-w-full truncate text-base text-fg">{fileName}</span>
        )}
      </button>
      <span className="text-sm text-fg-faint text-pretty">{help}</span>
      {problem !== undefined && (
        <p role="alert" className="text-sm text-red">
          {problem}
        </p>
      )}
    </div>
  );
}

/**
 * The guided setup of one app, once per workspace: numbered steps with the exact page to open and the
 * exact value to paste, then the one thing the owner brings back (a client file, an ID, tokens). The
 * values go to secrets.age and are never shown again. `onDone` leaves the sheet.
 */
export function AppSetupSheet({
  org,
  app,
  access,
  serviceName,
  onDone,
}: {
  org: string;
  app: string;
  access: ConnectAccess;
  serviceName: string;
  onDone: (saved: boolean) => void;
}) {
  const setup = useAppSetup(org, app, access);
  const save = useConnectCommand("connect.appSave");
  const [values, setValues] = useState<Record<string, string>>({});
  const [fileName, setFileName] = useState<string>();
  const [result, setResult] = useState<AppSetupSaveResult>();
  const [copiedManifest, setCopiedManifest] = useState(false);
  const view: AppSetupView | undefined = setup.data;

  if (view === undefined) {
    return (
      <p
        role={setup.isError ? "alert" : "status"}
        className={cn("text-base", setup.isError ? "text-red" : "text-fg-muted")}
      >
        {setup.isError ? describeError(setup.error) : "Loading the setup"}
      </p>
    );
  }
  if (result !== undefined) {
    return (
      <div role="status" className="flex max-w-[620px] flex-col gap-3">
        <p className="flex items-center gap-2 text-md font-semibold text-green">
          <Check aria-hidden="true" className="size-4" />
          {view.finishes === "tokens" ? `${serviceName} is connected` : "The app is saved"}
        </p>
        <p className="text-base text-fg-muted text-pretty">{result.message}</p>
        <div className="flex flex-wrap items-center gap-2">
          {result.next !== undefined && (
            <Button variant="primary" asChild>
              <a href={result.next.url} target="_blank" rel="noreferrer noopener">
                <ExternalLink aria-hidden="true" />
                {result.next.label}
              </a>
            </Button>
          )}
          <Button variant={result.next === undefined ? "primary" : "secondary"} onClick={() => onDone(true)}>
            {view.finishes === "tokens" ? "Done" : "Continue"}
          </Button>
        </div>
      </div>
    );
  }
  const ready = view.inputs.every((i) => (values[i.key] ?? "").trim() !== "");
  const submit = () => save.mutate({ org, app, values, access }, { onSuccess: (out) => setResult(out) });

  return (
    <div className="flex max-w-[660px] flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <h3 className="text-md font-semibold">{view.title}</h3>
        <p className="text-base text-fg-muted text-pretty">{view.intro}</p>
        {view.saved && (
          <p className="text-sm text-amber text-pretty">
            An app is already saved for this workspace. Saving again replaces it.
          </p>
        )}
      </div>

      <section aria-label="What it can do" className="flex flex-col gap-2">
        <h4 className="text-sm font-medium text-fg-soft">What the app may do</h4>
        <ScopeList scopes={view.scopes} />
      </section>

      <ol aria-label="Steps" className="flex flex-col gap-4">
        {view.steps.map((step) => (
          <li key={step.n} className="flex gap-3">
            <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-line-strong font-mono text-xs text-fg-muted">
              {step.n}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <p className="text-base font-medium text-fg">{step.title}</p>
              {step.body !== "" && <p className="text-base text-fg-muted text-pretty">{step.body}</p>}
              {step.links.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {step.links.map((link) => (
                    <Button key={link.url} size="sm" asChild>
                      <a href={link.url} target="_blank" rel="noreferrer noopener">
                        <ExternalLink aria-hidden="true" />
                        {link.label}
                      </a>
                    </Button>
                  ))}
                </div>
              )}
              {step.values.map((v) => (
                <CopyValue key={v.label} label={v.label} value={v.value} />
              ))}
              {step.n === 1 && view.manifest !== undefined && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="self-start"
                  onClick={() => {
                    void navigator.clipboard?.writeText(view.manifest?.json ?? "").then(() => {
                      setCopiedManifest(true);
                      setTimeout(() => setCopiedManifest(false), 1500);
                    });
                  }}
                >
                  {copiedManifest ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                  {copiedManifest ? "Manifest copied" : "Copy the manifest"}
                </Button>
              )}
            </div>
          </li>
        ))}
      </ol>

      <form
        className="flex flex-col gap-3 border-t border-line pt-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && !save.isPending) submit();
        }}
      >
        {view.inputs.map((input) =>
          input.kind === "google-json" ? (
            <FileDrop
              key={input.key}
              label={input.label}
              help={input.help}
              fileName={fileName}
              onText={(text, name) => {
                setValues((v) => ({ ...v, [input.key]: text }));
                setFileName(name);
              }}
            />
          ) : (
            <Field key={input.key} label={input.label} hint={input.help}>
              {(p) => (
                <Input
                  {...p}
                  type={input.kind === "secret" ? "password" : "text"}
                  autoComplete={input.kind === "secret" ? "new-password" : "off"}
                  spellCheck={false}
                  className="font-mono"
                  placeholder={input.placeholder}
                  value={values[input.key] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [input.key]: e.target.value }))}
                />
              )}
            </Field>
          ),
        )}
        {save.error && (
          <p role="alert" className="text-base text-red text-pretty">
            {describeError(save.error)}
          </p>
        )}
        <div className="flex items-center gap-2">
          <Button type="submit" variant="primary" disabled={!ready || save.isPending}>
            {save.isPending
              ? "Checking"
              : view.finishes === "tokens"
                ? `Connect ${serviceName}`
                : "Save the app"}
          </Button>
          <Button type="button" variant="ghost" onClick={() => onDone(false)}>
            Back
          </Button>
        </div>
      </form>
    </div>
  );
}
