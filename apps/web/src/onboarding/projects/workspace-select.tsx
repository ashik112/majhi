import type { OnboardingWorkspace } from "@majhi/shared";
import { Select } from "@/components/ui/select";

/** Which workspace new projects go to. */
export function WorkspaceSelect({
  workspaces,
  value,
  onChange,
  label = "Workspace",
  className,
}: {
  workspaces: readonly OnboardingWorkspace[];
  value: string;
  onChange: (id: string) => void;
  label?: string;
  className?: string;
}) {
  return (
    <Select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className={className}>
      {workspaces.map((w) => (
        <option key={w.id} value={w.id}>
          {w.name}
        </option>
      ))}
    </Select>
  );
}
