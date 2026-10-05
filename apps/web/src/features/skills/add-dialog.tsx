import type { McpInstallResult, OrgView, Skill } from "@majhi/shared";
import { X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Segmented } from "@/components/ui/segmented";
import type { ItemKind } from "./catalog";
import {
  McpBrowse,
  McpInstallBox,
  McpJustInstalled,
  McpPreviewCard,
  type Review as McpReview,
} from "./mcp-tab";
import { SkillBrowse, SkillInstallBox, SkillPreviewCard, type Review as SkillReview } from "./skills-tab";

type Installed = Extract<McpInstallResult, { status: "installed" }>;

/**
 * One place to add either kind. Find it in the directory or paste a link, read what it does, then
 * install; the progress and any refusal show in the card itself. Closing hands back the new row's key.
 */
export function AddDialog({
  initialKind,
  initialReview,
  orgs,
  skills,
  onClose,
  onAdded,
}: {
  initialKind: ItemKind;
  initialReview?: SkillReview | undefined;
  orgs: readonly OrgView[];
  skills: readonly Skill[];
  onClose: () => void;
  onAdded: (key: string) => void;
}) {
  const [kind, setKind] = useState<ItemKind>(initialKind);
  const [skillReview, setSkillReview] = useState<SkillReview | undefined>(initialReview);
  const [mcpReview, setMcpReview] = useState<McpReview>();
  const [installed, setInstalled] = useState<Installed>();
  const [org, setOrg] = useState("");
  const chosen = org !== "" ? org : orgs.length > 1 ? (orgs[0]?.id ?? "") : "";
  const busy = skillReview !== undefined || mcpReview !== undefined || installed !== undefined;

  return (
    <Modal label="Add a skill or MCP server" onClose={onClose} className="w-[720px]">
      <div className="flex max-h-[calc(100dvh-64px)] flex-col">
        <header className="flex shrink-0 items-center gap-3 border-b border-line-strong px-5 py-3">
          <h2 className="text-md font-semibold">Add</h2>
          <Segmented
            label="What to add"
            value={kind}
            onChange={(next) => {
              if (!busy) setKind(next);
            }}
            segments={[
              { value: "skill", label: "Skill" },
              { value: "mcp", label: "MCP server" },
            ]}
          />
          <span className="min-w-0 truncate text-sm text-fg-muted">
            {kind === "skill"
              ? "Search the directory, or paste a link or folder."
              : "Search the registry, or paste a URL or command."}
          </span>
          <Button variant="ghost" size="icon-sm" className="ml-auto" aria-label="Close" onClick={onClose}>
            <X aria-hidden="true" />
          </Button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain p-5 scroll-fade">
          {kind === "skill" ? (
            skillReview !== undefined ? (
              <SkillPreviewCard
                key={skillReview.preview.previewId}
                review={skillReview}
                onCancel={() => setSkillReview(undefined)}
                onDone={(names) => {
                  onAdded(`skill:${names[0] ?? ""}`);
                  onClose();
                }}
              />
            ) : (
              <>
                <SkillBrowse
                  installed={skills}
                  onPreview={(p) => setSkillReview({ kind: "install", preview: p })}
                />
                <SkillInstallBox
                  orgs={orgs}
                  onPreview={(p) => setSkillReview({ kind: "install", preview: p })}
                />
              </>
            )
          ) : installed !== undefined ? (
            <>
              <McpJustInstalled result={installed} />
              <Button
                variant="primary"
                className="self-end"
                onClick={() => {
                  onAdded(`mcp:${installed.connection.id}`);
                  onClose();
                }}
              >
                Done
              </Button>
            </>
          ) : mcpReview !== undefined ? (
            <McpPreviewCard
              key={mcpReview.preview.previewId}
              review={mcpReview}
              orgs={orgs}
              onPreview={setMcpReview}
              onCancel={() => setMcpReview(undefined)}
              onInstalled={(result) => {
                setMcpReview(undefined);
                setInstalled(result);
              }}
            />
          ) : (
            <>
              <McpBrowse org={chosen} onPreview={setMcpReview} />
              <McpInstallBox orgs={orgs} org={chosen} onOrg={setOrg} onPreview={setMcpReview} />
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
