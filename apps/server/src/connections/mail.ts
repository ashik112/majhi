import { isIP, connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

/** Longest line a mail server may send before majhi gives up on it. */
const MAX_LINE = 64 * 1024;

function tls(host: string, port: number): Socket {
  return tlsConnect({ host, port, ...(isIP(host) === 0 ? { servername: host } : {}) });
}

/** Calls `onLine` for each line the server sends, without the line break. */
function readLines(socket: Socket, onLine: (line: string) => void): void {
  let buffer = "";
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      onLine(line);
    }
    if (buffer.length > MAX_LINE) socket.destroy(new Error("The server sent a line that is too long."));
  });
}

/** Runs one exchange on a socket: `step` gets each line and says when it is done. Never leaves it open. */
function exchange<T>(
  socket: Socket,
  where: string,
  timeoutMs: number,
  step: (line: string, finish: (result: T) => void, fail: (message: string) => void) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const end = (fn: () => void) => {
      if (settled) return;
      settled = true;
      // Sends what is written (a LOGOUT, a QUIT) before closing, and never waits long for the server.
      socket.end();
      setTimeout(() => socket.destroy(), 1000).unref();
      fn();
    };
    const fail = (message: string) => end(() => reject(new Error(message)));
    socket.setTimeout(timeoutMs, () => fail(`${where} did not answer in time.`));
    socket.on("error", (err) => fail(`Cannot reach ${where}: ${err.message}`));
    socket.on("close", () => fail(`${where} closed the connection.`));
    readLines(socket, (line) => {
      if (!settled) step(line, (result) => end(() => resolve(result)), fail);
    });
  });
}

/**
 * Signs in to an IMAP server over TLS, then logs out. User and password go as literals, so no
 * character needs quoting. Throws with what went wrong, never with the password.
 */
export function imapLogin(input: {
  host: string;
  port: number;
  user: string;
  password: string;
  timeoutMs: number;
}): Promise<void> {
  const where = `${input.host}:${input.port}`;
  const socket = tls(input.host, input.port);
  const user = Buffer.from(input.user, "utf8");
  const password = Buffer.from(input.password, "utf8");
  let state: "greeting" | "user" | "password" | "result" = "greeting";
  return exchange<void>(socket, where, input.timeoutMs, (line, finish, fail) => {
    if (state === "greeting") {
      if (/^\* PREAUTH/i.test(line)) return finish();
      if (!/^\* OK/i.test(line)) return fail(`${where} did not greet as an IMAP server.`);
      state = "user";
      socket.write(`a1 LOGIN {${user.length}}\r\n`);
      return;
    }
    if (/^a1 (NO|BAD)/i.test(line)) {
      const why = line.replace(/^a1 (NO|BAD)\s*/i, "").trim();
      return fail(`${input.host} refused the login${why ? `: ${why}` : "."}`);
    }
    if (state === "user" && line.startsWith("+")) {
      state = "password";
      socket.write(Buffer.concat([user, Buffer.from(` {${password.length}}\r\n`)]));
    } else if (state === "password" && line.startsWith("+")) {
      state = "result";
      socket.write(Buffer.concat([password, Buffer.from("\r\n")]));
    } else if (state === "result" && /^a1 OK/i.test(line)) {
      socket.write("a2 LOGOUT\r\n");
      finish();
    }
    // Untagged lines, like `* CAPABILITY`, are skipped.
  });
}

/**
 * Reads an SMTP server's greeting: TLS from the start on 465, plain on other ports (587 switches
 * to TLS later). Sends no credentials. Returns the greeting line.
 */
export function smtpGreeting(input: { host: string; port: number; timeoutMs: number }): Promise<string> {
  const where = `${input.host}:${input.port}`;
  const socket =
    input.port === 465 ? tls(input.host, input.port) : netConnect({ host: input.host, port: input.port });
  return exchange<string>(socket, where, input.timeoutMs, (line, finish, fail) => {
    if (/^220-/.test(line)) return;
    if (/^220 /.test(line) || line === "220") {
      socket.write("QUIT\r\n");
      return finish(line);
    }
    fail(`${where} did not greet as an SMTP server.`);
  });
}
