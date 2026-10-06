import { HIGHLIGHT_OPTIONS } from "@majhi/shared";
import { useEffect, useState } from "react";
import type { Options } from "react-markdown";

type Plugins = NonNullable<Options["rehypePlugins"]>;

let loaded: Plugins | undefined;
let pending: Promise<Plugins> | undefined;

function load(): Promise<Plugins> {
  // highlight.js and its languages are a chunk of their own: text shows first, colors follow.
  pending ??= import("rehype-highlight").then((m) => {
    loaded = [[m.default, HIGHLIGHT_OPTIONS]];
    return loaded;
  });
  return pending;
}

/** The syntax highlighting plugin once it has loaded, undefined until then. */
export function useHighlight(): Plugins | undefined {
  const [plugins, setPlugins] = useState<Plugins | undefined>(loaded);
  useEffect(() => {
    if (loaded) {
      setPlugins(loaded);
      return;
    }
    let live = true;
    load()
      .then((p) => {
        if (live) setPlugins(p);
      })
      .catch(() => {
        // Without the chunk the code stays plain, which is fine.
      });
    return () => {
      live = false;
    };
  }, []);
  return plugins;
}
