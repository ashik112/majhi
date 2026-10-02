import { KEY_EXPORT_PASSPHRASE_MIN } from "@majhi/shared";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { describeError } from "@/lib/errors";
import { useExportKey } from "@/lib/ops-queries";

/**
 * The passphrase for the secrets key export, typed twice, then a download. The fields are cleared as
 * soon as the passphrase is sent; majhi does not keep it, so a lost passphrase means a new export.
 */
export function KeyExportForm({ onDone }: { onDone: (detail: string) => void }) {
  const exportKey = useExportKey();
  const [passphrase, setPassphrase] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string>();

  const short = passphrase.length < KEY_EXPORT_PASSPHRASE_MIN;
  const mismatch = again !== "" && again !== passphrase;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (short || again !== passphrase || exportKey.isPending) return;
    const sent = passphrase;
    setPassphrase("");
    setAgain("");
    setError(undefined);
    exportKey.mutate(
      { passphrase: sent },
      {
        onSuccess: (out) => {
          download(out.fileName, out.content);
          onDone(`Downloaded ${out.fileName}. Keep it and the passphrase off this Mac.`);
        },
        onError: (err) => setError(describeError(err)),
      },
    );
  }

  return (
    <form onSubmit={submit} aria-label="Export the secrets key" className="flex flex-col gap-1.5 pl-[19px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Input
          type="password"
          autoComplete="new-password"
          aria-label="Passphrase"
          placeholder={`Passphrase, ${KEY_EXPORT_PASSPHRASE_MIN}+ characters`}
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          className="w-64"
        />
        <Input
          type="password"
          autoComplete="new-password"
          aria-label="Passphrase again"
          placeholder="Passphrase again"
          value={again}
          onChange={(e) => setAgain(e.target.value)}
          aria-invalid={mismatch ? true : undefined}
          className="w-64"
        />
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={short || again !== passphrase || exportKey.isPending}
        >
          {exportKey.isPending ? "Exporting" : "Export and download"}
        </Button>
      </div>
      <p className="text-sm text-fg-faint text-pretty">
        {mismatch
          ? "The two passphrases differ."
          : "majhi does not keep the passphrase. To restore, age -d the file with it into ~/.config/majhi/secrets.key."}
      </p>
      {error && (
        <p role="alert" className="text-sm text-red">
          {error}
        </p>
      )}
    </form>
  );
}

function download(fileName: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
