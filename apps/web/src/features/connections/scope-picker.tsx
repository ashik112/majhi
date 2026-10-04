import { GLOBAL_CONNECTIONS, type OrgView, PRIVATE } from "@majhi/shared";
import { Globe, Layers } from "lucide-react";
import { useId } from "react";
import { Select } from "@/components/ui/select";

export function scopeName(org: string, orgs: readonly OrgView[]): string {
  return org === GLOBAL_CONNECTIONS ? "Global" : (orgs.find((o) => o.id === org)?.name ?? org);
}

/** The destination is visible before service selection, and cannot change during sign-in. */
export function ScopePicker({
  orgs,
  value,
  onChange,
  disabled = false,
}: {
  orgs: readonly OrgView[];
  value: string;
  onChange: (org: string) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const global = value === GLOBAL_CONNECTIONS;
  const Icon = global ? Globe : Layers;
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
      <div className="flex items-center gap-3">
        <Icon aria-hidden="true" className="size-4 text-fg-muted" />
        <label htmlFor={id} className="shrink-0 text-base font-medium text-fg">
          Connect for
        </label>
        <Select
          id={id}
          aria-label="Connection scope"
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className="w-[210px] max-w-full"
        >
          <option value={GLOBAL_CONNECTIONS}>Global · All workspaces</option>
          <optgroup label="One workspace">
            {orgs.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name}
                {org.id === PRIVATE ? " · Personal" : ""}
              </option>
            ))}
          </optgroup>
        </Select>
      </div>
      <p className="text-sm text-fg-muted">
        {global
          ? "Shared with agents in every workspace."
          : `Only agents working in ${scopeName(value, orgs)} can use this connection.`}
      </p>
    </div>
  );
}
