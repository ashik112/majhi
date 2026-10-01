import {
  type CommandInput,
  type MergePolicy,
  type MrHost,
  MrHostSchema,
  OrgConfigSchema,
  type OrgView,
} from "@majhi/shared";

export const MERGE_LABEL: Record<MergePolicy, string> = {
  never: "Never, you merge on the host",
  approve: "Approve, majhi merges when you click",
  "auto-if-green": "Auto if green",
};

export const MR_HOSTS: readonly MrHost[] = MrHostSchema.options;

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
  /** Agent attribution in commits: majhi's setting, or this org's own. */
  commits: "default" | "on" | "off";
  /** When majhi merges the org's MRs. */
  merge: MergePolicy;
  /** The saved secret (`secret:<name>`) each host's token is read from; `""` for none. */
  mrTokens: Record<MrHost, string>;
  /** A token typed for a host, saved as a secret when the form is saved. Never shown again. */
  newTokens: Record<MrHost, string>;
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
    commits: org.commits?.attribution === undefined ? "default" : org.commits.attribution ? "on" : "off",
    merge: org.merge,
    mrTokens: perHost((host) => org.mrTokens?.[host] ?? ""),
    newTokens: perHost(() => ""),
  };
}

function perHost(value: (host: MrHost) => string): Record<MrHost, string> {
  return { github: value("github"), gitlab: value("gitlab"), bitbucket: value("bitbucket") };
}

/** The `mr_tokens` map of the draft: only hosts with a secret. */
function tokenMap(tokens: Record<MrHost, string>): Partial<Record<MrHost, string>> {
  return Object.fromEntries(MR_HOSTS.filter((h) => tokens[h] !== "").map((h) => [h, tokens[h]]));
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

  const commits = org.commits?.attribution === undefined ? "default" : org.commits.attribution ? "on" : "off";
  if (draft.commits !== commits)
    input.commits = draft.commits === "default" ? null : { attribution: draft.commits === "on" };

  if (draft.merge !== org.merge) input.merge = draft.merge;

  const tokens = tokenMap(draft.mrTokens);
  const before = tokenMap(perHost((host) => org.mrTokens?.[host] ?? ""));
  if (MR_HOSTS.some((h) => tokens[h] !== before[h])) {
    const parsed = OrgConfigSchema.shape.mr_tokens.safeParse(tokens);
    if (parsed.success) input.mr_tokens = Object.keys(tokens).length === 0 ? null : parsed.data;
    else errors.mrTokens = "Pick a saved secret for each host";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, input: Object.keys(input).length > 1 ? input : undefined };
}

/** "Ashik <ashik@globex.example>", or undefined when no identity is set. */
export function identityLabel(org: Pick<OrgView, "identity">): string | undefined {
  return org.identity ? `${org.identity.name} <${org.identity.email}>` : undefined;
}
