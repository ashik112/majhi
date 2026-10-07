/**
 * Git's own settings for every test: no background `git maintenance` after a commit or fetch. It is a
 * detached process that outlives the test, competes with the next one for the CPU, and can still hold a
 * lock inside a repo the next test copies. The vitest config gives them to the workers, the global
 * setup to its own process.
 */
export const QUIET_GIT: Record<string, string> = {
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "maintenance.auto",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "gc.auto",
  GIT_CONFIG_VALUE_1: "0",
};
