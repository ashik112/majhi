import { PAGE_PATH, type PageName } from "@majhi/shared";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { AppSearch } from "@/router";

/** A link to another page, by name, keeping only the search params that have a value. */
export function PageLink({
  page,
  search,
  className,
  title,
  onClick,
  "aria-label": ariaLabel,
  "data-testid": testId,
  children,
}: {
  page: PageName;
  search?: AppSearch;
  className?: string;
  title?: string;
  onClick?: () => void;
  "aria-label"?: string;
  "data-testid"?: string;
  children: ReactNode;
}) {
  const props: { title?: string; "aria-label"?: string; "data-testid"?: string; onClick?: () => void } = {};
  if (testId) props["data-testid"] = testId;
  if (title) props.title = title;
  if (onClick) props.onClick = onClick;
  if (ariaLabel) props["aria-label"] = ariaLabel;
  return (
    <Link to={PAGE_PATH[page]} search={search ?? {}} className={className} {...props}>
      {children}
    </Link>
  );
}
