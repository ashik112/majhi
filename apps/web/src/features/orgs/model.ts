import { type CommandInput, OrgConfigSchema, type OrgView } from "@majhi/shared";

/** What the owner types in the org's settings form. Everything is text; `""` means not set. */
export interface OrgDraft {
  name: string;
  color: string;
  key: string;
  base: string;
  identityName: string;
  identityEmail: string;
  /** Resume interrupted work on its own: majhi's setting, or this org's own. */
  resume: "default" | "on" | "off";
}

export type OrgErrors = Partial<Record<keyof OrgDraft, string>>;

export function draftFromOrg(org: OrgView): OrgDraft {
  return {
    name: org.name,
    color: org.color ?? "",
    key: org.key,
    base: org.base ?? "",
    identityName: org.identity?.name ?? "",
    identityEmail: org.identity?.email ?? "",
    resume: org.resume?.auto === undefined ? "default" : org.resume.auto ? "on" : "off",
  };
}

export type OrgCheck =
  | { ok: true; input: CommandInput<"orgs.update"> | undefined }
  | { ok: false; errors: OrgErrors };

/**
 * Checks the draft against the same schema the server uses and builds the `orgs.update` input
 * with only the fields that changed. `input` is undefined when nothing changed.
 */
export function checkOrgDraft(org: OrgView, draft: OrgDraft): OrgCheck {
  const errors: OrgErrors = {};
  const input: CommandInput<"orgs.update"> = { id: org.id };

  const name = draft.name.trim();
  if (name === "") errors.name = "Give the org a name";
  else if (name !== org.name) input.name = name;

  const color = draft.color.trim();
  if (color !== "" && color !== (org.color ?? "")) {
    if (OrgConfigSchema.shape.color.safeParse(color).success) input.color = color;
    else errors.color = "Use a hex color like #8ab8f5";
  }

  const key = draft.key.trim().toUpperCase();
  if (key !== org.key) {
    if (key === "") input.key = null;
    else {
      const parsed = OrgConfigSchema.shape.key.safeParse(key);
      if (parsed.success) input.key = key;
      else errors.key = parsed.error.issues[0]?.message ?? "Invalid task key";
    }
  }

  const base = draft.base.trim();
  if (base !== (org.base ?? "")) input.base = base === "" ? null : base;

  const identityName = draft.identityName.trim();
  const identityEmail = draft.identityEmail.trim();
  if (identityName !== (org.identity?.name ?? "") || identityEmail !== (org.identity?.email ?? "")) {
    if (identityName === "" && identityEmail === "") input.identity = null;
    else if (identityName === "") errors.identityName = "Give the name commits use";
    else if (identityEmail === "") errors.identityEmail = "Give the email commits use";
    else {
      const parsed = OrgConfigSchema.shape.identity.safeParse({ name: identityName, email: identityEmail });
      if (parsed.success && parsed.data) input.identity = parsed.data;
      else errors.identityEmail = "Use an email address like you@company.com";
    }
  }

  const resume = org.resume?.auto === undefined ? "default" : org.resume.auto ? "on" : "off";
  if (draft.resume !== resume)
    input.resume = draft.resume === "default" ? null : { auto: draft.resume === "on" };

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, input: Object.keys(input).length > 1 ? input : undefined };
}

/** "Ashik <ashik@globex.example>", or undefined when no identity is set. */
export function identityLabel(org: Pick<OrgView, "identity">): string | undefined {
  return org.identity ? `${org.identity.name} <${org.identity.email}>` : undefined;
}
