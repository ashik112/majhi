import type { CardCommands, ProjectCard, ReadinessItem } from "@majhi/shared";
import { Check, MessageSquare, RefreshCw, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DetailSection } from "@/components/ui/list-detail";
import { SectionLabel } from "@/components/ui/section-label";
import { useBoss } from "@/features/boss/boss-context";
import { wsTab } from "@/features/captain/panel-model";
import { useProjectCards, useRefreshCard } from "@/lib/card-queries";
import { formatAgo } from "@/lib/format";

/** What the captain is asked when a project's card has no description: read the repo and write the line. */
export function describeProjectAsk(project: string): string {
  return `Write the README opening line for ${project}: one plain sentence on what it is, from its code and docs. Add it at the top of its README on a branch, and tell me what you wrote.`;
}

const COMMANDS: [keyof CardCommands, string][] = [
  ["install", "Install"],
  ["run", "Run"],
  ["build", "Build"],
  ["test", "Test"],
  ["lint", "Lint"],
  ["typecheck", "Typecheck"],
  ["format", "Format"],
];

/** What majhi knows about the repo, read from its files, and how ready it is for agents. */
export function ProjectCardSection({ project, org }: { project: string; org: string }) {
  const boss = useBoss();
  const cards = useProjectCards();
  const refresh = useRefreshCard();
  const card = cards.data?.get(project);
  const refreshing = refresh.isPending;
  const button = (
    <Button
      size="sm"
      variant="secondary"
      disabled={refreshing}
      aria-label={`Refresh the card of ${project}`}
      onClick={() => refresh.mutate(project)}
    >
      <RefreshCw aria-hidden="true" className={refreshing ? "animate-spin" : ""} />
      {refreshing ? "Reading" : "Refresh"}
    </Button>
  );
  return (
    <DetailSection
      title="Knowledge card"
      className="border-t-0"
      note={
        card === undefined
          ? undefined
          : `Read ${formatAgo(card.refreshedAt, Date.now())}${card.commit ? ` at ${card.commit.slice(0, 7)}` : ""}`
      }
      actions={button}
    >
      {refresh.isError && (
        <p role="alert" className="text-sm text-red text-pretty">
          {refresh.error.message}
        </p>
      )}
      {card === undefined ? (
        <p className="text-sm text-fg-faint text-pretty">
          {cards.isPending
            ? "Loading."
            : "No card yet. majhi reads it when the base branch is known, or press Refresh."}
        </p>
      ) : (
        <CardBody card={card} onDescribe={() => boss.show(wsTab(org), describeProjectAsk(project))} />
      )}
    </DetailSection>
  );
}

function CardBody({ card, onDescribe }: { card: ProjectCard; onDescribe: () => void }) {
  const commands = COMMANDS.flatMap(([key, label]) =>
    card.commands[key] === undefined ? [] : [{ label, text: card.commands[key] as string }],
  );
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {card.whatItIs === "" ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="m-0 text-sm text-fg-faint">Nothing says what it is yet.</p>
          <Button size="sm" onClick={onDescribe}>
            <MessageSquare aria-hidden="true" />
            Have the captain write it
          </Button>
        </div>
      ) : (
        <p className="text-sm text-fg-soft text-pretty">{card.whatItIs}</p>
      )}
      <Readiness card={card} />
      {card.stack.length > 0 && (
        <Block label="Stack">
          <div className="flex flex-wrap gap-1.5">
            {card.stack.map((s) => (
              <Badge key={s}>{s}</Badge>
            ))}
          </div>
        </Block>
      )}
      {commands.length > 0 && (
        <Block label="Commands">
          <dl className="m-0 grid grid-cols-[84px_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
            {commands.map((c) => (
              <div key={c.label} className="contents">
                <dt className="text-fg-faint">{c.label}</dt>
                <dd className="m-0 min-w-0 truncate font-mono text-xs leading-5 text-fg-soft" title={c.text}>
                  {c.text}
                </dd>
              </div>
            ))}
          </dl>
        </Block>
      )}
      {card.structure.length > 0 && (
        <Block label="Structure">
          <ul className="m-0 grid list-none gap-x-4 gap-y-0.5 p-0 text-sm @[460px]:grid-cols-2">
            {card.structure.map((s) => (
              <li key={s.path} className="flex min-w-0 gap-2">
                <span className="shrink-0 font-mono text-xs leading-5 text-fg-soft">{s.path}</span>
                <span className="min-w-0 truncate text-fg-faint" title={s.note}>
                  {s.note}
                </span>
              </li>
            ))}
          </ul>
        </Block>
      )}
      {card.conventions.length > 0 && (
        <Block label="Conventions">
          <ul className="m-0 flex list-disc flex-col gap-0.5 pl-4 text-sm text-fg-soft">
            {card.conventions.map((c) => (
              <li key={c} className="text-pretty">
                {c}
              </li>
            ))}
          </ul>
        </Block>
      )}
      <Block label="CI and deploy">
        <p className="m-0 text-sm text-fg-soft text-pretty">
          {card.ci.provider ? `${card.ci.provider}: ${card.ci.workflows.join(", ")}` : "No CI config found."}
          {card.deploy.length > 0 ? ` Deploy: ${card.deploy.join(", ")}.` : ""}
        </p>
      </Block>
      {card.remotes.length > 0 && (
        <Block label="Remotes">
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-sm">
            {card.remotes.map((r) => (
              <li key={r.name} className="flex min-w-0 gap-2">
                <span className="shrink-0 font-mono text-xs leading-5 text-fg-soft">{r.name}</span>
                <span className="min-w-0 truncate font-mono text-xs leading-5 text-fg-faint" title={r.url}>
                  {r.url}
                </span>
              </li>
            ))}
          </ul>
        </Block>
      )}
    </div>
  );
}

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <SectionLabel>{label}</SectionLabel>
      {children}
    </div>
  );
}

/** The score and the checklist. Each missing item says what would fix it. */
function Readiness({ card }: { card: ProjectCard }) {
  const { score, max, items } = card.readiness;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <SectionLabel>Ready for agents</SectionLabel>
        <Badge tone={score >= 4 ? "green" : score >= 2 ? "amber" : "red"} mono>
          {score}/{max}
        </Badge>
      </div>
      <ul
        aria-label="Readiness checklist"
        className="m-0 grid list-none gap-x-6 gap-y-1.5 p-0 @[620px]:grid-cols-2"
      >
        {items.map((i) => (
          <ReadinessRow key={i.id} item={i} />
        ))}
      </ul>
    </div>
  );
}

function ReadinessRow({ item }: { item: ReadinessItem }) {
  return (
    <li className="flex min-w-0 items-start gap-2 text-sm">
      {item.ok ? (
        <Check aria-label="Done" className="mt-0.5 size-3.5 shrink-0 text-green" />
      ) : (
        <X aria-label="Missing" className="mt-0.5 size-3.5 shrink-0 text-red" />
      )}
      <div className="flex min-w-0 flex-col">
        <span className="text-fg">{item.label}</span>
        <span className="min-w-0 text-xs text-fg-faint text-pretty">
          {(item.ok ? item.detail : `${item.detail} ${item.fix ?? ""}`).replaceAll("`", "")}
        </span>
      </div>
    </li>
  );
}
