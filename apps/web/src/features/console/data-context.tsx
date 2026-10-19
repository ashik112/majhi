import { createContext, type ReactNode, useContext } from "react";
import { useNow } from "@/lib/use-now";
import { type ConsoleData, useConsoleData } from "./use-console";

const Context = createContext<ConsoleData | null>(null);

/** One read of everything the console and the top bar draw, so they cannot disagree. Mounted in the shell. */
export function ConsoleDataProvider({ children }: { children: ReactNode }) {
  // The minute is only for "Done today" and ages; every change of data arrives as an event.
  const now = useNow(60_000);
  return <Context.Provider value={useConsoleData(now)}>{children}</Context.Provider>;
}

export function useConsole(): ConsoleData {
  const data = useContext(Context);
  if (data === null) throw new Error("useConsole needs a <ConsoleDataProvider> above it");
  return data;
}
