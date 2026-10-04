import { expect, type Page, test } from "@playwright/test";

/**
 * The Business screens at realistic volume (hundreds of people, dozens of entries and deadlines, long
 * names), at 1440 and 1100 wide, dark and light. Saved to BUSINESS_SHOTS (default e2e/screenshots).
 * The tests share one server and seed it first, so they run in order.
 */
const OUT = process.env.BUSINESS_SHOTS ?? "e2e/screenshots";

test.describe.configure({ mode: "serial" });

const FIRST = [
  "Ada",
  "Ben",
  "Chen",
  "Dana",
  "Eli",
  "Farah",
  "Gus",
  "Hana",
  "Ivan",
  "Jules",
  "Kai",
  "Lena",
  "Mo",
  "Nia",
  "Omar",
  "Pia",
];
const LAST = [
  "Northwind",
  "Okafor",
  "Lindqvist",
  "Marlowe",
  "Nakamura",
  "Quinn",
  "Rosales",
  "Stein",
  "Tran",
  "Varga",
];
const COMPANIES = [
  "Acme Labs",
  "Globex Ventures",
  "Northwind Traders",
  "Initech Capital",
  "Hooli Grants Office",
  "Umbrella Community",
  "Stark Industries Hackathon",
];
const KINDS = [
  "about",
  "product",
  "pricing",
  "positioning",
  "win",
  "metric",
  "bio",
  "asset",
  "faq",
  "policy",
] as const;
const RELATIONS = [
  "client",
  "lead",
  "investor",
  "partner",
  "hackathon",
  "grant",
  "community",
  "other",
] as const;
const ZONES = [
  "UTC",
  "America/Los_Angeles",
  "Europe/Berlin",
  "Asia/Kolkata",
  "Pacific/Auckland",
  "America/New_York",
];
const STAGES = ["new", "contacted", "talking", "proposal", "won", "lost"];

async function cmd(page: Page, name: string, body: unknown) {
  const res = await page.request.post(`/api/cmd/${name}`, { data: body });
  if (!res.ok()) throw new Error(`${name}: ${res.status()} ${await res.text()}`);
  return res.json();
}

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function seed(page: Page) {
  const titles = [
    "Company overview",
    "Founder bio, short",
    "Founder bio, long",
    "Pricing 2026",
    "Positioning against the incumbents",
    "Case study: Northwind rollout, 40 percent faster onboarding",
    "Metric: monthly recurring revenue",
    "FAQ: refunds and cancellations",
    "Security policy for customer data",
    "Brand kit and logos (zip)",
    "Product: the console",
    "Product: the captain add-on",
  ];
  const body = [
    "## Summary\n\nWe build a local workspace for running coding agents, with work kept apart per client.\n\n",
    "- Starts at **$20** a month for one seat\n- Team plan **$90** for five seats\n- Annual billing saves two months\n\n",
    "### Why it matters\n\nOnboarding a new client used to take two days of setup. With separate workspaces it takes about twenty minutes.\n",
  ].join("");
  for (let i = 0; i < 48; i++) {
    const t = titles[i % titles.length] ?? "Entry";
    await cmd(page, "kb.upsert", {
      kind: KINDS[i % KINDS.length],
      title: i < titles.length ? t : `${t} (${i})`,
      body: `${body}\n\nEntry ${i}.`,
      tags: i % 3 === 0 ? ["launch", "2026"] : ["grant"],
      sources: i % 4 === 0 ? ["https://acme.example/pricing"] : [],
      ...(i % 5 === 1 ? { org: "acme" } : i % 5 === 2 ? { org: "globex" } : {}),
      ...(i % 7 === 3 ? { verified: false } : {}),
    });
  }
  for (let i = 0; i < 320; i++) {
    const first = FIRST[i % FIRST.length] ?? "Ada";
    const last = LAST[(i * 7) % LAST.length] ?? "Quinn";
    const company = COMPANIES[i % COMPANIES.length] ?? "Acme Labs";
    const relation = RELATIONS[i % RELATIONS.length] ?? "other";
    await cmd(page, "crm.upsert", {
      name: `${first} ${last}${i % 41 === 0 ? " the Third of the Extraordinarily Long Surname Association" : ""}`,
      company,
      role: i % 3 === 0 ? "Head of Partnerships" : "Founder",
      emails: [
        `${first.toLowerCase()}.${last.toLowerCase()}${i}@${(company.split(" ")[0] ?? "acme").toLowerCase()}.example`,
      ],
      relation,
      ...(relation === "lead" || relation === "investor" ? { stage: STAGES[i % 6] } : {}),
      nextStep: i % 3 === 0 ? "Send the deck and a pricing sheet" : "",
      ...(i % 3 === 0 ? { nextDue: day((i % 21) - 6) } : {}),
      notes: "Met at the spring fair. Prefers short mails.",
      tags: i % 2 === 0 ? ["intro"] : ["speaker"],
      ...(i % 6 === 1 ? { org: "acme" } : i % 6 === 2 ? { org: "globex" } : {}),
    });
  }
  for (let i = 0; i < 36; i++) {
    await cmd(page, "deadlines.upsert", {
      kind: ["hackathon", "grant", "launch", "client", "renewal", "other"][i % 6],
      title:
        i % 9 === 0
          ? "Final submission for the Spring Open Source Hackathon with a very long official name"
          : `Deadline ${i}: ${["Grant round", "Launch day", "Renewal", "Client review"][i % 4]}`,
      due: i % 2 === 0 ? day(i - 8) : `${day(i - 8)}T17:00`,
      tz: ZONES[i % ZONES.length],
      source: "https://hackathon.example/rules",
      notes: "Check the rules page for the final time.",
      ...(i % 5 === 1 ? { org: "acme" } : i % 5 === 2 ? { org: "globex" } : {}),
    });
  }
  await cmd(page, "voice.set", {
    tone: "Plain, warm, direct. No hype, no exclamation marks.",
    length: "Replies: three sentences. Posts: under 220 characters.",
    use: ["ship", "local", "you"],
    avoid: ["revolutionary", "game-changing", "leverage"],
    signOffs: ["Thanks,", "Best,"],
    examples: ["Thanks for the note. The fix is in and ships on Thursday."],
    samples: ["Hi Dana, thanks for writing. Short answer: yes. We can have it ready by Friday."],
  });
  await cmd(page, "voice.set", {
    org: "acme",
    tone: "Slightly more formal, for enterprise buyers.",
    signOffs: ["Kind regards,"],
  });
  await cmd(page, "voice.propose", {
    org: "globex",
    tone: "Casual and quick.",
    why: "From the four posts you pasted.",
    use: ["hey"],
  });
}

async function shots(page: Page, name: string) {
  for (const scheme of ["dark", "light"] as const) {
    await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), scheme);
    for (const width of [1440, 1100]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${OUT}/business-${name}-${scheme}-${width}.png` });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
}

test("seed", async ({ page }) => {
  test.setTimeout(240_000);
  await seed(page);
});

test("Knowledge", async ({ page }) => {
  await page.goto("/knowledge?tab=knowledge");
  await expect(page.getByRole("listbox").getByRole("option").first()).toBeVisible();
  await shots(page, "knowledge");
  await page.getByPlaceholder("Search the knowledge base").fill("pricing starter");
  await expect(page.getByRole("listbox").getByRole("option").first()).toBeVisible();
  await shots(page, "knowledge-search");
});

test("People", async ({ page }) => {
  await page.goto("/knowledge?tab=people");
  await expect(page.getByRole("listbox").getByRole("option").first()).toBeVisible();
  await shots(page, "people");
  await page.getByRole("button", { name: "Edit" }).first().click();
  await shots(page, "people-edit");
});

test("Deadlines", async ({ page }) => {
  await page.goto("/knowledge?tab=deadlines");
  await expect(page.getByRole("listbox").getByRole("option").first()).toBeVisible();
  await shots(page, "deadlines");
});

test("Voice", async ({ page }) => {
  await page.goto("/knowledge?tab=voice");
  await expect(page.getByRole("listbox").getByRole("option").first()).toBeVisible();
  await page
    .getByRole("listbox")
    .getByRole("option", { name: /Globex/ })
    .click();
  await shots(page, "voice");
});
