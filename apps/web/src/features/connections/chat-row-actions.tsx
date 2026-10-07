import type { OrgView } from "@majhi/shared";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { useUnignoreChat, useUnlinkChat } from "@/lib/client-queries";
import { describeError } from "@/lib/errors";

/**
 * What the owner does with one chat of a chat app: link it to a workspace, unlink it, ignore it, or watch an ignored
 * one again. Slack's channel list and Telegram's group list both draw it, so the two apps behave the same.
 */
export function ChatRowActions({
  name,
  org,
  room,
  ignored,
  unlinked = false,
  orgs,
  linking,
  onLink,
  onIgnore,
  ignoring,
}: {
  name: string;
  org: string | undefined;
  /** The room majhi made for the chat, once there is one. */
  room: string | undefined;
  ignored: boolean;
  /** Unlinked by the owner: it can be linked again, not ignored. */
  unlinked?: boolean;
  orgs: readonly OrgView[];
  linking: boolean;
  ignoring: boolean;
  onLink: (org: string, fail: (error: unknown) => void) => void;
  onIgnore: (fail: (error: unknown) => void) => void;
}) {
  const toast = useToast();
  const unlink = useUnlinkChat();
  const unignore = useUnignoreChat();
  const fail = (what: string) => (error: unknown) =>
    toast(what, { detail: describeError(error), tone: "error" });
  return (
    <div className="flex items-center gap-1.5">
      <Select
        aria-label={`Link ${name} to a workspace`}
        value={org ?? ""}
        disabled={org !== undefined || linking}
        onChange={(event) => {
          const next = event.target.value;
          if (next !== "") onLink(next, fail("Could not link the chat"));
        }}
        className="h-7 flex-1 px-2 text-sm"
      >
        <option value="">Link to workspace</option>
        {orgs.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </Select>
      {org !== undefined && room !== undefined && (
        <Button
          size="sm"
          variant="secondary"
          aria-label={`Unlink ${name}`}
          disabled={unlink.isPending}
          onClick={() => unlink.mutate({ room }, { onError: fail("Could not unlink the chat") })}
        >
          Unlink
        </Button>
      )}
      {org === undefined && !ignored && !unlinked && (
        <Button
          size="sm"
          variant="secondary"
          aria-label={`Ignore ${name}`}
          disabled={ignoring}
          onClick={() => onIgnore(fail("Could not ignore the chat"))}
        >
          Ignore
        </Button>
      )}
      {ignored && room !== undefined && (
        <Button
          size="sm"
          variant="secondary"
          aria-label={`Watch ${name} again`}
          disabled={unignore.isPending}
          onClick={() => unignore.mutate({ room }, { onError: fail("Could not watch the chat") })}
        >
          Watch again
        </Button>
      )}
    </div>
  );
}
