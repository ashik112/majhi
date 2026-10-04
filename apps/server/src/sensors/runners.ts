import type { RulesRunner } from "../playbooks/rules.ts";
import { ciHealth } from "./ci.ts";
import { dependencySweep } from "./deps.ts";
import { eolWatch } from "./eol.ts";
import type { SensorPorts } from "./ports.ts";
import { techRadar } from "./radar.ts";
import { secretScan } from "./secrets.ts";

/**
 * The sensors as rules playbooks (cost tier "rules": code, no model turn). The Engineering pack names
 * them by these ids. All five only read and file findings, so they are marked read-only in the
 * catalog and run while Autonomous is off: the findings wait for the owner.
 */
export function sensorRunners(ports: SensorPorts): Record<string, RulesRunner> {
  return {
    "sensor-ci": ciHealth(ports),
    "sensor-deps": dependencySweep(ports),
    "sensor-secrets": secretScan(ports),
    "sensor-eol": eolWatch(ports),
    "sensor-radar": techRadar(ports),
  };
}
