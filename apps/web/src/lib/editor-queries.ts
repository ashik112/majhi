import { type CommandOutput, EDITOR_LABEL } from "@majhi/shared";
import { useMutation } from "@tanstack/react-query";
import { type ApiRequestError, cmd } from "./api";
import { useSettings } from "./boss-queries";

export interface EditorTarget {
  /** Absolute path of a file, worktree or project folder. */
  path: string;
  line?: number;
}

/** Opens a path in the owner's editor through the host helper. */
export function useOpenInEditor() {
  return useMutation<CommandOutput<"editor.open">, ApiRequestError, EditorTarget>({
    mutationFn: ({ path, line }) => cmd("editor.open", line === undefined ? { path } : { path, line }),
  });
}

/** "VS Code" or "Cursor", as chosen in settings. "your editor" until the settings load. */
export function useEditorLabel(): string {
  const settings = useSettings();
  return settings.data ? EDITOR_LABEL[settings.data.editor.app] : "your editor";
}
