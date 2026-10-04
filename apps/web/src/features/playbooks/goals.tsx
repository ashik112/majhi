import { BUSINESS, GOAL_STATUS_LABEL, type Goal, type PlaybookView } from "@majhi/shared";
import { Check, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SectionLabel } from "@/components/ui/section-label";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { useCreateGoal, useGoals, useRemoveGoal, useUpdateGoal } from "@/lib/playbook-queries";

function GoalRow({ goal, linked }: { goal: Goal; linked: number }) {
  const update = useUpdateGoal();
  const remove = useRemoveGoal();
  const toast = useToast();
  const fail = (e: unknown) =>
    toast("Could not change the goal", { detail: describeError(e), tone: "error" });
  const detail = [goal.metric, goal.target, goal.due === undefined ? undefined : `by ${goal.due}`]
    .filter((x) => x !== undefined)
    .join(" · ");
  return (
    <li className="flex min-w-0 flex-col gap-0.5 border-t border-line px-2.5 py-1.5 first:border-t-0">
      <div className="flex min-w-0 items-center gap-1">
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-base",
            goal.status === "active" ? "text-fg" : "text-fg-muted",
          )}
          title={goal.title}
        >
          {goal.title}
        </span>
        {goal.status === "proposed" && (
          <>
            <Button
              size="sm"
              variant="primary"
              disabled={update.isPending}
              onClick={() => update.mutate({ id: goal.id, status: "active" }, { onError: fail })}
            >
              <Check aria-hidden="true" />
              Confirm
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Drop ${goal.title}`}
              onClick={() => update.mutate({ id: goal.id, status: "dropped" }, { onError: fail })}
            >
              <X aria-hidden="true" />
            </Button>
          </>
        )}
        {goal.status === "active" && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => update.mutate({ id: goal.id, status: "done" }, { onError: fail })}
          >
            Done
          </Button>
        )}
        {goal.status !== "proposed" && (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Delete ${goal.title}`}
            disabled={remove.isPending}
            onClick={() => remove.mutate({ id: goal.id }, { onError: fail })}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        )}
      </div>
      <p className="m-0 truncate text-xs text-fg-faint">
        {goal.status === "proposed" ? "Proposed by the captain" : GOAL_STATUS_LABEL[goal.status]}
        {detail !== "" && ` · ${detail}`}
        {linked > 0 && ` · ${linked} ${linked === 1 ? "playbook" : "playbooks"}`}
        {goal.org === BUSINESS && " · whole business"}
      </p>
    </li>
  );
}

/**
 * Goals, a small section under the playbook list: what the work is for. The captain proposes goals
 * and the owner confirms them; a playbook is linked to one from its own page.
 */
export function GoalsSection({
  org,
  workspace,
  views,
}: {
  org: string;
  workspace: string;
  views: readonly PlaybookView[];
}) {
  const query = useGoals();
  const create = useCreateGoal();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [business, setBusiness] = useState(false);
  const goals = (query.data?.goals ?? []).filter(
    (g) => (g.org === org || g.org === BUSINESS) && g.status !== "dropped",
  );
  const submit = () => {
    const text = title.trim();
    if (text === "") return;
    create.mutate(
      { org: business ? BUSINESS : org, title: text },
      {
        onSuccess: () => {
          setTitle("");
          setAdding(false);
        },
        onError: (e) => toast("Could not add the goal", { detail: describeError(e), tone: "error" }),
      },
    );
  };
  return (
    <section aria-label="Goals" className="mt-1 border-t border-line pt-3">
      <div className="flex min-h-7 items-center gap-2 px-2.5">
        <SectionLabel className="flex-1">Goals</SectionLabel>
        {!adding && (
          <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
            <Plus aria-hidden="true" />
            Add
          </Button>
        )}
      </div>
      {adding && (
        <form
          className="flex flex-col gap-2 px-2.5 py-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Input
            aria-label="Goal"
            autoFocus
            placeholder={`What ${workspace} works toward`}
            value={title}
            maxLength={140}
            onChange={(e) => setTitle(e.target.value)}
          />
          <label className="flex items-center gap-2 text-sm text-fg-muted">
            <input type="checkbox" checked={business} onChange={(e) => setBusiness(e.target.checked)} />
            For the whole business
          </label>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="primary"
              type="submit"
              disabled={create.isPending || title.trim() === ""}
            >
              Add goal
            </Button>
            <Button size="sm" variant="ghost" type="button" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {goals.length === 0 && !adding ? (
        <p className="m-0 px-2.5 py-1 text-sm text-fg-muted text-pretty">
          No goals yet. Add one, or let the captain propose it.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {goals.map((g) => (
            <GoalRow key={g.id} goal={g} linked={views.filter((v) => v.goal === g.id).length} />
          ))}
        </ul>
      )}
    </section>
  );
}
