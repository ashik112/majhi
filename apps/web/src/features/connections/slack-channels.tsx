import type { OrgView } from "@majhi/shared";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { CopyButton } from "@/features/room/copy-button";
import { useChannels, useIgnoreChannel, useLinkChannel, useRefreshChannels } from "@/lib/client-queries";
import { describeError } from "@/lib/errors";

/** What each permission majhi needs is for, in the notice's words. */
const SCOPE_USE: Record<string, string> = {
  "chat:write": "posting replies",
  "files:read": "files",
  "mpim:read": "group chats",
  "channels:join": "joining channels",
};

/** The Slack workspace's channels: link one to a workspace without going to Slack, or ignore it. */
export function SlackChannels({ connection, orgs }: { connection: string; orgs: readonly OrgView[] }) {
  const toast = useToast();
  const channels = useChannels(connection, true);
  const refresh = useRefreshChannels(connection);
  const link = useLinkChannel(connection);
  const ignore = useIgnoreChannel(connection);
  const data = channels.data;
  if (data === undefined) {
    return (
      <p className="text-base text-fg-muted">
        {channels.isError ? describeError(channels.error) : "Reading channels."}
      </p>
    );
  }
  const oauth =
    data.appId === undefined
      ? "https://api.slack.com/apps"
      : `https://api.slack.com/apps/${data.appId}/oauth`;
  const fail = (what: string) => ({
    onError: (error: unknown) => toast(what, { detail: describeError(error), tone: "error" }),
  });
  return (
    <div className="flex flex-col gap-2">
      {data.missingScopes.length > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-line bg-amber-wash px-2 py-1.5 text-sm text-fg-soft">
          <span className="min-w-0 flex-1">
            Slack needs a reinstall for {data.missingScopes.map((s) => SCOPE_USE[s] ?? s).join(", ")}.{" "}
            <a href={oauth} target="_blank" rel="noreferrer noopener" className="underline">
              Open the app's page
            </a>
          </span>
          <Button size="sm" variant="secondary" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
            Check now
          </Button>
        </div>
      )}
      <div className="flex items-center justify-between">
        <span className="text-sm text-fg-faint">Channels</span>
        <Button size="sm" variant="ghost" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
          Refresh
        </Button>
      </div>
      {data.channels.length === 0 && <p className="text-sm text-fg-faint">No channels yet.</p>}
      {data.channels.map((c) => {
        const invite = c.private && !c.member;
        return (
          <div key={c.id} className="flex flex-col gap-1.5">
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-base text-fg">#{c.name}</span>
              {c.private && <Lock aria-label="Private channel" className="size-3.5 shrink-0 text-fg-faint" />}
              {c.ignored === true && <span className="shrink-0 text-xs text-fg-faint">Ignored</span>}
            </div>
            {invite ? (
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate font-mono text-sm text-fg-soft">
                  /invite @{data.bot}
                </code>
                <CopyButton text={`/invite @${data.bot}`} label={`Copy the invite for ${c.name}`} />
              </div>
            ) : (
              <div className="flex items-center gap-1.5">
                <Select
                  aria-label={`Link ${c.name} to a workspace`}
                  value={c.org ?? ""}
                  disabled={c.org !== undefined || link.isPending}
                  onChange={(event) => {
                    const org = event.target.value;
                    if (org !== "") link.mutate({ channel: c.id, org }, fail("Could not link the channel"));
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
                {c.org === undefined && c.ignored !== true && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={ignore.isPending}
                    onClick={() => ignore.mutate({ channel: c.id }, fail("Could not ignore the channel"))}
                  >
                    Ignore
                  </Button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
