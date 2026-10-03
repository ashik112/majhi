import type { TrackerConfig, TrackerItem, TrackerTestResult } from "@majhi/shared";
import { z } from "zod";
import { fitItem, isoTime, parse, request } from "./http.ts";
import { type TrackerAdapter, type TrackerAdapterInit, TrackerError } from "./types.ts";

type ClickUpConfig = Extract<TrackerConfig, { type: "clickup" }>;

const API = "https://api.clickup.com/api/v2";
const MAX_ITEMS = 100;

const TaskSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  text_content: z.string().nullish(),
  description: z.string().nullish(),
  url: z.string(),
  status: z.looseObject({ status: z.string(), type: z.string().nullish() }),
  assignees: z.array(z.looseObject({ username: z.string().nullish() })).nullish(),
  tags: z.array(z.looseObject({ name: z.string() })).nullish(),
  date_updated: z.union([z.string(), z.number()]),
});
type Task = z.infer<typeof TaskSchema>;

const TasksSchema = z.looseObject({ tasks: z.array(TaskSchema) });
const UserSchema = z.looseObject({
  user: z.looseObject({ id: z.union([z.number(), z.string()]), username: z.string() }),
});
const ListSchema = z.looseObject({
  name: z.string(),
  statuses: z.array(z.looseObject({ status: z.string() })).nullish(),
});

/** ClickUp through API v2, signed in with a personal token. */
export class ClickUpAdapter implements TrackerAdapter {
  private readonly list: string;

  constructor(private readonly init: TrackerAdapterInit<ClickUpConfig>) {
    this.list = encodeURIComponent(init.config.list);
  }

  async pull(opts: { assignedToMe: boolean }): Promise<TrackerItem[]> {
    let query = "include_closed=false&subtasks=true&order_by=updated&reverse=true&page=0";
    if (opts.assignedToMe) query += `&assignees[]=${encodeURIComponent(String((await this.user()).id))}`;
    const data = await this.call(`/list/${this.list}/task?${query}`);
    return parse(TasksSchema, data, "the ClickUp tasks")
      .tasks.slice(0, MAX_ITEMS)
      .map((task) => item(task));
  }

  async get(key: string): Promise<TrackerItem> {
    return item(await this.task(key));
  }

  async comment(key: string, text: string): Promise<void> {
    await this.call(`/task/${encodeURIComponent(key)}/comment`, "POST", {
      comment_text: text,
      notify_all: false,
    });
  }

  async setStatus(key: string, status: string): Promise<void> {
    const list = parse(ListSchema, await this.call(`/list/${this.list}`), "the ClickUp list");
    const names = (list.statuses ?? []).map((s) => s.status);
    const match = names.find((name) => name.toLowerCase() === status.trim().toLowerCase());
    if (match === undefined) {
      throw new TrackerError(
        `The ClickUp list "${list.name}" has no status "${status}". Its statuses are: ${names.join(", ")}.`,
      );
    }
    await this.call(`/task/${encodeURIComponent(key)}`, "PUT", { status: match });
  }

  async link(key: string, url: string, title: string): Promise<void> {
    await this.comment(key, `${title}: ${url}`);
  }

  async create(input: { title: string; body: string }): Promise<TrackerItem> {
    const data = await this.call(`/list/${this.list}/task`, "POST", {
      name: input.title,
      markdown_description: input.body,
    });
    return item(parse(TaskSchema, data, "the new ClickUp task"));
  }

  async test(): Promise<TrackerTestResult> {
    try {
      const user = await this.user();
      const list = parse(ListSchema, await this.call(`/list/${this.list}`), "the ClickUp list");
      return { ok: true, detail: `Signed in as ${user.username}, list ${list.name}` };
    } catch (err) {
      if (err instanceof TrackerError) return { ok: false, detail: err.message };
      throw err;
    }
  }

  private async user() {
    return parse(UserSchema, await this.call("/user"), "the ClickUp account").user;
  }

  private async task(key: string): Promise<Task> {
    return parse(TaskSchema, await this.call(`/task/${encodeURIComponent(key)}`), `ClickUp task ${key}`);
  }

  private call(path: string, method: "GET" | "POST" | "PUT" = "GET", body?: unknown): Promise<unknown> {
    return request(this.init, `${API}${path}`, {
      method,
      body,
      headers: { Authorization: this.init.token, Accept: "application/json" },
    });
  }
}

function item(task: Task): TrackerItem {
  const assignee = task.assignees?.[0]?.username;
  const type = task.status.type?.toLowerCase();
  return fitItem({
    key: task.id,
    title: task.name,
    body: task.text_content ?? task.description ?? "",
    url: task.url,
    status: task.status.status,
    closed: type === "closed" || type === "done",
    ...(assignee ? { assignee } : {}),
    labels: (task.tags ?? []).map((tag) => tag.name),
    // ClickUp gives the time as milliseconds since the epoch, in a string.
    updatedAt: isoTime(
      /^\d+$/.test(String(task.date_updated)) ? Number(task.date_updated) : task.date_updated,
    ),
  });
}
