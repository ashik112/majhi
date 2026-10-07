/**
 * Puts each proof shot beside the approved mockup's, left the mockup and right the real app, for the
 * screens E and C (and the board). Reads `MAJHI_PROOF_SHOTS`, writes `<shots>/side-by-side/`.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const SHOTS = process.env.MAJHI_PROOF_SHOTS ?? "/tmp/majhi-deploy-proof";
const MOCK = join(import.meta.dirname, "..", "marketing-assets", "ship-mockup", "shots");
const OUT = join(SHOTS, "side-by-side");
mkdirSync(OUT, { recursive: true });

// mockup file for each screen, size and theme: [dark 1440, dark 1100, light 1440, light 1100]
const PAIRS: { name: string; mock: Record<string, string> }[] = [
  {
    name: "E-deploy-targets",
    mock: {
      "dark-1440": "07-E-deploy-dark-1440",
      "dark-1100": "29-E-deploy-dark-1100",
      "light-1440": "52-E-deploy-light-1440",
      "light-1100": "74-E-deploy-light-1100",
    },
  },
  {
    name: "C-production-asks",
    mock: {
      "dark-1440": "12-C-shipping-dark-1440",
      "dark-1100": "34-C-shipping-dark-1100",
      "light-1440": "57-C-shipping-light-1440",
      "light-1100": "79-C-shipping-light-1100",
    },
  },
  {
    name: "B-board-asks",
    mock: {
      "dark-1440": "02-B-board-dark-1440",
      "dark-1100": "24-B-board-dark-1100",
      "light-1440": "47-B-board-light-1440",
      "light-1100": "69-B-board-light-1100",
    },
  },
];

const png = (path: string) => `data:image/png;base64,${readFileSync(path).toString("base64")}`;
const browser = await chromium.launch();
for (const { name, mock } of PAIRS) {
  for (const [key, file] of Object.entries(mock)) {
    const page = await browser.newPage({
      viewport: { width: key.endsWith("1440") ? 2900 : 2220, height: 900 },
    });
    await page.setContent(
      `<body style="margin:0;background:#888;display:flex;gap:20px"><img style="max-width:50%" src="${png(join(MOCK, `${file}.png`))}"><img style="max-width:50%" src="${png(join(SHOTS, `${name}-${key}.png`))}"></body>`,
    );
    await page.screenshot({ path: join(OUT, `${name}-${key}.png`), fullPage: true });
    await page.close();
  }
}
await browser.close();
console.log(`side by side in ${OUT}`);
