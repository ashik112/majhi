import type { CSSProperties, ReactNode } from "react";
import type { Lamp as LampState } from "./model";
import { wsVar } from "./model";

/** A still status dot. What it looks like in each theme is in console.css; the word beside it says it too. */
export function ConsoleLamp({ state, dim = false }: { state: LampState; dim?: boolean }) {
  return <span className="cs-lamp" data-state={state} data-dim={dim || undefined} aria-hidden="true" />;
}

/** The style that hands a workspace's hue to `.cs-p`, `.cs-wsdot` and `.cs-wsname`. */
export function wsStyle(hues: ReadonlyMap<string, number>, org: string | undefined): CSSProperties {
  return { "--ws": wsVar(hues, org) } as CSSProperties;
}

/** A square in the workspace's hue and its name: the identity of a workspace, never its key. */
export function WorkspaceTag({
  name,
  org,
  hues,
}: {
  name: string;
  org: string | undefined;
  hues: ReadonlyMap<string, number>;
}) {
  return (
    <span className="inline-flex items-center gap-1.5" style={wsStyle(hues, org)}>
      <span className="cs-wsdot" aria-hidden="true" />
      <span className="cs-wsname">{name}</span>
    </span>
  );
}

/** `project · Name`, the project in its workspace's color. With no prefix, only the name. */
export function RowTitle({ prefix, name }: { prefix: string | undefined; name: string }) {
  return (
    <span className="cs-title">
      {prefix !== undefined && prefix !== "" && <span className="cs-p">{prefix} ·</span>}
      <span className="cs-s">{name}</span>
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <span className="cs-kbd">{children}</span>;
}

export function Chevron() {
  return (
    <svg className="cs-chev" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

/** The button in a pane's header that folds the pane to its rail. */
export function MinimizeButton({ name, keys, onClick }: { name: string; keys: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="cs-fold"
      aria-label={`Minimize ${name}`}
      aria-keyshortcuts={keys}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M7.5 2.5 4 6l3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    </button>
  );
}

/** A folded pane: a 44px rail with its name and count. A click (or its key) brings the pane back. */
export function PaneRail({
  pane,
  name,
  count,
  lamp,
  keys,
  onOpen,
  note,
}: {
  pane: "needs" | "work";
  name: string;
  count: number;
  lamp: LampState;
  keys: string;
  /** Absent when the pane has nothing to show and so cannot be opened. */
  onOpen?: (() => void) | undefined;
  /** Said after the name, for a rail that is not the owner's choice ("all clear"). */
  note?: string | undefined;
}) {
  return (
    <section className="cs-pane" data-pane={pane} data-rail aria-label={name}>
      <button
        type="button"
        className="cs-vrail"
        aria-label={`Show ${name}`}
        aria-keyshortcuts={keys}
        disabled={onOpen === undefined}
        onClick={onOpen}
      >
        <ConsoleLamp state={lamp} dim={count === 0} />
        <span className="cs-w">{note === undefined ? name : `${name} · ${note}`}</span>
        <span className="cs-n">{count}</span>
      </button>
    </section>
  );
}

export function Btn({
  children,
  primary = false,
  ghost = false,
  keyHint,
  onClick,
  disabled = false,
  className = "",
  ...rest
}: {
  children: ReactNode;
  primary?: boolean;
  ghost?: boolean;
  keyHint?: string | undefined;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "children" | "className" | "disabled">) {
  return (
    <button
      type="button"
      {...rest}
      className={`cs-btn ${className}`.trim()}
      data-primary={primary || undefined}
      data-ghost={ghost || undefined}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {children}
      {keyHint !== undefined && <Kbd>{keyHint}</Kbd>}
    </button>
  );
}
