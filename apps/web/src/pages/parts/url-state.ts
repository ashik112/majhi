import { useNavigate, useSearch } from "@tanstack/react-router";
import type { AppSearch } from "@/router";

type SearchName =
  | "agent"
  | "account"
  | "connection"
  | "org"
  | "create"
  | "project"
  | "tab"
  | "section"
  | "item"
  | "skill";

/** A search param of the current URL, and a setter that keeps the others and replaces history. */
export function useSearchParam(name: SearchName): [string | undefined, (value: string | undefined) => void] {
  const search: AppSearch = useSearch({ strict: false });
  const navigate = useNavigate();
  const value = search[name];
  const set = (next: string | undefined) => {
    void navigate({
      to: ".",
      search: (prev: AppSearch): AppSearch => {
        const { [name]: _old, ...rest } = prev;
        return next === undefined ? rest : { ...rest, [name]: next };
      },
      replace: true,
    });
  };
  return [value, set];
}
