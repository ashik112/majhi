/**
 * The words of a permission prompt's buttons, one set for the room and for Needs you. ACP adapters
 * name the options "Allow", "Always allow" and "Reject"; the owner sees these instead, so the same
 * prompt reads the same everywhere and "always" never promises more than the task.
 */
export type PermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";

export const PERMISSION_OPTION_LABEL: Record<PermissionOptionKind, string> = {
  allow_once: "Allow once",
  allow_always: "Allow for this task",
  reject_once: "Deny",
  reject_always: "Deny",
};

/** The id prefix of the options majhi adds to a connection write's card, which carry their own words. */
export const MAJHI_OPTION_PREFIX = "majhi:";

export function permissionOptionLabel(option: {
  id?: string;
  name?: string;
  kind: PermissionOptionKind;
}): string {
  if (option.id?.startsWith(MAJHI_OPTION_PREFIX) === true && option.name !== undefined) return option.name;
  return PERMISSION_OPTION_LABEL[option.kind];
}
