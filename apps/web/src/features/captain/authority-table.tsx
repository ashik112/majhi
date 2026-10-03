import type { Authority, AuthorityChoice, AuthorityRow, CaptainOrg } from "@majhi/shared";
import { Segmented } from "@/components/ui/segmented";
import { useToast } from "@/components/ui/toast";
import { useCaptainRules } from "@/lib/captain-queries";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { AUTHORITY_PRESETS, AUTHORITY_ROW_TEXT, AUTHORITY_ROWS_ORDER } from "./model";

const CHOICES = [
  { value: "decide", label: "Captain decides" },
  { value: "ask", label: "Ask me" },
] as const satisfies readonly { value: AuthorityChoice; label: string }[];

/**
 * Who decides what in one workspace: six rows, each "Captain decides" or "Ask me", saved on each
 * click, with two presets above. While Autonomous is off the rows keep what was chosen, and a muted
 * line says the captain asks about everything anyway.
 */
export function AuthorityTable({ org, autonomyOn }: { org: CaptainOrg; autonomyOn: boolean }) {
  const toast = useToast();
  const save = useCaptainRules();
  const change = (patch: Partial<Authority>, done: string) =>
    save.mutate(
      {
        input: { orgs: { [org.org]: { authority: patch } } },
        reason: `Owner changed who decides what in ${org.name}`,
      },
      {
        onSuccess: () => toast(done),
        onError: (error) => toast("Could not change it", { detail: describeError(error), tone: "error" }),
      },
    );
  const setRow = (row: AuthorityRow, value: AuthorityChoice) =>
    change(
      { [row]: value },
      `${org.name}: ${AUTHORITY_ROW_TEXT[row].label} is ${value === "decide" ? "the captain's" : "yours"}`,
    );
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-sm text-fg-soft">Who decides here?</span>
        <span className="flex shrink-0 items-center gap-3 text-sm">
          {AUTHORITY_PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              disabled={save.isPending}
              title={preset.help}
              onClick={() => change(preset.rows, `${org.name}: ${preset.label}`)}
              className="cursor-pointer rounded-md px-1 py-0.5 text-fg-muted underline decoration-line-bright underline-offset-[3px] hover:text-fg disabled:cursor-wait disabled:opacity-60"
            >
              {preset.label}
            </button>
          ))}
        </span>
      </div>
      {!autonomyOn && (
        <p className="text-sm text-fg-faint text-pretty">
          Autonomous is off, so the captain asks you about everything.
        </p>
      )}
      <div role="group" aria-label={`Who decides in ${org.name}`} className="flex min-w-0 flex-col">
        {AUTHORITY_ROWS_ORDER.map((row, i) => (
          <div
            key={row}
            className={cn(
              "flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1.5 py-1.5",
              i > 0 && "border-t border-line",
            )}
          >
            <span className="flex min-w-0 flex-1 basis-56 flex-col leading-snug">
              <span className="min-w-0 text-body text-fg">{AUTHORITY_ROW_TEXT[row].label}</span>
              <span className="min-w-0 text-xs text-fg-faint text-pretty">
                {AUTHORITY_ROW_TEXT[row].hint}
              </span>
            </span>
            <Segmented
              label={`${AUTHORITY_ROW_TEXT[row].label} in ${org.name}`}
              value={org.authority[row]}
              segments={CHOICES}
              onChange={(value) => {
                if (value !== org.authority[row]) setRow(row, value);
              }}
              className={cn("shrink-0", save.isPending && "opacity-70")}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
