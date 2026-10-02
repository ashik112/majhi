import type { CommandHandlers } from "../commands/handlers.ts";
import type { BackupService } from "./service.ts";

type BackupCommand = "backup.list" | "backup.now" | "backup.restore" | "backup.cancelRestore";

/** The `backup.*` commands (PRV-31). The command table spreads these in. */
export function backupHandlers(backup: BackupService): Pick<CommandHandlers, BackupCommand> {
  return {
    "backup.list": () => backup.list(),
    "backup.now": async () => ({ name: await backup.now() }),
    "backup.restore": (input) => backup.restore(input.name),
    "backup.cancelRestore": async () => {
      await backup.cancelRestore();
      return { cancelled: true };
    },
  };
}
