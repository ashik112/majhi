import type { CommandHandlers } from "../commands/handlers.ts";
import type { BackupService } from "./service.ts";

type BackupCommand =
  | "backup.list"
  | "backup.now"
  | "backup.verify"
  | "backup.restore"
  | "backup.cancelRestore"
  | "backup.setDestination";

/** The `backup.*` commands. The command table spreads these in. */
export function backupHandlers(backup: BackupService): Pick<CommandHandlers, BackupCommand> {
  return {
    "backup.list": () => backup.list(),
    "backup.now": async (input) => ({ name: await backup.now(input.passphrase) }),
    "backup.verify": (input) => backup.verify(input.name, input.passphrase),
    "backup.restore": (input) => backup.restore(input.name, input.passphrase),
    "backup.cancelRestore": async () => ({ cancelled: await backup.cancelRestore() }),
    "backup.setDestination": async (input) => ({ path: await backup.setDestination(input.path) }),
  };
}
