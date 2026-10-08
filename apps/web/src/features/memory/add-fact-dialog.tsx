import type { MemoryScope } from "@majhi/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { Textarea } from "@/components/ui/select";
import { describeError } from "@/lib/errors";
import { useAddFact } from "@/lib/memory-queries";

/** A lesson the owner writes: active at once, in the scope of the row it is added from. */
export function AddFactDialog({
  scope,
  where,
  onClose,
}: {
  scope: MemoryScope;
  /** The row's name, "Acme" or "All projects". */
  where: string;
  onClose: () => void;
}) {
  const add = useAddFact();
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string>();
  return (
    <Modal label="Add lesson" onClose={onClose} className="w-[520px]">
      <form
        className="flex flex-col gap-4 p-5"
        onSubmit={(event) => {
          event.preventDefault();
          add.mutate(
            { text: text.trim(), scope, pinned: false },
            { onSuccess: onClose, onError: (e) => setProblem(describeError(e)) },
          );
        }}
      >
        <h2 className="text-md font-semibold">Add lesson for {where}</h2>
        <Field label="Words">
          {(props) => (
            <Textarea
              {...props}
              rows={3}
              className="font-sans"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          )}
        </Field>
        {problem && (
          <p
            role="alert"
            className="rounded-md border border-red-line bg-red-wash px-3 py-2 text-base text-red text-pretty"
          >
            {problem}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={add.isPending || text.trim().length < 3}>
            Add
          </Button>
        </div>
      </form>
    </Modal>
  );
}
