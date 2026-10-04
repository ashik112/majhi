import type { VoiceGet, VoiceProposal } from "@majhi/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Lamp } from "@/components/ui/lamp";
import { DetailPane, DetailSection } from "@/components/ui/list-detail";
import { Textarea } from "@/components/ui/select";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { useBusinessCommand, useVoice } from "@/lib/business-queries";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { GLASS } from "@/lib/glass";
import { ErrorLine, type Scope } from "./parts";

const lines = (text: string): string[] =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
/** Blocks separated by a line with only `---`. */
const blocks = (text: string): string[] =>
  text
    .split(/^\s*---\s*$/m)
    .map((b) => b.trim())
    .filter((b) => b !== "");

function state(v: VoiceGet | undefined): { lamp: "done" | "paused" | "idle"; word: string } {
  if (v === undefined) return { lamp: "idle", word: "" };
  if (v.proposal) return { lamp: "paused", word: "A proposal waits" };
  if (v.own) return { lamp: "done", word: "Has its own voice" };
  if (v.inherited) return { lamp: "idle", word: "Uses the business voice" };
  return { lamp: "idle", word: "No voice yet" };
}

function ScopeRow({ scope, selected, onSelect }: { scope: Scope; selected: boolean; onSelect: () => void }) {
  const q = useVoice(scope.value === "" ? undefined : scope.value);
  const s = state(q.data);
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      className={cn(
        "flex w-full min-w-0 cursor-pointer flex-col gap-1 rounded-md px-2.5 py-2 text-left transition-colors duration-150 hover:bg-raised",
        selected && "bg-selected shadow-[inset_0_0_0_1px_var(--c-line-control)]",
      )}
    >
      <span className="truncate text-base text-fg" title={scope.label}>
        {scope.label}
      </span>
      <span className="flex items-center gap-2 pl-0 text-xs text-fg-faint">
        <Lamp state={s.lamp} size={7} />
        {s.word}
      </span>
    </button>
  );
}

export function VoicePane({ scopes }: { scopes: readonly Scope[] }) {
  const [selected, setSelected] = useState("");
  return (
    <>
      <nav
        aria-label="Voices"
        className={cn(
          "flex w-[296px] shrink-0 flex-col overflow-hidden rounded-2xl min-[1320px]:w-[340px]",
          GLASS,
        )}
      >
        <div role="listbox" aria-label="Voices" className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {scopes.map((s) => (
            <ScopeRow
              key={s.value}
              scope={s}
              selected={s.value === selected}
              onSelect={() => setSelected(s.value)}
            />
          ))}
        </div>
        <p className="shrink-0 border-t border-line p-3 text-sm text-fg-faint text-pretty">
          A workspace without its own voice writes in the business voice.
        </p>
      </nav>
      <VoiceDetail key={selected} scope={scopes.find((s) => s.value === selected) ?? (scopes[0] as Scope)} />
    </>
  );
}

function VoiceDetail({ scope }: { scope: Scope }) {
  const org = scope.value === "" ? undefined : scope.value;
  const q = useVoice(org);
  if (q.isError) {
    return (
      <DetailPane label="Voice">
        <div className="pt-4">
          <ErrorLine>Could not load the voice: {describeError(q.error)}</ErrorLine>
        </div>
      </DetailPane>
    );
  }
  if (q.data === undefined) {
    return (
      <DetailPane label="Voice">
        <div className="pt-4">
          <RowsSkeleton rows={4} height={40} />
        </div>
      </DetailPane>
    );
  }
  return (
    <DetailPane
      label="Voice"
      head={
        <div className="flex flex-col gap-1">
          <h2 className="text-md font-semibold">{scope.label}</h2>
          <p className="text-sm text-fg-muted">
            How drafts for {org === undefined ? "the business" : scope.label} should sound. Every post, reply
            and mail follows it.
          </p>
        </div>
      }
    >
      {q.data.proposal && <Proposal org={org} proposal={q.data.proposal} />}
      <VoiceForm key={q.data.own?.updatedAt ?? "none"} org={org} data={q.data} />
    </DetailPane>
  );
}

function Proposal({ org, proposal }: { org: string | undefined; proposal: VoiceProposal }) {
  const decide = useBusinessCommand("voice.decide");
  const toast = useToast();
  const go = (accept: boolean) =>
    decide.mutate(
      { ...(org === undefined ? {} : { org }), accept },
      { onSuccess: () => toast(accept ? "Voice updated" : "Proposal dropped") },
    );
  return (
    <section
      aria-label="Proposed voice"
      className="mt-4 flex flex-col gap-2 rounded-xl border border-caution-line bg-caution-wash p-4"
    >
      <h3 className="text-base font-semibold text-fg">The captain proposes a voice</h3>
      <p className="text-base text-fg-soft text-pretty">{proposal.why}</p>
      <dl className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-1 text-base">
        {proposal.tone && (
          <>
            <dt className="text-sm text-fg-faint">Tone</dt>
            <dd className="text-fg">{proposal.tone}</dd>
          </>
        )}
        {proposal.length && (
          <>
            <dt className="text-sm text-fg-faint">Length</dt>
            <dd className="text-fg">{proposal.length}</dd>
          </>
        )}
        {proposal.use.length > 0 && (
          <>
            <dt className="text-sm text-fg-faint">Use</dt>
            <dd className="text-fg">{proposal.use.join("; ")}</dd>
          </>
        )}
        {proposal.avoid.length > 0 && (
          <>
            <dt className="text-sm text-fg-faint">Avoid</dt>
            <dd className="text-fg">{proposal.avoid.join("; ")}</dd>
          </>
        )}
        {proposal.signOffs.length > 0 && (
          <>
            <dt className="text-sm text-fg-faint">Sign-offs</dt>
            <dd className="text-fg">{proposal.signOffs.join("; ")}</dd>
          </>
        )}
      </dl>
      {decide.error && <ErrorLine>{describeError(decide.error)}</ErrorLine>}
      <div className="flex gap-2 pt-1">
        <Button variant="primary" disabled={decide.isPending} onClick={() => go(true)}>
          Use this voice
        </Button>
        <Button disabled={decide.isPending} onClick={() => go(false)}>
          Drop it
        </Button>
      </div>
    </section>
  );
}

function VoiceForm({ org, data }: { org: string | undefined; data: VoiceGet }) {
  const own = data.own;
  const save = useBusinessCommand("voice.set");
  const toast = useToast();
  const [tone, setTone] = useState(own?.tone ?? "");
  const [length, setLength] = useState(own?.length ?? "");
  const [use, setUse] = useState((own?.use ?? []).join("\n"));
  const [avoid, setAvoid] = useState((own?.avoid ?? []).join("\n"));
  const [signOffs, setSignOffs] = useState((own?.signOffs ?? []).join("\n"));
  const [examples, setExamples] = useState((own?.examples ?? []).join("\n---\n"));
  const [samples, setSamples] = useState((own?.samples ?? []).join("\n---\n"));
  const empty = own === undefined && data.proposal === undefined;
  const inherited = data.inherited ? data.effective : undefined;

  return (
    <form
      className="flex max-w-[78ch] flex-col gap-4 pt-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(
          {
            ...(org === undefined ? {} : { org }),
            tone,
            length,
            use: lines(use),
            avoid: lines(avoid),
            signOffs: lines(signOffs),
            examples: blocks(examples),
            samples: blocks(samples),
          },
          { onSuccess: () => toast("Voice saved") },
        );
      }}
    >
      {empty && (
        <p className="text-base text-fg-muted text-pretty">
          {inherited
            ? "This workspace writes in the business voice until you give it its own."
            : "Paste three to five things you wrote, such as mails, posts or replies, under Your writing. The captain turns them into a guide and proposes it here for you to accept. Or write the guide yourself."}
        </p>
      )}
      <Field
        label="Your writing"
        hint="Real things you wrote, separated by a line with only ---. Up to 10, 4,000 characters each. The captain learns from these."
      >
        {(p) => (
          <Textarea
            {...p}
            value={samples}
            rows={7}
            onChange={(e) => setSamples(e.target.value)}
            className="font-sans"
          />
        )}
      </Field>
      <DetailSection title="The guide" className="mt-1">
        <Field label="Tone">
          {(p) => (
            <Input
              {...p}
              value={tone}
              maxLength={600}
              onChange={(e) => setTone(e.target.value)}
              placeholder="Plain, warm, direct. No hype."
            />
          )}
        </Field>
        <Field label="Length">
          {(p) => (
            <Input
              {...p}
              value={length}
              maxLength={400}
              onChange={(e) => setLength(e.target.value)}
              placeholder="Replies: three sentences. Posts: under 220 characters."
            />
          )}
        </Field>
        <div className="grid grid-cols-1 gap-3 @[560px]:grid-cols-2">
          <Field label="Words to use, one per line">
            {(p) => (
              <Textarea
                {...p}
                value={use}
                rows={4}
                onChange={(e) => setUse(e.target.value)}
                className="font-sans"
              />
            )}
          </Field>
          <Field label="Words to avoid, one per line">
            {(p) => (
              <Textarea
                {...p}
                value={avoid}
                rows={4}
                onChange={(e) => setAvoid(e.target.value)}
                className="font-sans"
              />
            )}
          </Field>
        </div>
        <Field label="Sign-offs, one per line">
          {(p) => (
            <Textarea
              {...p}
              value={signOffs}
              rows={2}
              onChange={(e) => setSignOffs(e.target.value)}
              className="font-sans"
            />
          )}
        </Field>
        <Field label="Example lines in this voice, separated by ---">
          {(p) => (
            <Textarea
              {...p}
              value={examples}
              rows={5}
              onChange={(e) => setExamples(e.target.value)}
              className="font-sans"
            />
          )}
        </Field>
      </DetailSection>
      {save.error && <ErrorLine>{describeError(save.error)}</ErrorLine>}
      <div>
        <Button type="submit" variant="primary" disabled={save.isPending}>
          Save voice
        </Button>
      </div>
    </form>
  );
}
