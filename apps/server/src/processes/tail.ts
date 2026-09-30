/** Output kept per process: the last lines, at most this many and this many bytes. */
export const TAIL_LINES = 200;
export const TAIL_BYTES = 64 * 1024;

// Colors and cursor moves: a dev server's output reads as plain text in the card.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point.
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g;
const PORT = /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})\b/;

/**
 * The end of a process's stdout and stderr together, bounded in lines and bytes. A line still
 * being written counts too. A carriage return (a progress bar) keeps only what follows it.
 */
export class OutputTail {
  private lines: string[] = [];
  private bytes = 0;
  private partial = "";

  write(chunk: string): void {
    const text = this.partial + chunk.replace(ANSI, "");
    const parts = text.split("\n");
    this.partial = clip(parts.pop() ?? "");
    for (const line of parts) this.push(line);
  }

  /** A line of majhi's own, like why the process did not start. */
  note(line: string): void {
    if (this.partial !== "") {
      this.push(this.partial);
      this.partial = "";
    }
    this.push(line);
  }

  /** The last `n` lines, the partial one included. */
  last(n: number = TAIL_LINES): string[] {
    const all = this.partial === "" ? this.lines : [...this.lines, lastSegment(this.partial)];
    return all.slice(-n);
  }

  clear(): void {
    this.lines = [];
    this.bytes = 0;
    this.partial = "";
  }

  private push(raw: string): void {
    const line = clip(lastSegment(raw.replace(/\r$/, "")));
    this.lines.push(line);
    this.bytes += Buffer.byteLength(line) + 1;
    while (this.lines.length > TAIL_LINES || (this.bytes > TAIL_BYTES && this.lines.length > 1)) {
      const dropped = this.lines.shift() ?? "";
      this.bytes -= Buffer.byteLength(dropped) + 1;
    }
  }
}

function lastSegment(line: string): string {
  const at = line.lastIndexOf("\r");
  return at === -1 ? line : line.slice(at + 1);
}

/** One line never takes more than the whole budget. */
function clip(line: string): string {
  return line.length > TAIL_BYTES ? line.slice(-TAIL_BYTES) : line;
}

/** The first local port a chunk of output names, like `http://localhost:5173/`. */
export function findPort(chunk: string): number | undefined {
  const match = PORT.exec(chunk.replace(ANSI, ""));
  const port = match?.[1] === undefined ? undefined : Number(match[1]);
  return port !== undefined && port > 0 && port < 65_536 ? port : undefined;
}
