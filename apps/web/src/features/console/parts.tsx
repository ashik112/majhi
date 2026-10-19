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
