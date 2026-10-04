import { GLOBAL_CONNECTIONS, type OrgView, PRIVATE } from "@majhi/shared";
import { Globe } from "lucide-react";
import { useId } from "react";
import { OrgBadge } from "@/components/ui/org-badge";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import { badgeLetters } from "@/lib/format";

export function scopeName(org: string, orgs: readonly OrgView[]): string {
  return org === GLOBAL_CONNECTIONS ? "Global" : (orgs.find((o) => o.id === org)?.name ?? org);
}

/** Who gets a connection of this scope, in one sentence. */
export function scopeAudience(org: string, orgs: readonly OrgView[]): string {
  return org === GLOBAL_CONNECTIONS
    ? "Agents in every workspace get it."
    : `Only agents working in ${scopeName(org, orgs)} get it.`;
}

/** A workspace's tile in its colour, or the globe for Global. Decorative: the name sits beside it. */
export function WorkspaceMark({
  org,
  orgs,
  size = "md",
}: {
  org: string;
  orgs: readonly OrgView[];
  size?: "sm" | "md";
}) {
  const found = orgs.find((o) => o.id === org);
  return org === GLOBAL_CONNECTIONS ? (
    <Globe
      aria-hidden="true"
      className={cn("shrink-0 text-fg-muted", size === "md" ? "size-[22px]" : "size-5")}
    />
  ) : (
    <OrgBadge
      label={badgeLetters(found?.key ?? org)}
      color={found?.color}
      size={size === "md" ? "lg" : "sm"}
    />
  );
}

/** The workspace a connection belongs to: its tile and name. */
export function WorkspaceTag({
  org,
  orgs,
  size = "sm",
  className,
}: {
  org: string;
  orgs: readonly OrgView[];
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <span className={cn("flex min-w-0 items-center gap-2", className)}>
      <WorkspaceMark org={org} orgs={orgs} size={size} />
      <span className="truncate">{scopeName(org, orgs)}</span>
    </span>
  );
}

/** The workspace a new connection goes to: chosen before the service, and locked during sign-in. */
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
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="flex items-center gap-3">
        <label htmlFor={id} className="shrink-0 text-base font-semibold text-fg">
          Connecting to
        </label>
        <span className="flex items-center gap-2">
          <WorkspaceMark org={value} orgs={orgs} />
          <Select
            id={id}
            value={value}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
            className="w-[200px] max-w-full font-semibold"
          >
            {orgs.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name}
                {org.id === PRIVATE ? " · Personal" : ""}
              </option>
            ))}
            <option value={GLOBAL_CONNECTIONS}>Global · All workspaces</option>
          </Select>
        </span>
      </div>
      <p className="text-sm text-fg-muted">{scopeAudience(value, orgs)}</p>
    </div>
  );
}
