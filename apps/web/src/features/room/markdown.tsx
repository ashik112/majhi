import { mediaKindOfPath, taskFileUrl } from "@majhi/shared";
import { Fragment, type ReactNode } from "react";
import { type Block, type Inline, isWebHref, parseMarkdown, taskPathOf } from "./markdown-parse";
import { FileCard, type TaskFiles, TaskFileView } from "./media";

function inline(nodes: readonly Inline[], task: TaskFiles | undefined): ReactNode {
  return nodes.map((n, i) => span(n, i, task));
}

function span(n: Inline, key: number, task: TaskFiles | undefined): ReactNode {
  switch (n.t) {
    case "text":
      return <Fragment key={key}>{n.text}</Fragment>;
    case "code":
      return (
        <code key={key} className="rounded-xs bg-field px-1 py-px font-mono text-[0.88em] text-fg">
          {n.text}
        </code>
      );
    case "strong":
      return (
        <strong key={key} className="font-semibold text-fg">
          {inline(n.children, task)}
        </strong>
      );
    case "em":
      return <em key={key}>{inline(n.children, task)}</em>;
    case "image": {
      const path = taskPathOf(n.src, task?.folder);
      if (isWebHref(n.src)) {
        // Web images are not loaded into the room; they are a link the owner opens on purpose.
        return <FileCard key={key} href={n.src} name={n.alt || n.src} kind="link" />;
      }
      if (path === undefined || task === undefined) return <Fragment key={key}>{n.alt}</Fragment>;
      return (
        <TaskFileView key={key} taskId={task.id} taskPath={path} name={n.alt || path} onLoad={task.onLoad} />
      );
    }
    case "link": {
      if (isWebHref(n.href)) {
        return (
          <a
            key={key}
            href={n.href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue underline underline-offset-2 hover:text-fg"
          >
            {inline(n.children, task)}
          </a>
        );
      }
      const path = taskPathOf(n.href, task?.folder);
      if (path === undefined || task === undefined)
        return <Fragment key={key}>{inline(n.children, task)}</Fragment>;
      const label = n.children.map((c) => (c.t === "text" || c.t === "code" ? c.text : "")).join("") || path;
      return (
        <FileCard key={key} href={taskFileUrl(task.id, path)} name={label} kind={mediaKindOfPath(path)} />
      );
    }
  }
}

const HEADING_CLASS = {
  1: "text-lg font-semibold text-fg",
  2: "text-md font-semibold text-fg",
  3: "text-md font-semibold text-fg",
  4: "text-md font-medium text-fg",
  5: "text-md font-medium text-fg",
  6: "text-md font-medium text-fg-muted",
} as const;

function blocks(list: readonly Block[], task: TaskFiles | undefined): ReactNode {
  return list.map((b, i) => block(b, i, task));
}

function block(b: Block, key: number, task: TaskFiles | undefined): ReactNode {
  switch (b.t) {
    case "p":
      return (
        <p key={key} className="m-0 whitespace-pre-line">
          {inline(b.children, task)}
        </p>
      );
    case "h": {
      const Tag = `h${Math.min(6, b.level + 2)}` as "h3" | "h4" | "h5" | "h6";
      return (
        <Tag key={key} className={`m-0 ${HEADING_CLASS[b.level]}`}>
          {inline(b.children, task)}
        </Tag>
      );
    }
    case "code":
      return (
        <pre
          key={key}
          className="m-0 max-h-[420px] overflow-auto rounded-md border border-line-strong bg-sunken p-2.5 font-mono text-xs leading-5 text-fg-soft"
          data-lang={b.lang || undefined}
        >
          <code>{b.text}</code>
        </pre>
      );
    case "list": {
      const Tag = b.ordered ? "ol" : "ul";
      return (
        <Tag
          key={key}
          {...(b.ordered && b.start !== 1 ? { start: b.start } : {})}
          className={`m-0 flex flex-col gap-1 pl-5 ${b.ordered ? "list-decimal" : "list-disc"} marker:text-fg-faint`}
        >
          {b.items.map((item, j) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: list items have no ids and keep their order
            <li key={j} className="whitespace-pre-line">
              {inline(item, task)}
            </li>
          ))}
        </Tag>
      );
    }
    case "quote":
      return (
        <blockquote
          key={key}
          className="m-0 flex flex-col gap-2 border-l-2 border-line-strong pl-3 text-fg-muted"
        >
          {blocks(b.children, task)}
        </blockquote>
      );
    case "hr":
      return <hr key={key} className="m-0 border-line-strong" />;
  }
}

/** Agent text as React elements. Never touches innerHTML, and only web and mail links are clickable. */
export function Markdown({ text, task }: { text: string; task?: TaskFiles | undefined }) {
  return <div className="flex flex-col gap-2.5 break-words">{blocks(parseMarkdown(text), task)}</div>;
}
