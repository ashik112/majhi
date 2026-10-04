import type { OpsActions, OpsPhoneSetupResult, OpsPhoneStatus, OpsSettings } from "@majhi/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { describeError } from "@/lib/errors";
import { formatAgo } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import {
  usePhoneForget,
  usePhoneSet,
  usePhoneSetup,
  usePhoneTest,
  useWatchSettings,
} from "@/lib/watch-queries";
import { QrCode } from "./qr";

const ACTION_ROWS: readonly { key: keyof OpsActions; label: string }[] = [
  { key: "approval", label: "Permission requests" },
  { key: "ship", label: "Work ready to merge" },
  { key: "draft", label: "Drafts for others" },
];

const MINUTES = [5, 10, 15, 30, 60] as const;

/** The push the owner just made. The topic is shown here once and never again. */
function JustSetUp({ result, onDone }: { result: OpsPhoneSetupResult; onDone: () => void }) {
  const test = usePhoneTest();
  const toast = useToast();
  return (
    <section aria-label="Scan to subscribe" className="flex flex-col gap-3 border-t border-line pt-4">
      <h3 className="m-0 text-base font-semibold text-fg">Scan this with the ntfy app</h3>
      <div className="flex flex-wrap items-start gap-4">
        <QrCode text={result.link} label="QR code that subscribes the ntfy app to your majhi topic" />
        <div className="flex min-w-[220px] flex-1 flex-col gap-2 text-base text-fg-soft text-pretty">
          <p className="m-0">
            Install ntfy on your phone (iOS or Android), tap +, and scan. Or add the topic by hand on{" "}
            <span className="font-mono">{new URL(result.server).host}</span>:
          </p>
          <code className="block rounded-md border border-line-strong bg-sunken px-2.5 py-1.5 font-mono text-sm break-all select-all text-fg">
            {result.topic}
          </code>
          <p className="m-0 text-sm text-amber text-pretty">
            This is the only time majhi shows it. Anyone who has it can read your pushes, so keep it to
            yourself. It is stored in secrets.age. Lost it? Set up again for a new one.
          </p>
        </div>
      </div>
      <div className="flex gap-2">
        <Button
          disabled={test.isPending}
          onClick={() =>
            test.mutate(undefined, {
              onSuccess: (r) =>
                toast(r.sent ? "Test push sent" : "The test did not go out", {
                  ...(r.error === undefined ? {} : { detail: r.error }),
                  ...(r.sent ? {} : { tone: "error" as const }),
                }),
            })
          }
        >
          Send a test
        </Button>
        <Button variant="primary" onClick={onDone}>
          I scanned it
        </Button>
      </div>
    </section>
  );
}

function PhoneOff({ onSetup }: { onSetup: (result: OpsPhoneSetupResult) => void }) {
  const setup = usePhoneSetup();
  const toast = useToast();
  const [own, setOwn] = useState(false);
  const [server, setServer] = useState("");
  const [token, setToken] = useState("");
  return (
    <section aria-label="Phone" className="flex flex-col gap-3 border-t border-line pt-4">
      <h3 className="m-0 text-base font-semibold text-fg">Phone</h3>
      <p className="m-0 text-base text-fg-soft text-pretty">
        Get a push when a high incident opens, and answer from your phone. It goes through ntfy, a free app
        that needs no account. majhi makes a long random topic, shows it once as a QR code and keeps it in
        secrets.age. A push holds only the workspace name and one line: no code, no secrets, no client data.
        Off until you set it up.
      </p>
      <Switch label="Use my own ntfy server" checked={own} onChange={setOwn} />
      {own && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Server">
            {(p) => (
              <Input
                {...p}
                type="url"
                value={server}
                placeholder="https://ntfy.acme.example"
                onChange={(e) => setServer(e.target.value)}
              />
            )}
          </Field>
          <Field label="Access token" hint="Only if the server needs one">
            {(p) => (
              <Input
                {...p}
                type="password"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            )}
          </Field>
        </div>
      )}
      <div>
        <Button
          variant="primary"
          disabled={setup.isPending || (own && server.trim() === "")}
          onClick={() =>
            setup.mutate(
              { ...(own ? { server: server.trim() } : {}), ...(own && token !== "" ? { token } : {}) },
              {
                onSuccess: onSetup,
                onError: (e) => toast("Could not set it up", { detail: describeError(e), tone: "error" }),
              },
            )
          }
        >
          Set up phone
        </Button>
      </div>
    </section>
  );
}

function PhoneOn({
  phone,
  onSetup,
}: {
  phone: OpsPhoneStatus;
  onSetup: (result: OpsPhoneSetupResult) => void;
}) {
  const set = usePhoneSet();
  const test = usePhoneTest();
  const forget = usePhoneForget();
  const setup = usePhoneSetup();
  const toast = useToast();
  const now = useNow(30_000);
  const [address, setAddress] = useState(phone.address ?? "");
  const [confirm, setConfirm] = useState(false);
  const fail = (e: unknown) => toast("Could not change it", { detail: describeError(e), tone: "error" });
  const hasAddress = phone.address !== undefined;
  return (
    <section aria-label="Phone" className="flex flex-col gap-3 border-t border-line pt-4">
      <div className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="m-0 text-base font-semibold text-fg">Phone</h3>
        <span className="min-w-0 text-sm text-fg-faint">
          {phone.server === undefined ? "" : new URL(phone.server).host}
          {phone.lastSentAt === undefined ? "" : ` · last push ${formatAgo(phone.lastSentAt, now)}`}
        </span>
        <div className="ml-auto">
          <Switch
            label="Send pushes"
            checked={phone.state === "on"}
            disabled={set.isPending}
            onChange={(enabled) => set.mutate({ enabled }, { onError: fail })}
          />
        </div>
      </div>
      {phone.lastError !== undefined && (
        <p
          role="alert"
          className="m-0 rounded-md border border-amber-line bg-amber-wash px-3 py-2 text-sm text-amber text-pretty"
        >
          {phone.lastError} The desktop alert still goes out. majhi tries again every half minute while an
          incident waits.
        </p>
      )}
      <div className="flex flex-col gap-2 rounded-md border border-line bg-sunken/40 px-3 py-2.5">
        <p className="m-0 text-sm text-fg-soft text-pretty">
          Buttons on a push (Acknowledge, Approve, Leave) call majhi from your phone. majhi is not on the
          internet, so they work only when your phone can reach it: on the same network (majhi has to listen
          on it) or through the opt-in tunnel. Without an address, a tap only opens the ntfy app. Each button
          works once and expires within an hour.
        </p>
        <Field
          label="Address your phone reaches majhi on"
          hint={hasAddress ? undefined : "Like http://192.168.1.20:7070"}
        >
          {(p) => (
            <div className="flex gap-2">
              <Input
                {...p}
                type="url"
                value={address}
                placeholder="http://192.168.1.20:7070"
                onChange={(e) => setAddress(e.target.value)}
              />
              <Button
                disabled={set.isPending || address.trim() === (phone.address ?? "")}
                onClick={() =>
                  set.mutate({ address: address.trim() === "" ? null : address.trim() }, { onError: fail })
                }
              >
                Save
              </Button>
            </div>
          )}
        </Field>
        <div className="flex flex-col">
          <span className="text-sm text-fg-faint">Also push, with Approve and Leave</span>
          <div className="flex flex-wrap gap-x-6">
            {ACTION_ROWS.map((a) => (
              <Switch
                key={a.key}
                label={a.label}
                checked={phone.actions[a.key]}
                disabled={set.isPending}
                onChange={(on) => set.mutate({ actions: { [a.key]: on } }, { onError: fail })}
              />
            ))}
          </div>
          {!hasAddress && (
            <p className="m-0 text-sm text-fg-faint text-pretty">
              With no address these pushes only open the ntfy app.
            </p>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={test.isPending}
          onClick={() =>
            test.mutate(undefined, {
              onSuccess: (r) =>
                toast(r.sent ? "Test push sent" : "The test did not go out", {
                  ...(r.error === undefined ? {} : { detail: r.error }),
                  ...(r.sent ? {} : { tone: "error" as const }),
                }),
            })
          }
        >
          Send a test
        </Button>
        <Button
          disabled={setup.isPending}
          onClick={() => setup.mutate({}, { onSuccess: onSetup, onError: fail })}
        >
          Set up again
        </Button>
        <Button variant="ghost" onClick={() => setConfirm(true)}>
          Turn off and forget
        </Button>
      </div>
      {confirm && (
        <ConfirmDialog
          title="Turn off the phone push?"
          body="majhi deletes the topic and every button link. The ntfy app keeps the old subscription, which now receives nothing."
          confirmLabel="Turn off"
          busy={forget.isPending}
          onCancel={() => setConfirm(false)}
          onConfirm={() => forget.mutate(undefined, { onSuccess: () => setConfirm(false), onError: fail })}
        />
      )}
    </section>
  );
}

/** How long an unanswered high incident waits, and how long checks stay green before one closes. */
function Timing({ settings }: { settings: OpsSettings }) {
  const save = useWatchSettings();
  const toast = useToast();
  const options = (current: number) => [...new Set<number>([...MINUTES, current])].sort((a, b) => a - b);
  const change = (patch: Partial<OpsSettings>) =>
    save.mutate(patch, {
      onError: (e) => toast("Could not save it", { detail: describeError(e), tone: "error" }),
    });
  return (
    <section aria-label="Timing" className="flex flex-col gap-3">
      <h3 className="m-0 text-base font-semibold text-fg">Alerts</h3>
      <p className="m-0 text-base text-fg-soft text-pretty">
        A high incident alerts your desktop at once, quiet hours or not. If nobody acknowledges it, majhi
        alerts once more and marks it in Decisions.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Alert again after">
          {(p) => (
            <Select
              {...p}
              value={settings.escalateMin}
              disabled={save.isPending}
              onChange={(e) => change({ escalateMin: Number(e.target.value) })}
            >
              {options(settings.escalateMin).map((m) => (
                <option key={m} value={m}>
                  {m} minutes
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Close after checks stay green for">
          {(p) => (
            <Select
              {...p}
              value={settings.resolveMin}
              disabled={save.isPending}
              onChange={(e) => change({ resolveMin: Number(e.target.value) })}
            >
              {options(settings.resolveMin).map((m) => (
                <option key={m} value={m}>
                  {m} minutes
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
    </section>
  );
}

/** Alerts and the phone push: the one place for how majhi reaches the owner about an outage. */
export function AlertsSheet({
  phone,
  settings,
  onClose,
}: {
  phone: OpsPhoneStatus;
  settings: OpsSettings;
  onClose: () => void;
}) {
  // The topic is shown once. It lives here, above the switch between the two phone states, so it
  // stays on screen while the status behind it changes from off to on.
  const [fresh, setFresh] = useState<OpsPhoneSetupResult>();
  return (
    <Sheet title="Alerts and phone" subtitle="How majhi reaches you when something breaks" onClose={onClose}>
      <div className="flex flex-col gap-5">
        <Timing settings={settings} />
        {fresh !== undefined ? (
          <JustSetUp result={fresh} onDone={() => setFresh(undefined)} />
        ) : phone.state === "off" ? (
          <PhoneOff onSetup={setFresh} />
        ) : (
          <PhoneOn phone={phone} onSetup={setFresh} />
        )}
      </div>
    </Sheet>
  );
}
