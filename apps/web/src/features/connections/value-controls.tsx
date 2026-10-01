import { CONNECTION_FILE_MAX_BYTES, type ConnectionListKey, type ConnectionValueView } from "@majhi/shared";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { useConnectionCommand, useSetConnectionFile } from "@/lib/connection-queries";
import { describeError } from "@/lib/errors";

interface Target {
  /** The connection. */
  id: string;
  /** A field key, or an entry's name in `list`. */
  field: string;
  list?: ConnectionListKey | undefined;
  /** For messages, like "Password". */
  label: string;
  value: ConnectionValueView | undefined;
  inputId?: string | undefined;
  describedBy?: string | undefined;
}

function targetOf({ id, field, list }: Target) {
  return { id, field, ...(list === undefined ? {} : { list }) };
}

/** A write-only secret: Set, or Replace once one is stored. The value goes to secrets.age and is never shown again. */
export function SecretInput(props: Target) {
  const setSecret = useConnectionCommand("connections.setSecret");
  const toast = useToast();
  const [text, setText] = useState("");
  const stored = props.value?.set === true;
  const ready = text.trim() !== "" && !setSecret.isPending;
  const save = () => {
    if (!ready) return;
    setSecret.mutate(
      { ...targetOf(props), value: text },
      {
        onSuccess: () => {
          setText("");
          toast(`${props.label} saved. It is never shown again.`);
        },
        onError: (error) =>
          toast(`Could not save ${props.label}`, { detail: describeError(error), tone: "error" }),
      },
    );
  };
  return (
    <div className="flex min-w-0 gap-2">
      <Input
        id={props.inputId}
        aria-describedby={props.describedBy}
        type="password"
        autoComplete="new-password"
        className="font-mono"
        value={text}
        placeholder={stored ? "Set. Type to replace it" : "Not set"}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
        }}
      />
      <Button disabled={!ready} onClick={save} aria-label={`${stored ? "Replace" : "Set"} ${props.label}`}>
        {setSecret.isPending ? "Saving" : stored ? "Replace" : "Set"}
      </Button>
    </div>
  );
}

/** A file of the connection, like a kubeconfig: uploaded once, kept owner-only, replaced by uploading again. */
export function FileInput(props: Target) {
  const setFile = useSetConnectionFile();
  const toast = useToast();
  const picker = useRef<HTMLInputElement>(null);
  const stored = props.value?.set === true;
  const upload = (file: File) => {
    if (file.size > CONNECTION_FILE_MAX_BYTES) {
      toast(`${file.name} is too big`, {
        detail: `A connection's file can be at most ${CONNECTION_FILE_MAX_BYTES / 1024} KB.`,
        tone: "error",
      });
      return;
    }
    setFile.mutate(
      { ...targetOf(props), file },
      {
        onSuccess: () => toast(`${props.label} uploaded.`),
        onError: (error) =>
          toast(`Could not upload ${props.label}`, { detail: describeError(error), tone: "error" }),
      },
    );
  };
  return (
    <div className="flex min-h-[34px] min-w-0 items-center gap-2">
      <input
        ref={picker}
        type="file"
        tabIndex={-1}
        aria-hidden="true"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) upload(file);
        }}
      />
      <span
        id={props.inputId}
        aria-describedby={props.describedBy}
        className={cn("min-w-0 truncate text-base", stored ? "text-fg-soft" : "text-fg-faint")}
      >
        {stored ? "Uploaded" : "Not set"}
      </span>
      <Button
        size="sm"
        className="ml-auto"
        disabled={setFile.isPending}
        onClick={() => picker.current?.click()}
        aria-label={`${stored ? "Replace" : "Upload"} ${props.label}`}
      >
        {setFile.isPending ? "Uploading" : stored ? "Replace" : "Upload"}
      </Button>
    </div>
  );
}
