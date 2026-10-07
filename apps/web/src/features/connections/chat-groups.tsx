import type { OrgView } from "@majhi/shared";
import { useGroups, useIgnoreChat, useLinkChat } from "@/lib/client-queries";
import { describeError } from "@/lib/errors";
import { ChatRowActions } from "./chat-row-actions";

/** The groups and channels majhi knows of one chat account (Telegram): link, unlink, ignore, or watch an ignored one again. */
export function ChatGroups({ connection, orgs }: { connection: string; orgs: readonly OrgView[] }) {
  const groups = useGroups(connection, true);
  const link = useLinkChat();
  const ignore = useIgnoreChat();
  if (groups.data === undefined) {
    return (
      <p className="text-base text-fg-muted">
        {groups.isError ? describeError(groups.error) : "Reading groups."}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm text-fg-faint">Groups</span>
      {groups.data.length === 0 && (
        <p className="text-sm text-fg-faint">
          No groups yet. Add the bot to a group and it shows here with the first message.
        </p>
      )}
      {groups.data.map((g) => (
        <div key={g.id} className="flex flex-col gap-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-base text-fg">{g.title}</span>
            {g.ignored === true && <span className="shrink-0 text-xs text-fg-faint">Ignored</span>}
            {g.archived === true && <span className="shrink-0 text-xs text-fg-faint">Unlinked</span>}
          </div>
          <ChatRowActions
            name={g.title}
            org={g.archived === true ? undefined : g.org}
            room={g.id}
            ignored={g.ignored === true}
            unlinked={g.archived === true}
            orgs={orgs}
            linking={link.isPending}
            ignoring={ignore.isPending}
            onLink={(org, onError) => link.mutate({ room: g.id, org }, { onError })}
            onIgnore={(onError) => ignore.mutate({ room: g.id }, { onError })}
          />
        </div>
      ))}
    </div>
  );
}
