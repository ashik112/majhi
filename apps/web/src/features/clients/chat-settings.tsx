import {
  CHAT_APP_LABEL,
  CHAT_RULES_MAX,
  type ChatSettingsView,
  HOLD_CLASSES,
  HOLD_LABEL,
  type HoldClass,
  type Keep,
  type Notify,
  type PersonRole,
  type ReplyLimit,
  type ReplyWhen,
} from "@majhi/shared";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { SectionLabel } from "@/components/ui/section-label";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { useToast } from "@/components/ui/toast";
import { Cell } from "@/features/captain/delegation";
import {
  useChatHolder,
  useChatSettings,
  useKeepCount,
  useSendAs,
  useSetChatSettings,
  useSetPerson,
  useUnlinkChat,
} from "@/lib/client-queries";
import { describeError } from "@/lib/errors";

/** Search shows above this many people. */
const SEARCH_OVER = 20;

const SELECT = "h-8 px-2 text-sm";

/** One setting: its name and a line under it on the left, its control on the right. */
function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 border-b border-line py-2">
      <div className="flex min-w-0 flex-1 flex-col pr-2 leading-snug">
        <span className="text-base text-fg">{label}</span>
        {hint !== undefined && <span className="text-xs text-fg-faint">{hint}</span>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Section({ children }: { children: ReactNode }) {
  return <SectionLabel className="block pt-5 pb-1">{children}</SectionLabel>;
}

const LIMIT_OPTIONS: readonly { value: string; label: string }[] = [
  { value: "20", label: "20" },
  { value: "50", label: "50" },
  { value: "100", label: "100" },
  { value: "none", label: "No limit" },
];

const KEEP_OPTIONS: readonly { value: string; label: string }[] = [
  { value: "all", label: "All" },
  { value: "500", label: "Last 500" },
  { value: "100", label: "Last 100" },
];

const NOTIFY_OPTIONS: readonly { value: Notify; label: string }[] = [
  { value: "needs-me", label: "When it needs me" },
  { value: "every", label: "Every message" },
  { value: "never", label: "Never" },
];

const ROLE_OPTIONS: readonly { value: PersonRole; label: string }[] = [
  { value: "client", label: "Client" },
  { value: "us", label: "Us" },
  { value: "muted", label: "Muted" },
];

const limitOf = (value: string): ReplyLimit =>
  value === "none" ? "none" : value === "20" ? 20 : value === "100" ? 100 : 50;
const keepOf = (value: string): Keep => (value === "500" ? 500 : value === "100" ? 100 : "all");
/** How much a Keep choice removes: lowering is moving to a bigger rank. */
const KEEP_RANK: Record<string, number> = { all: 0, "500": 1, "100": 2 };

/**
 * The settings of one client chat, the same sheet for every chat app. Each control saves at once. Who replies now
 * is the chat's holder, Send as is the chat's `sendAs`; the rest are the chat's own settings.
 */
export function ChatSettingsSheet({
  room,
  orgName,
  onClose,
}: {
  room: string;
  orgName: string;
  onClose: () => void;
}) {
  const settings = useChatSettings(room);
  const data = settings.data;
  return (
    <Sheet
      title={data?.title ?? "Chat settings"}
      subtitle={
        data === undefined
          ? undefined
          : `${CHAT_APP_LABEL[data.app]} ${data.app === "slack" ? "channel" : data.kind === "private" ? "chat" : "group"} in ${orgName}`
      }
      onClose={onClose}
    >
      {data === undefined ? (
        <p className="text-sm text-fg-faint">
          {settings.isError ? "Could not load the settings." : "Loading"}
        </p>
      ) : (
        <Body data={data} onClose={onClose} />
      )}
    </Sheet>
  );
}

function Body({ data, onClose }: { data: ChatSettingsView; onClose: () => void }) {
  const toast = useToast();
  const save = useSetChatSettings(data.room);
  const holder = useChatHolder();
  const sendAs = useSendAs(data.room);
  const keepCount = useKeepCount(data.room);
  const unlink = useUnlinkChat();
  const [pendingKeep, setPendingKeep] = useState<{ keep: Keep; remove: number }>();
  const app = CHAT_APP_LABEL[data.app];
  const failed = (title: string) => ({
    onError: (error: Error) => toast(title, { detail: describeError(error), tone: "error" }),
  });
  const change = (input: Parameters<typeof save.mutate>[0]) =>
    save.mutate(input, failed("Could not save it"));
  const readOnly = data.archived === true;

  const chooseKeep = (value: string) => {
    const keep = keepOf(value);
    if ((KEEP_RANK[value] ?? 0) <= (KEEP_RANK[String(data.keep)] ?? 0)) {
      change({ keep });
      return;
    }
    keepCount.mutate(
      { keep },
      {
        onSuccess: (out) =>
          out.remove === 0 ? change({ keep }) : setPendingKeep({ keep, remove: out.remove }),
        ...failed("Could not count them"),
      },
    );
  };

  const askToggle = (kind: HoldClass) => {
    const own = data.holds[kind];
    const asks = own ?? data.workspaceHolds[kind];
    const next = !asks;
    // Back to what the workspace says: follow it again.
    change({ holds: { [kind]: next === data.workspaceHolds[kind] ? null : next } });
  };

  return (
    <fieldset disabled={readOnly} className="m-0 min-w-0 border-0 p-0">
      <Section>Replies</Section>
      <Row label="Reply when" hint="Laya reads every message first">
        <Segmented<ReplyWhen>
          label="Reply when"
          value={data.replyWhen}
          segments={[
            { value: "mentioned", label: "Mentioned" },
            { value: "needs-reply", label: "Needs a reply" },
            { value: "every", label: "Every message" },
          ]}
          onChange={(replyWhen) => change({ replyWhen })}
        />
      </Row>
      <Row label="Send as" hint={data.me.allowed ? `Me posts with your ${app} account` : data.me.why}>
        <Segmented<"bot" | "me">
          label="Send as"
          value={data.sendAs}
          segments={[
            { value: "bot", label: "Bot" },
            {
              value: "me",
              label: "Me",
              disabled: !data.me.allowed,
              ...(data.me.why === undefined ? {} : { title: data.me.why }),
            },
          ]}
          onChange={(next) => sendAs.mutate({ sendAs: next }, failed("Could not change it"))}
        />
      </Row>
      <Row label="Who replies now" hint="You take over when you write here">
        <Segmented<"captain" | "you">
          label="Who replies now"
          value={data.holder}
          segments={[
            { value: "captain", label: "Captain" },
            { value: "you", label: "You" },
          ]}
          onChange={(next) => holder.mutate({ room: data.room, holder: next }, failed("Could not change it"))}
        />
      </Row>
      <Row label="Replies a day" hint="Then the next ones wait for you">
        <Select
          aria-label="Replies a day"
          className={`${SELECT} w-[110px]`}
          value={String(data.dailyLimit)}
          onChange={(e) => change({ dailyLimit: limitOf(e.target.value) })}
        >
          {LIMIT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </Row>
      <Rules rules={data.rules} busy={save.isPending} onSave={(rules) => change({ rules })} />

      <Section>Ask me before sending</Section>
      {HOLD_CLASSES.map((kind) => {
        const asks = data.holds[kind] ?? data.workspaceHolds[kind];
        return (
          <Row
            key={kind}
            label={HOLD_LABEL[kind]}
            hint={`Workspace: ${data.workspaceHolds[kind] ? "ask" : "captain"}`}
          >
            <Cell
              checked={!asks}
              label={HOLD_LABEL[kind]}
              disabled={save.isPending}
              onToggle={() => askToggle(kind)}
            />
          </Row>
        );
      })}

      <Section>History</Section>
      <Row label="Keep" hint={`Older messages are removed from majhi, not from ${app}`}>
        <Select
          aria-label="Keep"
          className={`${SELECT} w-[110px]`}
          value={String(data.keep)}
          onChange={(e) => chooseKeep(e.target.value)}
        >
          {KEEP_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </Row>
      <Row label="Notify me">
        <Select
          aria-label="Notify me"
          className={`${SELECT} w-[150px]`}
          value={data.notify}
          onChange={(e) => change({ notify: e.target.value as Notify })}
        >
          {NOTIFY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </Row>

      <Section>People</Section>
      <People data={data} />

      <div className="flex items-center justify-between pt-5">
        <span className="text-xs text-fg-faint">Unlink keeps the history read only.</span>
        <Button
          size="sm"
          disabled={readOnly || unlink.isPending}
          onClick={() =>
            unlink.mutate({ room: data.room }, { onSuccess: onClose, ...failed("Could not unlink") })
          }
        >
          Unlink
        </Button>
      </div>
      {pendingKeep !== undefined && (
        <ConfirmDialog
          title="Remove older messages?"
          body={`This removes ${pendingKeep.remove} ${pendingKeep.remove === 1 ? "message" : "messages"} now, from majhi only. Anything an incident, a task or a report points to stays.`}
          confirmLabel="Remove"
          busy={save.isPending}
          onCancel={() => setPendingKeep(undefined)}
          onConfirm={() =>
            save.mutate(
              { keep: pendingKeep.keep },
              { onSuccess: () => setPendingKeep(undefined), ...failed("Could not save it") },
            )
          }
        />
      )}
    </fieldset>
  );
}

/** The owner's words for this chat. Saved when the box loses focus; a secret in it is refused. */
function Rules({ rules, busy, onSave }: { rules: string; busy: boolean; onSave: (rules: string) => void }) {
  const [text, setText] = useState(rules);
  useEffect(() => setText(rules), [rules]);
  return (
    <div className="flex flex-col gap-1.5 border-b border-line py-2">
      <label htmlFor="chat-rules" className="text-base text-fg">
        Rules
      </label>
      <span className="text-xs text-fg-faint">The captain follows these in this chat</span>
      <textarea
        id="chat-rules"
        value={text}
        maxLength={CHAT_RULES_MAX}
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (text.trim() !== rules.trim()) onSave(text);
        }}
        className="min-h-[72px] w-full resize-y rounded-md border border-line-control bg-field px-2.5 py-2 text-sm text-fg hover:border-line-hover focus-visible:border-accent focus-visible:outline-none"
      />
    </div>
  );
}

function People({ data }: { data: ChatSettingsView }) {
  const toast = useToast();
  const person = useSetPerson(data.room);
  const [query, setQuery] = useState("");
  const shown = data.people.filter((p) => p.name.toLowerCase().includes(query.trim().toLowerCase()));
  if (data.people.length === 0)
    return <p className="py-2 text-sm text-fg-faint">Nobody has written here yet.</p>;
  return (
    <>
      {data.people.length > SEARCH_OVER && (
        <Input
          aria-label="Search people"
          placeholder="Search people"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="my-2 h-8 text-sm"
        />
      )}
      {shown.map((p) => (
        <div key={p.id} className="flex items-center gap-3 border-b border-line py-2">
          <span
            aria-hidden="true"
            className="grid size-6 place-items-center rounded-full bg-raised text-xs font-semibold"
          >
            {p.name.charAt(0).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1 truncate text-base text-fg">{p.name}</span>
          <Select
            aria-label={`${p.name} is`}
            className={`${SELECT} w-[110px]`}
            value={p.role}
            onChange={(e) =>
              person.mutate(
                { sender: p.id, role: e.target.value as PersonRole },
                {
                  onError: (error) =>
                    toast("Could not change it", { detail: describeError(error), tone: "error" }),
                },
              )
            }
          >
            {ROLE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value} disabled={o.value === "us" && !p.canUs}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
      ))}
    </>
  );
}
