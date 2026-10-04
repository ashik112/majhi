import type { ConnectionView } from "@majhi/shared";
import { Globe, KeyRound, Mail, Network, Plug, Server } from "lucide-react";
import { cn } from "@/lib/cn";

const LOGOS: Readonly<Record<string, string>> = {
  linear: "linear", "linear-api": "linear", sentry: "sentry", "sentry-cli": "sentry",
  notion: "notion", atlassian: "atlassian", vercel: "vercel", "vercel-cli": "vercel",
  "cloudflare-observability": "cloudflare", wrangler: "cloudflare", stripe: "stripe",
  "stripe-cli": "stripe", posthog: "posthog", grafana: "grafana", datadog: "datadog",
  betterstack: "betterstack", gitlab: "gitlab", outlook: "microsoftoutlook", x: "x",
  github: "github", gmail: "gmail", "google-calendar": "googlecalendar",
  "google-drive": "googledrive", linkedin: "linkedin", slack: "slack", discord: "discord",
  aws: "amazonaws", gcloud: "googlecloud",
};

/** Local SVG marks, with a neutral backing so brand colors work in both themes. */
export function ServiceLogo({ service, type, className }: {
  service?: string | undefined;
  type?: ConnectionView["type"] | undefined;
  className?: string;
}) {
  const slug = service?.startsWith("digitalocean") ? "digitalocean" : LOGOS[service ?? ""];
  const Fallback = type === "ssh" ? Server : type === "kubectl" ? Network : type === "env" ? KeyRound : type === "mail" ? Mail : type === "browser" ? Globe : Plug;
  return <span aria-hidden="true" className={cn("flex size-11 shrink-0 items-center justify-center rounded-lg", slug ? "bg-white" : "border border-line-control bg-raised text-fg-muted", className)}>
    {slug ? <img src={`/service-logos/${slug}.svg`} alt="" width={28} height={28} className="size-[64%] object-contain" /> : <Fallback className="size-[50%]" />}
  </span>;
}

/** Managed services store their id; remote MCP services also identify themselves by their URL. */
export function serviceOf(view: ConnectionView): string | undefined {
  const explicit = view.fields.service?.value;
  if (explicit) return explicit;
  const address = view.fields.url?.value;
  if (!address) return undefined;
  try {
    const host = new URL(address).hostname;
    const hosts: Record<string, string> = {
      "mcp.linear.app": "linear", "mcp.sentry.dev": "sentry", "mcp.notion.com": "notion",
      "mcp.atlassian.com": "atlassian", "mcp.vercel.com": "vercel", "mcp.stripe.com": "stripe",
      "mcp.posthog.com": "posthog", "mcp.grafana.com": "grafana", "mcp.gitlab.com": "gitlab",
    };
    if (host.endsWith(".mcp.digitalocean.com")) return "digitalocean";
    return hosts[host];
  } catch { return undefined; }
}
