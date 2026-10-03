import { KEY_EXPORT_FILE_NAME, KEY_EXPORT_MAX_LENGTH } from "@majhi/shared";
import { type FormEvent, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { useRestoreKey } from "@/lib/ops-queries";

/**
 * The secrets key export and its passphrase, sent once to put the key back. The passphrase field is
 * cleared as soon as it is sent; majhi keeps neither the file nor the passphrase.
 */
export function KeyRestoreForm({ onDone }: { onDone: (detail: string) => void }) {
  const restoreKey = useRestoreKey();
  const picker = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File>();
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState<string>();

  function choose(chosen: File) {
    const big = chosen.size > KEY_EXPORT_MAX_LENGTH;
    setFile(big ? undefined : chosen);
    setError(big ? `${chosen.name} is too big to be a key export.` : undefined);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (file === undefined || passphrase === "" || restoreKey.isPending) return;
    const sent = passphrase;
    setPassphrase("");
    setError(undefined);
    const content = await file.text().catch(() => undefined);
    if (content === undefined) {
      setError(`${file.name} could not be read. Choose it again.`);
      return;
    }
    restoreKey.mutate(
      { content, passphrase: sent },
      {
        onSuccess: (out) => onDone(out.detail),
        onError: (err) => setError(describeError(err)),
      },
    );
  }

  return (
    <form
      onSubmit={(e) => void submit(e)}
      aria-label="Restore the secrets key"
      className="flex flex-col gap-1.5 pl-[19px]"
    >
      <input
        ref={picker}
        type="file"
        tabIndex={-1}
        aria-hidden="true"
        className="hidden"
        onChange={(e) => {
          const chosen = e.target.files?.[0];
          e.target.value = "";
          if (chosen) choose(chosen);
        }}
      />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button
          type="button"
          size="sm"
          disabled={restoreKey.isPending}
          onClick={() => picker.current?.click()}
        >
          {file === undefined ? "Choose file" : "Choose another"}
        </Button>
        <span
          className={cn("max-w-64 truncate text-sm", file === undefined ? "text-fg-faint" : "text-fg-soft")}
          title={file?.name}
        >
          {file?.name ?? "No file chosen"}
        </span>
        <Input
          type="password"
          autoComplete="current-password"
          aria-label="Passphrase"
          placeholder="Passphrase"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          className="w-64"
        />
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={file === undefined || passphrase === "" || restoreKey.isPending}
        >
          {restoreKey.isPending ? "Restoring" : "Restore"}
        </Button>
      </div>
      <p className="text-sm text-fg-faint text-pretty">
        Choose the {KEY_EXPORT_FILE_NAME} file that Export key saved, and type its passphrase. majhi restarts
        once to load the key.
      </p>
      {error && (
        <p role="alert" className="text-sm text-red">
          {error}
        </p>
      )}
    </form>
  );
}
