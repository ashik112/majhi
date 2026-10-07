import {
  WIKI_GAPS_HEADINGS,
  type WikiAnswerInput,
  type WikiKnownRole,
  WikiKnownRoleSchema,
  type WikiPage,
  type WikiQuestion,
  type WikiRoleRow,
  type WikiUnlinkedCall,
} from "@majhi/shared";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChoiceChip } from "@/components/ui/choice-chip";
import { Menu } from "@/components/ui/menu";
import { describeError } from "@/lib/errors";
import { useWikiAnswer, useWikiSetRole } from "@/lib/wiki-queries";
import { COPY } from "./copy";
import { DROP_WORDS, leadOf, openItems, ROLE_LABEL } from "./model";
import type { PageProps } from "./page-view";
import { BasisMark, Block, SourceChip, Sources, Text } from "./parts";

/** The headings of the body that this page draws from data instead, so the body's copy of them is not shown twice. */
const DRAWN: ReadonlySet<string> = new Set([...Object.values(WIKI_GAPS_HEADINGS), COPY.failed.pagesTitle]);

/** The sections of the body that have no data of their own: split at the headings the page is written with. */
function extraSections(body: string): { heading: string; text: string }[] {
  const [, ...sections] = body.split("\n\n## ");
  return sections
    .map((s) => {
      const at = s.indexOf("\n");
      return { heading: at < 0 ? s : s.slice(0, at), text: at < 0 ? "" : s.slice(at + 1).trim() };
    })
    .filter((s) => !DRAWN.has(s.heading) && s.text !== "");
}

/** A role the owner has not decided: its claim is a guess and no answer stands behind it. Decided ones stay listed, to change or undo. */
export function guessedRoleRows(overview: WikiPage | undefined): WikiRoleRow[] {
  return (overview?.roles ?? []).filter(
    (r) => r.basis === "owner" || overview?.claims.find((c) => c.n === r.claim)?.proven === false,
  );
}

/**
 * The Gaps page: where the wiki is thin. The roles it guessed (confirm, change or undo), the claims it guessed,
 * the claims the checker could not confirm, the calls that link to no other project, and what it asks the owner.
 * Each list is drawn from data, so a guess can be acted on.
 */
export function GapsBody({
  page,
  all,
  system,
  changed,
  onOpen,
  onGo,
  scope,
  projects,
  failed,
  flowsNotChosen,
  onRetry,
}: PageProps) {
  const { guessed, dropped } = useMemo(() => openItems(all), [all]);
  const overview = all.find((l) => l.page.kind === "overview")?.page;
  const roleClaims = useMemo(() => new Set(overview?.roles.map((r) => r.claim) ?? []), [overview]);
  const rows = useMemo(
    () => (scope.project === undefined ? [] : guessedRoleRows(overview)),
    [overview, scope.project],
  );
  const loose = guessed.filter(
    ({ page: from, claim }) => !(from.id === overview?.id && roleClaims.has(claim.n)),
  );
  const unlinked = (system?.unlinked ?? []).filter(
    (u) => scope.project === undefined || u.project === scope.project,
  );
  const questions = (system?.questions ?? []).filter(
    (q) => scope.project === undefined || q.projects.includes(scope.project),
  );
  const extras = useMemo(() => extraSections(page.body), [page.body]);
  const empty =
    failed.size === 0 &&
    !flowsNotChosen &&
    loose.length === 0 &&
    dropped.length === 0 &&
    rows.length === 0 &&
    unlinked.length === 0 &&
    questions.length === 0 &&
    extras.length === 0;
  const text = leadOf(page.body);
  return (
    <>
      <Block title={COPY.heading.openItems} first>
        {empty ? (
          <p className="text-base text-fg-muted">{COPY.gaps.nothing}</p>
        ) : (
          text.trim() !== "" && <Text className="max-w-[68ch] text-fg-soft">{text}</Text>
        )}
      </Block>
      {(failed.size > 0 || flowsNotChosen) && (
        <Block title={COPY.failed.group} note={failed.size + (flowsNotChosen ? 1 : 0)}>
          <ul className="m-0 flex list-none flex-col p-0">
            {flowsNotChosen && (
              <li className="flex min-w-0 flex-col gap-1 border-t border-line py-2.5 first:border-t-0 first:pt-0">
                <Text>{COPY.failed.flows}</Text>
                <p className="m-0 text-sm text-fg-muted">{COPY.failed.flowsWhy}</p>
              </li>
            )}
            {[...failed].map((id) => (
              <li
                key={id}
                className="flex min-w-0 flex-col gap-1 border-t border-line py-2.5 first:border-t-0 first:pt-0"
              >
                <code className="font-mono text-sm text-fg">{id}</code>
                <p className="m-0 text-sm text-fg-muted">{COPY.failed.pagesWhy}</p>
              </li>
            ))}
          </ul>
          <div>
            <Button size="sm" onClick={onRetry}>
              {COPY.failed.retry}
            </Button>
          </div>
        </Block>
      )}
      {dropped.length > 0 && (
        <Block title={COPY.heading.couldNotConfirm} note={dropped.length}>
          <ul className="m-0 flex list-none flex-col p-0">
            {dropped.map((d) => (
              <li
                key={`${d.page.id}:${d.text}`}
                className="flex min-w-0 flex-col gap-1 border-t border-line py-2.5 first:border-t-0 first:pt-0"
              >
                <Text>{d.text}</Text>
                <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fg-muted">
                  <span>{DROP_WORDS[d.reason]}</span>
                  {d.cited.map((c) => (
                    <code key={`${c.path}:${c.lines[0]}`} className="font-mono text-xs text-fg-faint">
                      {c.path}:{c.lines[0]}
                    </code>
                  ))}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-1.5 text-xs"
                    onClick={() => onGo(d.page.id)}
                  >
                    {d.page.title}
                  </Button>
                </p>
              </li>
            ))}
          </ul>
        </Block>
      )}
      {unlinked.length > 0 && (
        <Block title={COPY.heading.notLinked} note={unlinked.length}>
          <ul className="m-0 flex list-none flex-col p-0">
            {unlinked.map((u) => (
              <UnlinkedRow key={u.call} call={u} org={scope.org} projects={projects} onOpen={onOpen} />
            ))}
          </ul>
        </Block>
      )}
      {rows.length > 0 && overview !== undefined && scope.project !== undefined && (
        <Block title={COPY.heading.guessedRoles}>
          <ul className="m-0 flex list-none flex-col p-0">
            {rows.map((row) => (
              <RoleRow
                key={`${row.role}:${row.where}`}
                row={row}
                page={overview}
                org={scope.org}
                project={scope.project as string}
                changed={changed}
                onOpen={onOpen}
              />
            ))}
          </ul>
        </Block>
      )}
      {loose.length > 0 && (
        <Block title={COPY.heading.guessed}>
          <ul className="m-0 flex list-none flex-col p-0">
            {loose.map(({ page: from, claim }) => (
              <li
                key={`${from.id}:${claim.n}`}
                className="flex min-w-0 flex-col gap-1.5 border-t border-line py-2.5 first:border-t-0 first:pt-0"
              >
                <Text>{claim.text}</Text>
                <div className="flex flex-wrap items-center gap-1.5">
                  <BasisMark proven={false} />
                  <Sources claim={claim} changed={changed} onOpen={onOpen} />
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-1.5 text-xs"
                    onClick={() => onGo(from.id)}
                  >
                    {from.title}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Block>
      )}
      {extras.map((s) => (
        <Block key={s.heading} title={s.heading}>
          <Text>{s.text}</Text>
        </Block>
      ))}
      {questions.length > 0 && (
        <Block title={COPY.heading.questions} note={COPY.gaps.waiting(questions.length)}>
          <ul className="m-0 flex list-none flex-col p-0">
            {questions.map((q) => (
              <QuestionRow
                key={`${q.host}:${q.port ?? ""}:${q.scope ?? ""}`}
                question={q}
                org={scope.org}
                projects={projects}
                onOpen={onOpen}
              />
            ))}
          </ul>
        </Block>
      )}
    </>
  );
}

/** What the owner did is kept: a green dot and the words. */
function Saved({ children }: { children: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-green">
      <span aria-hidden="true" className="size-1.5 rounded-full bg-green" />
      {children}
    </span>
  );
}

function RoleRow({
  row,
  page,
  org,
  project,
  changed,
  onOpen,
}: {
  row: WikiRoleRow;
  page: WikiPage;
  org: string;
  project: string;
  changed: ReadonlySet<string>;
  onOpen: PageProps["onOpen"];
}) {
  const setRole = useWikiSetRole();
  const [chosen, setChosen] = useState<WikiKnownRole | "confirm" | "undo">();
  const claim = page.claims.find((c) => c.n === row.claim);
  const send = (choice: WikiKnownRole | "confirm" | "undo") => {
    setChosen(choice);
    setRole.mutate({ org, project, role: row.role, where: row.where, choice });
  };
  const decided = chosen === undefined ? row.basis === "owner" : chosen !== "undo";
  const shown = chosen !== undefined && chosen !== "confirm" && chosen !== "undo" ? chosen : row.role;
  const roles = WikiKnownRoleSchema.options.map((r) => ({
    label: ROLE_LABEL[r],
    onSelect: () => send(r),
    checked: decided && shown === r,
  }));
  return (
    <li
      className="flex min-w-0 flex-col gap-1.5 border-t border-line py-2.5 first:border-t-0 first:pt-0"
      data-role-row={row.where}
    >
      <span className="truncate font-mono text-[12.5px] text-fg" title={row.where}>
        {row.where}
      </span>
      <Text className="text-fg-muted">{row.tech}</Text>
      <div className="flex flex-wrap items-center gap-2">
        {decided ? (
          <>
            <Badge>{ROLE_LABEL[shown]}</Badge>
            <Saved>{COPY.gaps.confirmed}</Saved>
            <Button size="sm" disabled={setRole.isPending} onClick={() => send("undo")}>
              {COPY.gaps.undo}
            </Button>
          </>
        ) : (
          <>
            <Badge tone="amber">{ROLE_LABEL[row.role]}</Badge>
            <BasisMark proven={false} />
            <Button size="sm" disabled={setRole.isPending} onClick={() => send("confirm")}>
              {COPY.gaps.right}
            </Button>
          </>
        )}
        <Menu
          label={COPY.gaps.changeRole}
          items={roles}
          align="left"
          trigger={(t) => (
            <Button size="sm" {...t}>
              {COPY.gaps.changeRole}
            </Button>
          )}
        />
        {claim?.sources.map((s) => (
          <SourceChip
            key={`${s.path}:${s.lines[0]}`}
            source={s}
            moved={changed.has(s.path)}
            onOpen={onOpen}
          />
        ))}
        {setRole.isError && <span className="text-xs text-red">{describeError(setRole.error)}</span>}
      </div>
    </li>
  );
}

/** The targets an answer can name: another project of the workspace, an outside service, or nothing to show. */
function targets(projects: readonly string[], not?: string) {
  return [
    ...projects
      .filter((p) => p !== not)
      .map((p) => ({ label: p, to: { kind: "project", project: p } as const })),
    { label: COPY.gaps.outside, to: { kind: "outside" } as const },
    { label: COPY.gaps.ignore, to: { kind: "ignore" } as const },
  ];
}

type Answered = { label: string };

function useAnswer(org: string) {
  const answer = useWikiAnswer();
  const [done, setDone] = useState<Answered>();
  const send = (
    question: WikiAnswerInput["question"],
    to: WikiAnswerInput["to"],
    label: string | undefined,
  ) =>
    answer.mutate(
      { org, question, to },
      { onSuccess: () => setDone(label === undefined ? undefined : { label }) },
    );
  return { answer, done, send };
}

function UnlinkedRow({
  call,
  org,
  projects,
  onOpen,
}: {
  call: WikiUnlinkedCall;
  org: string;
  projects: readonly string[];
  onOpen: PageProps["onOpen"];
}) {
  const { answer, done, send } = useAnswer(org);
  const why = call.why === "no-route" ? COPY.gaps.noRoute : COPY.gaps.ambiguous(call.matches.join(", "));
  return (
    <li
      className="flex min-w-0 flex-col gap-1.5 border-t border-line py-2.5 first:border-t-0 first:pt-0"
      data-unlinked={call.call}
    >
      <Text className="text-fg">{`\`${call.method} ${call.path}\` (${call.project})`}</Text>
      <Text className="text-fg-muted">{why}</Text>
      <div className="flex flex-wrap items-center gap-2">
        <SourceChip source={call.source} moved={false} onOpen={onOpen} />
        {done === undefined ? (
          <Menu
            label={COPY.gaps.answer}
            align="left"
            items={targets(projects, call.project).map((t) => ({
              label: t.label,
              onSelect: () => send({ kind: "call", call: call.call }, t.to, t.label),
            }))}
            trigger={(t) => (
              <Button size="sm" disabled={answer.isPending} {...t}>
                {COPY.gaps.answer}
              </Button>
            )}
          />
        ) : (
          <>
            <Saved>{COPY.gaps.saved}</Saved>
            <Badge>{done.label}</Badge>
            <Button size="sm" onClick={() => send({ kind: "call", call: call.call }, null, undefined)}>
              {COPY.gaps.undo}
            </Button>
          </>
        )}
        {answer.isError && <span className="text-xs text-red">{describeError(answer.error)}</span>}
      </div>
    </li>
  );
}

function QuestionRow({
  question,
  org,
  projects,
  onOpen,
}: {
  question: WikiQuestion;
  org: string;
  projects: readonly string[];
  onOpen: PageProps["onOpen"];
}) {
  const { answer, done, send } = useAnswer(org);
  const address = `${question.host}${question.port === undefined ? "" : `:${question.port}`}`;
  const ref = {
    kind: "address",
    host: question.host,
    ...(question.port === undefined ? {} : { port: question.port }),
    ...(question.scope === undefined ? {} : { scope: question.scope }),
  } as const;
  const context = [
    COPY.gaps.calledBy(question.projects.join(", ")),
    ...(question.keys.length === 0 ? [] : [COPY.gaps.setIn(question.keys.join(", "))]),
    ...(question.scope === undefined ? [] : [COPY.gaps.localTo(question.scope)]),
  ].join(" ");
  return (
    <li
      className="flex min-w-0 flex-col gap-2 border-t border-line py-2.5 first:border-t-0 first:pt-0"
      data-question={address}
    >
      <Text className="text-fg">{COPY.gaps.whatIs(address)}</Text>
      <Text className="text-fg-muted">{context}</Text>
      <div className="flex flex-wrap items-center gap-2">
        {targets(projects).map((t) => (
          <ChoiceChip
            key={t.label}
            pressed={done?.label === t.label}
            disabled={answer.isPending}
            className="min-h-[28px] px-2.5"
            onClick={() => send(ref, t.to, t.label)}
          >
            {t.label}
          </ChoiceChip>
        ))}
        {done !== undefined && <Saved>{COPY.gaps.saved}</Saved>}
        {done !== undefined && (
          <Button size="sm" onClick={() => send(ref, null, undefined)}>
            {COPY.gaps.undo}
          </Button>
        )}
        {question.sources.map((s) => (
          <SourceChip key={`${s.path}:${s.lines[0]}`} source={s} moved={false} onOpen={onOpen} />
        ))}
        {answer.isError && <span className="text-xs text-red">{describeError(answer.error)}</span>}
      </div>
    </li>
  );
}
