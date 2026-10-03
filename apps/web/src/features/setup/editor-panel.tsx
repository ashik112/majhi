import { EDITOR_LABEL, type EditorApp, EditorAppSchema, type EditorSettings } from "@majhi/shared";
import { useState } from "react";
import { Field } from "@/components/ui/field";
import { SaveSection, type SaveState } from "@/components/ui/save-section";
import { Select } from "@/components/ui/select";
import { useSaveSettings } from "@/lib/boss-queries";

const IDLE: SaveState = { kind: "idle" };

/** Which editor "Open in editor" uses. The host helper runs it on this computer. */
export function EditorSection({ saved }: { saved: EditorSettings }) {
  const save = useSaveSettings();
  const [edit, setEdit] = useState<EditorApp>();
  const [state, setState] = useState<SaveState>(IDLE);
  const app = edit ?? saved.app;
  const dirty = app !== saved.app;

  function onSave() {
    if (!dirty) return;
    setState({ kind: "saving" });
    save.mutate(
      { editor: { app } },
      {
        onSuccess: () => {
          setEdit(undefined);
          setState({ kind: "saved" });
        },
        onError: (e) => setState({ kind: "error", message: e.message, details: e.details }),
      },
    );
  }

  return (
    <SaveSection
      title="Editor"
      note="Saved to majhi.yaml, as a change you can undo"
      className="border-t-0"
      dirty={dirty}
      state={state}
      onSave={onSave}
      onDiscard={() => {
        setEdit(undefined);
        setState(IDLE);
      }}
    >
      <form
        aria-label="Editor settings"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          onSave();
        }}
        className="flex max-w-[640px] flex-col gap-4"
      >
        <Field
          label="Open files and folders in"
          hint="The host helper runs this editor on your computer through its code or cursor command. The app must be installed there."
        >
          {(p) => (
            <Select
              {...p}
              value={app}
              onChange={(e) => {
                if (state.kind !== "saving") setState(IDLE);
                setEdit(EditorAppSchema.parse(e.target.value));
              }}
            >
              {EditorAppSchema.options.map((option) => (
                <option key={option} value={option}>
                  {EDITOR_LABEL[option]}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </form>
    </SaveSection>
  );
}
