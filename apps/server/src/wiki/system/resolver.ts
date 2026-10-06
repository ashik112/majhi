/**
 * Who owns a service name a repo writes in an address. Every rule is an exact lookup on typed facts or on word
 * sets: nothing here matches text.
 */

/** The service names one project's compose and Kubernetes files give: the ones it builds, and every one it defines. */
export interface ProjectServices {
  id: string;
  /** Compose services built from this project's code (`build`): a URL host with that name means this project. */
  builds: ReadonlySet<string>;
  /** Every compose service and Kubernetes workload that is not a datastore. */
  defines: ReadonlySet<string>;
}

/** Lower-case words of a name: the runs of letters and digits (`acme-api`, `ACME_API_URL`). */
export function wordsOf(name: string): string[] {
  const words: string[] = [];
  let current = "";
  for (const ch of name.toLowerCase()) {
    const code = ch.codePointAt(0) ?? 0;
    const alnum = (code >= 48 && code <= 57) || (code >= 97 && code <= 122);
    if (alnum) current += ch;
    else if (current !== "") {
      words.push(current);
      current = "";
    }
  }
  if (current !== "") words.push(current);
  return words;
}

/** How a service name is tied to a project: a compose file builds it (`declared`), or a file only defines it (`config`). */
export interface ServiceOwner {
  project: string;
  basis: "declared" | "config";
}

export class Resolver {
  constructor(private readonly projects: readonly ProjectServices[]) {}

  /**
   * The project a host name belongs to, when the files prove it: a service that exactly one project's compose file
   * builds, else a service that exactly one project defines. The project that wrote the address never counts (its
   * own services are its own). Nothing else counts: not the words of a variable name, not the domain, not a port.
   * `undefined` when it is unknown or ambiguous.
   */
  ownerOfService(host: string, caller: string): ServiceOwner | undefined {
    const name = host.toLowerCase();
    const others = this.projects.filter((p) => p.id !== caller);
    const builders = others.filter((p) => p.builds.has(name));
    if (builders.length === 1 && builders[0] !== undefined)
      return { project: builders[0].id, basis: "declared" };
    if (builders.length > 1) return undefined;
    const definers = others.filter((p) => p.defines.has(name));
    return definers.length === 1 && definers[0] !== undefined
      ? { project: definers[0].id, basis: "config" }
      : undefined;
  }
}
