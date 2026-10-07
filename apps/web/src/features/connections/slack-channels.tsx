import type { ChatPermissionState, OrgView } from "@majhi/shared";
import { Check, Lock, Minus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { CopyButton } from "@/features/room/copy-button";
import {
  useChannels,
  useIgnoreChannel,
  useLinkChannel,
  useRefreshChannels,
  useUnignoreChat,
  useUnlinkChat,
} from "@/lib/client-queries";
import { describeError } from "@/lib/errors";

/** One row of the permissions list: a mark, the name, and what it is for or what is known. */
function Row({
  state,
  name,
  note,
  unknownNote = "Not confirmed",
}: {
  state: ChatPermissionState;
  name: string;
  note: string;
  unknownNote?: string;
}) {
  return (
    <li className="flex min-w-0 items-center gap-2 text-sm">
      {state === "granted" && <Check aria-label="Granted" className="size-3.5 shrink-0 text-green" />}
      {state === "missing" && <X aria-label="Missing" className="size-3.5 shrink-0 text-red" />}
      {state === "unknown" && (
        <Minus aria-label="Not confirmed" className="size-3.5 shrink-0 text-fg-faint" />
      )}
      <span className="shrink-0 font-mono text-fg-soft">{name}</span>
      <span className="min-w-0 flex-1 truncate text-fg-faint">
        {state === "unknown" ? unknownNote : note}
      </span>
    </li>
  );
}

/** The Slack workspace's channels: link one to a workspace without going to Slack, or ignore it. */
export function SlackChannels({ connection, orgs }: { connection: string; orgs: readonly OrgView[] }) {
  const toast = useToast();
  const channels = useChannels(connection, true);
  const refresh = useRefreshChannels(connection);
  const link = useLinkChannel(connection);
  const ignore = useIgnoreChannel(connection);
  const unlink = useUnlinkChat();
  const unignore = useUnignoreChat();
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
  const missing = data.permissions.filter((p) => p.state === "missing").map((p) => p.scope);
  const lacking = missing.length > 0 || data.socketMode === "missing";
  async function copyManifest() {
    try {
      await navigator.clipboard.writeText(data?.manifest ?? "");
      toast("App manifest copied", { detail: "Paste it under App Manifest in the app's settings." });
    } catch {
      toast("Could not copy", { detail: "The browser blocked the clipboard.", tone: "error" });
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1.5">
        <span className="text-sm text-fg-faint">Permissions</span>
        {lacking && (
          <div className="flex flex-col gap-1.5 rounded-lg border border-amber-line bg-amber-wash px-2 py-1.5 text-sm text-fg-soft">
            <span>
              Add these in Slack, then reinstall the app
              {missing.length > 0 ? `: ${missing.join(", ")}.` : "."}
            </span>
            <div className="flex flex-wrap items-center gap-1.5">
              <Button size="sm" variant="secondary" onClick={() => void copyManifest()}>
                Copy manifest
              </Button>
              <a
                href={oauth}
                target="_blank"
                rel="noreferrer noopener"
                className="text-sm underline hover:text-fg"
              >
                Open the app's page
              </a>
              <Button
                size="sm"
                variant="secondary"
                className="ml-auto"
                disabled={refresh.isPending}
                onClick={() => refresh.mutate()}
              >
                Check now
              </Button>
            </div>
          </div>
        )}
        <ul aria-label="Permissions" className="m-0 flex list-none flex-col gap-1 p-0">
          {data.permissions.map((p) => (
            <Row key={p.scope} state={p.state} name={p.scope} note={p.use} />
          ))}
          <Row state={data.socketMode} name="Socket Mode" note="Lets majhi read without a public address" />
          <Row
            state={data.messageEvents ? "granted" : "unknown"}
            name="Message events"
            note="Messages reach majhi"
            unknownNote="Not seen yet"
          />
        </ul>
      </div>
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
                {c.org !== undefined && c.room !== undefined && (
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-label={`Unlink ${c.name}`}
                    disabled={unlink.isPending}
                    onClick={() =>
                      unlink.mutate({ room: c.room ?? "" }, fail("Could not unlink the channel"))
                    }
                  >
                    Unlink
                  </Button>
                )}
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
                {c.ignored === true && c.room !== undefined && (
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-label={`Watch ${c.name} again`}
                    disabled={unignore.isPending}
                    onClick={() =>
                      unignore.mutate({ room: c.room ?? "" }, fail("Could not watch the channel"))
                    }
                  >
                    Watch again
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
