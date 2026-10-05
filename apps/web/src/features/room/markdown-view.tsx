import { type ReactNode, useMemo } from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import { AgentRef } from "@/features/agent-drawer/agent-ref";
import { TaskRef } from "@/features/task-drawer/task-ref";
import { useAgentIndex } from "@/lib/agent-index";
import { cn } from "@/lib/cn";
import { useTaskIds } from "@/lib/task-queries";
import { CopyButton } from "./copy-button";
import { useHighlight } from "./highlight";
import { classifyTarget, presentFileLink, safeHref } from "./links";
import { TaskFileLink, type TaskFiles, TaskFileView } from "./media";
import { AGENT_REF_PROP, remarkTaskRefs, TASK_REF_PROP } from "./task-refs";

export type MarkdownSize = "chat" | "document";

interface Scope {
  task: TaskFiles | undefined;
  baseDir: string;
}

// biome-ignore lint/suspicious/noExplicitAny: hast nodes are walked structurally and only a few fields are read
type Hast = any;

/** All text under a hast node, for the copy button and for a link's label. */
function textOf(node: Hast): string {
  if (node === undefined || node === null) return "";
  if (node.type === "text") return String(node.value);
  return Array.isArray(node.children) ? node.children.map(textOf).join("") : "";
}

const isBlank = (node: Hast) => node.type === "text" && String(node.value).trim() === "";

/** True when a paragraph holds one link and nothing else, so it stands on its own line. */
function aloneLink(node: Hast): Hast | undefined {
  const kids = (node?.children ?? []).filter((n: Hast) => !isBlank(n));
  const only = kids.length === 1 ? kids[0] : undefined;
  return only?.type === "element" && only.tagName === "a" ? only : undefined;
}

function languageOf(pre: Hast): string {
  const code = (pre?.children ?? []).find((n: Hast) => n.type === "element" && n.tagName === "code");
  const classes: unknown = code?.properties?.className;
  const found = Array.isArray(classes)
    ? classes.map(String).find((c) => c.startsWith("language-"))
    : undefined;
  return found?.slice("language-".length) ?? "";
}

function CodeBlock({ node, children }: { node: Hast; children?: ReactNode }) {
  const lang = languageOf(node);
  const source = textOf(node).replace(/\n$/, "");
  return (
    <div className="md-code">
      <div className="md-code-head">
        <span className="font-mono">{lang || "text"}</span>
        <CopyButton text={source} label={`Copy ${lang || "code"}`} />
      </div>
      <pre>{children}</pre>
    </div>
  );
}

function buildComponents({ task, baseDir }: Scope): Components {
  return {
    a({ href, children }) {
      const target =
        href === undefined ? { type: "none" as const } : classifyTarget(href, task?.folder, baseDir);
      if (target.type === "web") {
        return (
          <a href={target.href} target="_blank" rel="noopener noreferrer" className="md-link">
            {children}
          </a>
        );
      }
      if (target.type === "file" && task !== undefined) {
        return <TaskFileLink path={target.path} kind={target.kind} label={children} project={task.project} />;
      }
      return <>{children}</>;
    },
    p({ node, children }) {
      const link = aloneLink(node);
      const href = link?.properties?.href;
      if (link !== undefined && typeof href === "string" && task !== undefined) {
        const target = classifyTarget(href, task.folder, baseDir);
        if (target.type === "file") {
          const name = textOf(link).trim() || target.path;
          const shown = presentFileLink(target.kind, true);
          return (
            <div className="md-own-line">
              {shown === "player" ? (
                <TaskFileView taskId={task.id} taskPath={target.path} name={name} onLoad={task.onLoad} />
              ) : (
                <TaskFileLink
                  path={target.path}
                  kind={target.kind}
                  label={name}
                  card
                  project={task.project}
                />
              )}
            </div>
          );
        }
      }
      return <p>{children}</p>;
    },
    img({ src, alt }) {
      const target =
        typeof src === "string" ? classifyTarget(src, task?.folder, baseDir) : { type: "none" as const };
      const name = alt ?? "";
      if (target.type === "web") {
        // Web images are not loaded into the room; they are a link the owner opens on purpose.
        return (
          <a href={target.href} target="_blank" rel="noopener noreferrer" className="md-link">
            {name || target.href}
          </a>
        );
      }
      if (target.type === "file" && task !== undefined) {
        if (target.kind === "image" || target.kind === "video" || target.kind === "audio") {
          return (
            <TaskFileView
              taskId={task.id}
              taskPath={target.path}
              name={name || target.path}
              onLoad={task.onLoad}
            />
          );
        }
        return (
          <TaskFileLink
            path={target.path}
            kind={target.kind}
            label={name || target.path}
            project={task.project}
          />
        );
      }
      return <>{name}</>;
    },
    span({ node, children, ...rest }) {
      const id = node?.properties?.[TASK_REF_PROP];
      if (typeof id === "string") return <TaskRef id={id}>{children}</TaskRef>;
      const agent = node?.properties?.[AGENT_REF_PROP];
      if (typeof agent === "string") return <AgentRef id={agent} />;
      return <span {...rest}>{children}</span>;
    },
    pre({ node, children }) {
      return <CodeBlock node={node}>{children}</CodeBlock>;
    },
    table({ children }) {
      return (
        <div className="md-table">
          <table>{children}</table>
        </div>
      );
    },
  };
}

/** react-markdown's own url filter is replaced by the room's: web, mail and task paths only. */
const urlTransform = (url: string) => safeHref(url) ?? "";

/**
 * Agent text as React elements. No raw HTML, never innerHTML. Only http(s) and mail links and paths
 * in the task folder become links; a link to a task file opens in the in-app viewer. Ids of known
 * tasks open the task drawer.
 */
export function Markdown({
  text,
  task,
  baseDir = "",
  size = "chat",
}: {
  text: string;
  task?: TaskFiles | undefined;
  /** Folder of the document being shown, relative to the task folder, for relative links. */
  baseDir?: string;
  size?: MarkdownSize;
}) {
  const highlight = useHighlight();
  const components = useMemo(() => buildComponents({ task, baseDir }), [task, baseDir]);
  const known = useTaskIds();
  const index = useAgentIndex();
  const agents = useMemo(() => new Set(index.keys()), [index]);
  const remarkPlugins = useMemo<Options["remarkPlugins"]>(
    () => [remarkGfm, [remarkTaskRefs, { known, agents }]],
    [known, agents],
  );
  return (
    <div className={cn("md", size === "document" && "md-doc")}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={highlight ?? []}
        components={components}
        urlTransform={urlTransform}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
