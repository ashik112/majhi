import { CHAT_APP_LABEL, type ChatAccount, type ClientRow, type OrgView } from "@majhi/shared";
import { Button } from "@/components/ui/button";
import { Lamp } from "@/components/ui/lamp";
import { ROW, ROW_SELECTED } from "@/components/ui/list-detail";
import { SectionLabel } from "@/components/ui/section-label";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { useConfirmWebhook, useIgnoreChat, useLinkChat } from "@/lib/client-queries";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { AppMark } from "./app-mark";

/** "Telegram group", "Telegram channel": what the chat is, in the list's one line. */
export function kindLine(row: Pick<ClientRow, "app" | "kind">): string {
  const kind = row.kind === "private" ? "chat" : row.kind;
  return `${CHAT_APP_LABEL[row.app]} ${kind}`;
}

/** Chats the bot was added to that nobody linked yet: link one to a workspace, or ignore it. */
export function NewChats({ rows, orgs }: { rows: readonly ClientRow[]; orgs: readonly OrgView[] }) {
  const toast = useToast();
  const link = useLinkChat();
  const ignore = useIgnoreChat();
  if (rows.length === 0) return null;
  return (
    <section aria-label="New chats" className="flex flex-col gap-2 border-b border-line pb-3">
      <div className="flex items-center justify-between px-2 pt-1">
        <SectionLabel>New chats</SectionLabel>
        <span className="font-mono text-xs text-fg-faint">{rows.length}</span>
      </div>
      {rows.map((row) => (
        <div key={row.id} className="flex flex-col gap-1.5 px-2">
          <div className="flex min-w-0 items-center gap-2">
            <AppMark app={row.app} size={18} />
            <span className="min-w-0 flex-1 truncate text-base text-fg">{row.title}</span>
            <span className="shrink-0 text-xs text-fg-faint">{kindLine(row)}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Select
              aria-label={`Link ${row.title} to a workspace`}
              value=""
              disabled={link.isPending}
              onChange={(event) => {
                const org = event.target.value;
                if (org === "") return;
                link.mutate(
                  { room: row.id, org },
                  {
                    onError: (error) =>
                      toast("Could not link the chat", { detail: describeError(error), tone: "error" }),
                  },
                );
              }}
              className="h-7 flex-1 px-2 text-sm"
            >
              <option value="">Link to workspace</option>
              {orgs.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
                </option>
              ))}
            </Select>
            <Button
              size="sm"
              variant="secondary"
              disabled={ignore.isPending}
              onClick={() =>
                ignore.mutate(
                  { room: row.id },
                  {
                    onError: (error) =>
                      toast("Could not ignore the chat", { detail: describeError(error), tone: "error" }),
                  },
                )
              }
            >
              Ignore
            </Button>
          </div>
        </div>
      ))}
    </section>
  );
}

/** A chat app account that cannot be read: its bot was refused, or a webhook is in the way. */
export function AccountNotices({ accounts }: { accounts: readonly ChatAccount[] }) {
  const toast = useToast();
  const confirm = useConfirmWebhook();
  const rows = accounts.filter((a) => a.trouble === "webhook" || a.trouble === "needs-token");
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5 px-2 pb-2">
      {rows.map((a) => (
        <div
          key={a.connection}
          className="flex items-center gap-2 rounded-lg border border-amber-line bg-amber-wash px-2 py-1.5 text-sm text-fg-soft"
        >
          <span className="min-w-0 flex-1">
            {a.trouble === "webhook"
              ? `${a.account} has a webhook set, so majhi cannot read it.`
              : `${a.account} needs a new token. Set Telegram up again.`}
          </span>
          {a.trouble === "webhook" && (
            <Button
              size="sm"
              variant="secondary"
              disabled={confirm.isPending}
              onClick={() =>
                confirm.mutate(
                  { connection: a.connection },
                  {
                    onError: (error) =>
                      toast("Could not remove the webhook", { detail: describeError(error), tone: "error" }),
                  },
                )
              }
            >
              Remove it
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

/** A workspace's linked chats: the app's mark, the chat's name, its newest line and how many are unread. */
export function ClientRows({
  rows,
  selected,
  onOpen,
}: {
  rows: readonly ClientRow[];
  selected: string | undefined;
  onOpen: (room: string) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="mt-1 flex flex-col gap-px">
      <span className="px-2 pt-1 text-xs text-fg-faint">Clients</span>
      {rows.map((row) => {
        const active = row.id === selected;
        return (
          <button
            key={row.id}
            type="button"
            aria-current={active ? "true" : undefined}
            onClick={() => onOpen(row.id)}
            className={cn(ROW, "min-h-[38px] items-center gap-2 px-2 py-1", active && ROW_SELECTED)}
          >
            <AppMark app={row.app} size={18} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className={cn("min-w-0 truncate text-base", active ? "text-fg" : "text-fg-soft")}>
                {row.title}
              </span>
              <span className="truncate text-xs text-fg-faint">
                {row.trouble === "unreachable"
                  ? "The bot cannot write here"
                  : (row.lastLine ?? kindLine(row))}
              </span>
            </span>
            {row.waiting && (
              <>
                <Lamp state="needs" size={6} className="shrink-0" />
                <span className="sr-only">Waits for you</span>
              </>
            )}
            {row.unread > 0 && <span className="font-mono text-xs text-accent-text">{row.unread}</span>}
          </button>
        );
      })}
    </div>
  );
}
