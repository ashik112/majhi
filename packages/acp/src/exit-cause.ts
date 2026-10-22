/** What docker prints in front of its own failures, such as a mount whose source folder is gone. */
const DOCKER_PREFIX = "docker:";

/**
 * The line of a dead agent's stderr that says why: docker's own error when there is one (the first line that
 * starts with "docker:"), else the last line that is not empty. Chunks may hold several lines.
 */
export class ExitCause {
  private docker: string | undefined;
  private last: string | undefined;

  push(chunk: string): void {
    for (const raw of chunk.split("\n")) {
      const line = raw.trim();
      if (line === "") continue;
      this.last = line;
      if (this.docker === undefined && line.startsWith(DOCKER_PREFIX)) this.docker = line;
    }
  }

  /** The most informative line so far, undefined when nothing was printed. */
  line(): string | undefined {
    return this.docker ?? this.last;
  }
}
