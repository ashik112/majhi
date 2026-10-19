/**
 * A fake Telegram Bot API for the incident walk: `getUpdates` hands out what the walk queued (long poll of one
 * second), `sendMessage` records what majhi sent. Nothing reaches the real Telegram.
 */
import { createServer, type Server } from "node:http";

export interface TelegramSent {
  chat: string;
  text: string;
}

export class FakeTelegram {
  readonly sent: TelegramSent[] = [];
  private readonly queue: unknown[] = [];
  private nextId = 1;
  private server: Server | undefined;

  /** A private message from the owner to the bot. */
  say(chat: number, text: string): void {
    this.queue.push({
      update_id: this.nextId++,
      message: {
        message_id: this.nextId + 100,
        date: Math.floor(Date.now() / 1000),
        chat: { id: chat, type: "private", first_name: "Owner" },
        from: { id: chat, is_bot: false, first_name: "Owner" },
        text,
      },
    });
  }

  async listen(port: number): Promise<this> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const method = (req.url ?? "").split("/").at(-1) ?? "";
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as Record<string, unknown>;
        } catch {
          body = {};
        }
        const reply = (result: unknown) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, result }));
        };
        if (method === "getMe") return reply({ id: 900, first_name: "Acme bot", username: "acme_bot" });
        if (method === "getWebhookInfo") return reply({ url: "" });
        if (method === "getChatMemberCount") return reply(2);
        if (method === "getChatAdministrators") return reply([]);
        if (method === "sendMessage") {
          this.sent.push({ chat: String(body.chat_id), text: String(body.text) });
          return reply({ message_id: this.nextId++ + 1000 });
        }
        if (method === "getUpdates") {
          const take = () => {
            const out = this.queue.splice(0);
            return reply(out);
          };
          if (this.queue.length > 0) return take();
          setTimeout(take, 1000);
          return;
        }
        reply(true);
      });
    });
    await new Promise<void>((r) => this.server?.listen(port, "127.0.0.1", r));
    return this;
  }

  async close(): Promise<void> {
    await new Promise<void>((r) => (this.server === undefined ? r() : this.server.close(() => r())));
  }
}
