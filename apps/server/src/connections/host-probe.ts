import net from "node:net";

/** What one try to open a port of the owner's computer ended in. Read from the socket's event and error code, never from text. */
export type PortAnswer = "open" | "closed" | "timeout" | "unreachable";

/** Opens a TCP connection to `address:port` and closes it again: whether anything listens there. */
export function probePort(address: string, port: number, timeoutMs = 4_000): Promise<PortAnswer> {
  return new Promise((done) => {
    const socket = net.connect({ host: address, port, timeout: timeoutMs });
    socket.once("connect", () => {
      socket.destroy();
      done("open");
    });
    socket.once("timeout", () => {
      socket.destroy();
      done("timeout");
    });
    socket.once("error", (err: NodeJS.ErrnoException) => {
      socket.destroy();
      done(err.code === "ECONNREFUSED" || err.code === "ECONNRESET" ? "closed" : "unreachable");
    });
  });
}
