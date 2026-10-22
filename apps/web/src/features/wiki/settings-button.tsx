import { Button } from "@/components/ui/button";
import { PanelDialog, useSearchFlag } from "@/features/settings/panel-dialog";
import { SectionBody } from "@/features/setup/section-panel";

/** The Wiki header's Settings button: the wiki's default and each workspace's own choice, as a dialog. */
export function WikiSettingsButton() {
  const [open, setOpen] = useSearchFlag("settings");
  return (
    <>
      <Button size="lg" onClick={() => setOpen(true)}>
        Settings
      </Button>
      {open && (
        <PanelDialog title="Wiki settings" onClose={() => setOpen(false)}>
          <SectionBody section="wiki" />
        </PanelDialog>
      )}
    </>
  );
}
