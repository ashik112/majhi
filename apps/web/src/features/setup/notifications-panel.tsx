import {
  NOTIFY_KIND_LABEL,
  type NotificationsPatch,
  type NotificationsSettings,
  type NotifyKind,
  NotifyKindSchema,
} from "@majhi/shared";
import { Bell } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SaveSection, type SaveState } from "@/components/ui/save-section";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { useSaveSettings } from "@/lib/boss-queries";
import { currentPermission, useNotifyPrompt } from "@/lib/browser-notify";
import { describeError } from "@/lib/errors";
import { useSendTestNotification } from "@/lib/ops-queries";

const IDLE: SaveState = { kind: "idle" };
const DEFAULT_FROM = "22:00";
const DEFAULT_TO = "07:00";

interface Form {
  mac: boolean;
  browser: boolean;
  sound: boolean;
  muted: readonly NotifyKind[];
  quiet: boolean;
  from: string;
  to: string;
}

function formOf(saved: NotificationsSettings): Form {
  return {
    mac: saved.mac,
    browser: saved.browser,
    sound: saved.sound,
    muted: saved.muted,
    quiet: saved.quiet_from !== undefined && saved.quiet_to !== undefined,
    from: saved.quiet_from ?? DEFAULT_FROM,
    to: saved.quiet_to ?? DEFAULT_TO,
  };
}

/** Only what changed. Quiet hours carry this browser's time zone, since the server may run in another. */
export function patchOf(saved: NotificationsSettings, form: Form): NotificationsPatch {
  const patch: NotificationsPatch = {};
  const before = formOf(saved);
  if (form.mac !== before.mac) patch.mac = form.mac;
  if (form.browser !== before.browser) patch.browser = form.browser;
  if (form.sound !== before.sound) patch.sound = form.sound;
  if (form.muted.join() !== before.muted.join()) patch.muted = [...form.muted];
  if (form.quiet !== before.quiet || (form.quiet && (form.from !== before.from || form.to !== before.to))) {
    if (form.quiet) {
      patch.quiet_from = form.from;
      patch.quiet_to = form.to;
      patch.quiet_tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } else {
      patch.quiet_from = null;
      patch.quiet_to = null;
      patch.quiet_tz = null;
    }
  }
  return patch;
}

const CLOCK = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/**
 * When majhi tells you: a desktop banner and a browser notification, per kind, with quiet hours and a
 * test. The form keeps the setting's name, `mac`, on every OS.
 */
export function NotificationsSection({ saved }: { saved: NotificationsSettings }) {
  const save = useSaveSettings();
  const test = useSendTestNotification();
  const toast = useToast();
  const [edits, setEdits] = useState<Partial<Form>>({});
  const [state, setState] = useState<SaveState>(IDLE);
  const [result, setResult] = useState<string>();
  const form: Form = { ...formOf(saved), ...edits };
  const patch = patchOf(saved, form);
  const dirty = Object.keys(patch).length > 0;
  const badClock = form.quiet && !(CLOCK.test(form.from) && CLOCK.test(form.to));
  const prompt = useNotifyPrompt(true);
  const permission = currentPermission();

  function set<K extends keyof Form>(key: K, value: Form[K]) {
    if (state.kind !== "saving") setState(IDLE);
    setEdits((e) => ({ ...e, [key]: value }));
  }

  function onSave() {
    if (!dirty || badClock) return;
    setState({ kind: "saving" });
    save.mutate(
      { notifications: patch },
      {
        onSuccess: () => {
          setEdits({});
          setState({ kind: "saved" });
        },
        onError: (e) => setState({ kind: "error", message: e.message, details: e.details }),
      },
    );
  }

  function sendTest() {
    setResult(undefined);
    test.mutate(undefined, {
      onSuccess: (out) => {
        const desktop =
          out.desktop === "sent"
            ? "Sent to this computer."
            : out.desktop === "no-helper"
              ? "The host helper is not connected, so this computer got nothing."
              : out.desktop === "failed"
                ? `This computer did not show it. ${out.error ?? ""}`.trim()
                : "Desktop notifications are off.";
        const browser = !out.browser
          ? "Browser notifications are off."
          : permission === "granted"
            ? "Sent to this browser."
            : "This browser has not allowed notifications yet.";
        setResult(`${desktop} ${browser}`);
      },
      onError: (e) => toast("Could not send the test", { detail: describeError(e), tone: "error" }),
    });
  }

  return (
    <SaveSection
      title="Notifications"
      note="Saved to majhi.yaml, as a change you can undo"
      className="border-t-0"
      dirty={dirty}
      state={state}
      onSave={onSave}
      onDiscard={() => {
        setEdits({});
        setState(IDLE);
      }}
    >
      <form
        aria-label="Notification settings"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          onSave();
        }}
        className="flex max-w-[640px] flex-col gap-5"
      >
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-sm font-medium text-fg-muted">Where</legend>
          <Switch
            label="On this computer, through the host helper"
            checked={form.mac}
            onChange={(v) => set("mac", v)}
          />
          <Switch
            label="In this browser, while a majhi tab is open"
            checked={form.browser}
            onChange={(v) => set("browser", v)}
          />
          <Switch label="Play a sound" checked={form.sound} onChange={(v) => set("sound", v)} />
          {form.browser && permission !== "granted" && (
            <p className="flex flex-wrap items-center gap-2 text-sm text-fg-faint">
              {permission === "denied"
                ? "This browser blocks notifications for majhi. Allow them in the site settings of the address bar."
                : permission === "unsupported"
                  ? "This browser cannot show notifications."
                  : "The browser has not allowed notifications yet."}
              {permission === "default" && (
                <Button size="sm" onClick={prompt.enable}>
                  Allow in this browser
                </Button>
              )}
            </p>
          )}
        </fieldset>

        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-sm font-medium text-fg-muted">What</legend>
          {NotifyKindSchema.options.map((kind) => (
            <Switch
              key={kind}
              label={NOTIFY_KIND_LABEL[kind]}
              checked={!form.muted.includes(kind)}
              onChange={(on) =>
                set("muted", on ? form.muted.filter((k) => k !== kind) : [...form.muted, kind])
              }
            />
          ))}
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium text-fg-muted">Quiet hours</legend>
          <Switch
            label="Hold notifications at night"
            checked={form.quiet}
            onChange={(v) => set("quiet", v)}
          />
          {form.quiet && (
            <div className="grid max-w-[360px] grid-cols-2 gap-3">
              <Field label="From" {...(badClock ? { error: "Use a time like 22:00" } : {})}>
                {(p) => (
                  <Input {...p} type="time" value={form.from} onChange={(e) => set("from", e.target.value)} />
                )}
              </Field>
              <Field label="Until">
                {(p) => (
                  <Input {...p} type="time" value={form.to} onChange={(e) => set("to", e.target.value)} />
                )}
              </Field>
            </div>
          )}
          <p className="text-sm text-fg-faint">
            Things that need you still wait in the board and the banner. Only the pop-ups are held.
          </p>
        </fieldset>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={sendTest} disabled={test.isPending || dirty}>
            <Bell aria-hidden="true" />
            Send a test notification
          </Button>
          {dirty && (
            <span className="text-sm text-fg-faint">Save first: the test uses the saved settings.</span>
          )}
          {result !== undefined && (
            <p role="status" className="text-sm text-fg-soft">
              {result}
            </p>
          )}
        </div>
        <button type="submit" hidden />
      </form>
    </SaveSection>
  );
}
