import {
  AppWindow,
  Check,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Clock,
  Cpu,
  Database,
  FileCode,
  Globe,
  Inbox,
  Layers,
  ListChecks,
  type LucideIcon,
  Route,
  Server,
  Sparkles,
  Terminal,
  User,
} from "lucide-react";
import type { CSSProperties } from "react";
import { LOGOS } from "./logos.generated";

/** What starts something: the four kinds of entry point. */
export const TRIGGERS = ["HTTP", "SCHEDULE", "QUEUE", "COMMAND"] as const;
export type Trigger = (typeof TRIGGERS)[number];

const TRIGGER_ICON: Record<Trigger, LucideIcon> = {
  HTTP: Globe,
  SCHEDULE: Clock,
  QUEUE: Inbox,
  COMMAND: Terminal,
};

const ROLE_ICON: Record<string, LucideIcon> = {
  App: AppWindow,
  Service: Server,
  Queue: ListChecks,
  Worker: Cpu,
  Database,
  Cache: Database,
  Library: Layers,
  Outside: Globe,
  Connection: Route,
  Function: FileCode,
  Entry: Globe,
};

const NAMED_ICON = {
  layers: Layers,
  route: Route,
  database: Database,
  globe: Globe,
  file: FileCode,
  check: Check,
  user: User,
  spark: Sparkles,
  chev: ChevronRight,
  fold: ChevronsDownUp,
  expand: ChevronsUpDown,
  list: ListChecks,
  app: AppWindow,
} as const;
export type NamedIcon = keyof typeof NAMED_ICON;

/** A line icon of the design, 16 px by default. */
export function Li({ n }: { n: NamedIcon }) {
  const I = NAMED_ICON[n];
  return <I className="i ri" strokeWidth={1.6} aria-hidden="true" />;
}

export function TriggerIcon({ kind }: { kind: Trigger }) {
  const I = TRIGGER_ICON[kind];
  return <I className="i ri" strokeWidth={1.6} aria-hidden="true" />;
}

export function RoleIcon({ of }: { of: string }) {
  const I = ROLE_ICON[of] ?? Server;
  return <I className="i ri" strokeWidth={1.6} aria-hidden="true" />;
}

/**
 * A brand's logo in the muted text color, its own color on hover or selection (read through `--bc`, blended
 * with the text color so it stays readable on both themes). A brand Simple Icons does not carry gets a
 * letter tile.
 */
export function Logo({ name }: { name: string }) {
  const logo = LOGOS[name];
  if (logo === undefined) {
    return (
      <span className="lg tile" style={{ "--bc": "var(--fg)" } as CSSProperties} aria-hidden="true">
        {name.slice(0, 1).toUpperCase()}
      </span>
    );
  }
  return (
    <span
      className="lg"
      style={{ "--bc": `color-mix(in srgb, #${logo.hex} 72%, var(--fg))` } as CSSProperties}
      aria-hidden="true"
    >
      <svg viewBox="0 0 24 24" role="img" aria-label={name}>
        <title>{name}</title>
        <path d={logo.path} />
      </svg>
    </span>
  );
}

/** A store, a stack item or an outside service: the logo and the name, or the logo alone with the name as its tooltip. */
export function Tag({
  name,
  out = false,
  iconOnly = false,
}: {
  name: string;
  out?: boolean;
  iconOnly?: boolean;
}) {
  return (
    <span className={`chip ${out ? "out" : ""} ${iconOnly ? "ic" : ""}`} title={iconOnly ? name : undefined}>
      <Logo name={name} />
      {iconOnly ? null : name}
    </span>
  );
}

/** The role badge: an icon and the role, or the icon alone (the role is its tooltip). */
export function RoleBadge({
  label,
  cls,
  iconOnly = false,
  small = false,
}: {
  label: string;
  cls: string;
  iconOnly?: boolean;
  small?: boolean;
}) {
  return (
    <span
      className={`bdg ${cls}`}
      style={small ? { height: 18 } : undefined}
      title={iconOnly ? label : undefined}
    >
      <RoleIcon of={label} />
      {iconOnly ? null : label}
    </span>
  );
}
