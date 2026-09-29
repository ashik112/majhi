import type { OrgView } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { checkOrgDraft, draftFromOrg, identityLabel } from "./model";

const org: OrgView = {
  id: "acme",
  name: "Acme",
  color: "#f0b455",
  key: "ACM",
  base: "develop",
  identity: { name: "Ashik", email: "ashik@acme.example" },
  accountCount: 1,
  agentCount: 2,
};

describe("checkOrgDraft", () => {
  it("has nothing to send when nothing changed", () => {
    expect(checkOrgDraft(org, draftFromOrg(org))).toEqual({ ok: true, input: undefined });
  });

  it("sends only the fields that changed", () => {
    const draft = { ...draftFromOrg(org), name: " Acme Corp ", key: "acme" };
    expect(checkOrgDraft(org, draft)).toEqual({
      ok: true,
      input: { id: "acme", name: "Acme Corp", key: "ACME" },
    });
  });

  it("clears base and identity when the fields are emptied", () => {
    const draft = { ...draftFromOrg(org), base: "", identityName: "", identityEmail: "" };
    expect(checkOrgDraft(org, draft)).toEqual({
      ok: true,
      input: { id: "acme", base: null, identity: null },
    });
  });

  it("says what is wrong instead of sending", () => {
    const draft = { ...draftFromOrg(org), name: " ", color: "blue", key: "1X", identityEmail: "nope" };
    const result = checkOrgDraft(org, draft);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Object.keys(result.errors).sort()).toEqual(["color", "identityEmail", "key", "name"]);
    }
  });

  it("wants a name and an email together", () => {
    const alone = { ...draftFromOrg({ ...org, identity: undefined }), identityEmail: "a@b.co" };
    const result = checkOrgDraft({ ...org, identity: undefined }, alone);
    expect(result).toEqual({ ok: false, errors: { identityName: "Give the name commits use" } });
  });

  it("sets an identity on an org that had none", () => {
    const bare = { ...org, identity: undefined };
    const draft = { ...draftFromOrg(bare), identityName: "Ashik", identityEmail: "a@acme.example" };
    expect(checkOrgDraft(bare, draft)).toEqual({
      ok: true,
      input: { id: "acme", identity: { name: "Ashik", email: "a@acme.example" } },
    });
  });
});

describe("identityLabel", () => {
  it("shows name and email, or nothing", () => {
    expect(identityLabel(org)).toBe("Ashik <ashik@acme.example>");
    expect(identityLabel({})).toBeUndefined();
  });
});
