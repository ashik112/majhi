import { Button } from "@/components/ui/button";
import { PanelDialog, useSearchFlag } from "@/features/settings/panel-dialog";
import { SectionBody } from "@/features/setup/section-panel";

/** The Memory header's Rules button: who writes each task record, the briefs and the lessons, as a dialog. */
export function RulesButton() {
  const [open, setOpen] = useSearchFlag("rules");
  return (
    <>
      <Button size="lg" onClick={() => setOpen(true)}>
        Rules
      </Button>
      {open && (
        <PanelDialog title="Memory rules" onClose={() => setOpen(false)}>
          <SectionBody section="memory" />
        </PanelDialog>
      )}
    </>
  );
}
