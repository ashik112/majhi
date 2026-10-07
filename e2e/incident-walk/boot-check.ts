import { boot, cmd, shot, sleep } from "./walk.ts";

const w = await boot();
try {
  console.log(JSON.stringify((await cmd("config.get")).orgs ?? "no orgs").slice(0, 300));
  console.log(await shot(w, "00-boot"));
  console.log(JSON.stringify(await cmd("chat.list")).slice(0, 600));
  await sleep(2000);
} finally {
  await w.close();
}
process.exit(0);
