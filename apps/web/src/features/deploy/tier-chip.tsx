import type { DeployTier } from "@majhi/shared";
import { Badge } from "@/components/ui/badge";

/** Production in amber, staging quiet: the tier, whatever the environment is called. */
export function TierChip({ tier }: { tier: DeployTier }) {
  return tier === "production" ? (
    <Badge tone="amber">Production</Badge>
  ) : (
    <Badge className="border-line">Staging</Badge>
  );
}
