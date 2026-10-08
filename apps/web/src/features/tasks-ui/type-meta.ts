import { TASK_TYPE_LABEL, type TaskType, type TaskTyping } from "@majhi/shared";
import {
  Bug,
  CircleDashed,
  FlaskConical,
  Inbox,
  LifeBuoy,
  type LucideIcon,
  Megaphone,
  PenTool,
  Search,
  Sparkles,
  TriangleAlert,
  Wrench,
} from "lucide-react";

/** One icon per type. The icon and the color together name the type; the word sits beside it where there is room. */
export const TYPE_ICON: Record<TaskType, LucideIcon> = {
  bug: Bug,
  incident: TriangleAlert,
  feature: Sparkles,
  request: Inbox,
  research: Search,
  design: PenTool,
  test: FlaskConical,
  chore: Wrench,
  support: LifeBuoy,
  post: Megaphone,
};

/** The color of a type: a custom property set in styles.css for both themes. An untyped task is grey. */
export function typeColor(type: TaskType | undefined): string {
  return `var(--c-type-${type ?? "chore"})`;
}

export function typeLabel(typing: TaskTyping | undefined): string {
  return typing === undefined ? "Untyped" : TASK_TYPE_LABEL[typing.type];
}

/** Who said so, in the words of the owner's screen. */
export function typedBy(typing: TaskTyping | undefined): string {
  if (typing === undefined) return "No type yet";
  switch (typing.by) {
    case "owner":
      return "set by you";
    case "captain":
      return "set by the captain";
    case "intake":
      return "read from the task";
  }
}

export const UNTYPED_ICON = CircleDashed;
