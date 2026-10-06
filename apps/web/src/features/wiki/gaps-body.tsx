import {
  WIKI_GAPS_HEADINGS,
  type WikiKnownRole,
  WikiKnownRoleSchema,
  type WikiPage,
  type WikiQuestion,
  type WikiRoleRow,
} from "@majhi/shared";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChoiceChip } from "@/components/ui/choice-chip";
import { Menu } from "@/components/ui/menu";
import { useWikiWhenBuilt } from "@/lib/wiki-queries";
import { COPY } from "./copy";
import { DROP_WORDS, leadOf, openItems, ROLE_LABEL } from "./model";
import type { PageProps } from "./page-view";
import { BasisMark, Block, SourceChip, Sources, Text } from "./parts";

/** The sections of the body that have no data of their own: split at the headings the page is written with. */
function extraSections(body: string): { heading: string; text: string }[] {
  const [, ...sections] = body.split("\n\n## ");
  return sections
    .map((s) => {
      const at = s.indexOf("\n");
      return { heading: at < 0 ? s : s.slice(0, at), text: at < 0 ? "" : s.slice(at + 1).trim() };
    })
    .filter(
      (s) =>
        s.heading !== WIKI_GAPS_HEADINGS.couldNotConfirm &&
        s.heading !== WIKI_GAPS_HEADINGS.guessed &&
        s.text !== "",
    );
}

/**
 * The Gaps page: where the wiki is thin. The roles it guessed (confirm or change), the claims it guessed, the
 * claims the checker could not confirm, and what it asks the owner. Each list is drawn from the pages' data,
 * so a guess can be acted on.
 */
export function GapsBody({ page, all, changed, onOpen, onGo, scope }: PageProps) {
  const { guessed, dropped } = useMemo(() => openItems(all), [all]);
  const overview = all.find((l) => l.page.kind === "overview")?.page;
  const roleClaims = useMemo(() => new Set(overview?.roles.map((r) => r.claim) ?? []), [overview]);
  const rows = useMemo(
    () =>
      (overview?.roles ?? []).filter((r) => overview?.claims.find((c) => c.n === r.claim)?.proven === false),
    [overview],
  );
  const loose = guessed.filter(
    ({ page: from, claim }) => !(from.id === overview?.id && roleClaims.has(claim.n)),
  );
  const questions = page.questions;
  const extras = useMemo(() => extraSections(page.body), [page.body]);
  const empty =
    loose.length === 0 &&
    dropped.length === 0 &&
    rows.length === 0 &&
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
      {rows.length > 0 && overview !== undefined && (
        <Block title={COPY.heading.guessedRoles}>
          <ul className="m-0 flex list-none flex-col p-0">
            {rows.map((row) => (
              <RoleRow
                key={`${row.role}:${row.where}`}
                row={row}
                page={overview}
                scope={scope}
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
      {extras.map((s) => (
        <Block key={s.heading} title={s.heading}>
          <Text>{s.text}</Text>
        </Block>
      ))}
      {questions.length > 0 && (
        <Block
          title={COPY.heading.questions}
          note={COPY.gaps.waiting(questions.filter((q) => q.answer === undefined).length)}
        >
          <ul className="m-0 flex list-none flex-col p-0">
            {questions.map((q) => (
              <QuestionRow key={q.id} question={q} scope={scope} />
            ))}
          </ul>
        </Block>
      )}
    </>
  );
}

function RoleRow({
  row,
  page,
  scope,
  changed,
  onOpen,
}: {
  row: WikiRoleRow;
  page: WikiPage;
  scope: PageProps["scope"];
  changed: ReadonlySet<string>;
  onOpen: PageProps["onOpen"];
}) {
  const setRole = useWikiWhenBuilt("wiki.setRole");
  const [chosen, setChosen] = useState<WikiKnownRole | "confirm">();
  const claim = page.claims.find((c) => c.n === row.claim);
  const send = (choice: WikiKnownRole | "confirm") => {
    setChosen(choice);
    setRole.mutate({ org: scope.org, project: scope.project, role: row.role, where: row.where, choice });
  };
  const saved = chosen !== undefined && setRole.data === "done";
  const roles = WikiKnownRoleSchema.options.map((r) => ({
    label: ROLE_LABEL[r],
    onSelect: () => send(r),
    checked: chosen === r,
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
        {saved ? (
          <>
            <Badge>{chosen === "confirm" ? ROLE_LABEL[row.role] : ROLE_LABEL[chosen]}</Badge>
            <Saved>{COPY.gaps.confirmed}</Saved>
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
              {saved ? COPY.gaps.undo : COPY.gaps.changeRole}
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
        {setRole.data === "not-built" && <span className="text-xs text-fg-muted">{COPY.notBuilt}</span>}
        {setRole.isError && <span className="text-xs text-red">{setRole.error.message}</span>}
      </div>
    </li>
  );
}

function QuestionRow({ question, scope }: { question: WikiQuestion; scope: PageProps["scope"] }) {
  const answer = useWikiWhenBuilt("wiki.answer");
  const [picked, setPicked] = useState<string>();
  const current = answer.data === "done" ? picked : question.answer;
  return (
    <li
      className="flex min-w-0 flex-col gap-2 border-t border-line py-2.5 first:border-t-0 first:pt-0"
      data-question={question.id}
    >
      <Text className="text-fg">{question.text}</Text>
      <div className="flex flex-wrap items-center gap-2">
        {question.options.map((option) => (
          <ChoiceChip
            key={option}
            pressed={current === option}
            disabled={answer.isPending}
            className="min-h-[28px] px-2.5"
            onClick={() => {
              setPicked(option);
              answer.mutate({
                org: scope.org,
                ...(scope.project === undefined ? {} : { project: scope.project }),
                question: question.id,
                answer: option,
              });
            }}
          >
            {option}
          </ChoiceChip>
        ))}
        {current !== undefined && <Saved>{COPY.gaps.saved}</Saved>}
        {answer.data === "not-built" && <span className="text-xs text-fg-muted">{COPY.notBuilt}</span>}
        {answer.isError && <span className="text-xs text-red">{answer.error.message}</span>}
      </div>
    </li>
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
