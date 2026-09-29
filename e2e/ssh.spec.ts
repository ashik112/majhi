import { expect, type Page, test } from "@playwright/test";

// The host helper is not running in e2e, so these tests answer host.status, ssh.reload and ssh.unlock
// themselves. They run after the setup in the earlier specs, so /repos has its roots.
const PASSPHRASE = "correct-horse-battery";
const KEY = "~/.ssh/id_work";
const WAITING = { loaded: 0, needsPassphrase: [KEY], checkedAt: "2026-09-29T10:00:00.000Z" };
const DONE = { loaded: 1, needsPassphrase: [], checkedAt: "2026-09-29T10:01:00.000Z" };
const INFO = { version: "test", platform: "darwin", canRemount: false };

async function fakeHost(
  page: Page,
  state: { ssh: typeof WAITING | typeof DONE },
  unlock: (p: string) => boolean,
) {
  const json = (body: unknown, status = 200) => ({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
  await page.route("**/api/cmd/host.status", (route) =>
    route.fulfill(json({ connected: true, info: { ...INFO, ssh: state.ssh } })),
  );
  await page.route("**/api/cmd/ssh.reload", (route) => route.fulfill(json(state.ssh)));
  await page.route("**/api/cmd/ssh.unlock", async (route) => {
    const input = route.request().postDataJSON() as { key: string; passphrase: string };
    if (!unlock(input.passphrase)) {
      return route.fulfill(json({ error: `That passphrase did not unlock ${input.key}.` }, 400));
    }
    state.ssh = DONE;
    return route.fulfill(json(DONE));
  });
}

test("Repos shows one calm notice to unlock an SSH key, and it goes away once unlocked", async ({ page }) => {
  await fakeHost(page, { ssh: WAITING }, (p) => p === PASSPHRASE);
  await page.goto("/repos");

  const notice = page.getByRole("region", { name: "majhi cannot reach your git hosts over SSH yet." });
  await expect(notice).toBeVisible();
  const field = notice.getByLabel(/Unlock SSH key/);
  await expect(field).toHaveAttribute("type", "password");
  await expect(field).toHaveAttribute("autocomplete", "off");

  await field.fill("not-it");
  await notice.getByRole("button", { name: "Unlock" }).click();
  await expect(notice.getByRole("alert")).toHaveText(`That passphrase did not unlock ${KEY}.`);
  await expect(field).toHaveValue("");

  await notice.getByText("or run it yourself").click();
  await expect(notice.getByText(`ssh-add --apple-use-keychain ${KEY}`)).toBeVisible();
  await expect(page.getByText("not-it")).toHaveCount(0);

  await field.fill(PASSPHRASE);
  await notice.getByRole("button", { name: "Unlock" }).click();
  await expect(notice).toHaveCount(0);
  await expect(page.getByText(PASSPHRASE)).toHaveCount(0);
});

test("Check again reloads the keys, and Repos shows no notice when SSH works", async ({ page }) => {
  const state = { ssh: WAITING };
  await fakeHost(page, state, () => false);
  await page.goto("/repos");
  const notice = page.getByRole("region", { name: "majhi cannot reach your git hosts over SSH yet." });
  await expect(notice).toBeVisible();

  state.ssh = DONE;
  await notice.getByRole("button", { name: "Check again" }).click();
  await expect(notice).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Repos" })).toBeVisible();
  await expect(page.getByText("cannot reach your git hosts")).toHaveCount(0);
});

test("Repos names a git host that took none of the keys", async ({ page }) => {
  await page.route("**/api/cmd/host.status", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        connected: true,
        info: { ...INFO, ssh: DONE },
        sshHosts: [
          {
            host: "gitlab-ashik112",
            state: "auth-failed",
            detail: "The host did not accept any key ssh offered.",
          },
        ],
      }),
    }),
  );
  await page.goto("/repos");
  const notice = page.getByRole("region", { name: "majhi cannot reach your git hosts over SSH yet." });
  await expect(notice).toContainText("gitlab-ashik112 did not accept any SSH key");
});
