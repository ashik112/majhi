import { type ConnectionView, serviceByUrl } from "@majhi/shared";
import { Globe, KeyRound, Laptop, Mail, Network, Plug, Server } from "lucide-react";
import { cn } from "@/lib/cn";

const LOGOS: Readonly<Record<string, string>> = {
  linear: "linear",
  "linear-key": "linear",
  sentry: "sentry",
  "sentry-token": "sentry",
  notion: "notion",
  atlassian: "atlassian",
  vercel: "vercel",
  "vercel-cli": "vercel",
  cloudflare: "cloudflare",
  "cloudflare-observability": "cloudflare",
  stripe: "stripe",
  "stripe-cli": "stripe",
  posthog: "posthog",
  grafana: "grafana",
  datadog: "datadog",
  betterstack: "betterstack",
  gitlab: "gitlab",
  "gitlab-git": "gitlab",
  github: "github",
  bitbucket: "bitbucket",
  paypal: "paypal",
  intercom: "intercom",
  canva: "canva",
  webflow: "webflow",
  zapier: "zapier",
  outlook: "microsoftoutlook",
  gmail: "gmail",
  google: "gmail",
  "google-calendar": "googlecalendar",
  "google-drive": "googledrive",
  slack: "slack",
  discord: "discord",
  aws: "amazonaws",
  gcloud: "googlecloud",
  az: "microsoftazure",
};

/** Local SVG marks, with a neutral backing so brand colors work in both themes. */
export function ServiceLogo({
  service,
  type,
  className,
}: {
  service?: string | undefined;
  type?: ConnectionView["type"] | undefined;
  className?: string;
}) {
  const slug = service?.startsWith("digitalocean") ? "digitalocean" : LOGOS[service ?? ""];
  // A service with no mark of its own gets its first letter, not a plug: the name beside it says which.
  const letter =
    slug === undefined && service !== undefined && type === undefined ? service.charAt(0) : undefined;
  const Fallback =
    type === "ssh"
      ? Server
      : type === "kubectl"
        ? Network
        : type === "env"
          ? KeyRound
          : type === "mail"
            ? Mail
            : type === "browser"
              ? Globe
              : type === "host"
                ? Laptop
                : Plug;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-11 shrink-0 items-center justify-center rounded-lg",
        slug ? "bg-[#fff]" : "border border-line-control bg-raised text-fg-muted",
        className,
      )}
    >
      {slug ? (
        <img
          src={`/service-logos/${slug}.svg`}
          alt=""
          width={28}
          height={28}
          className="size-[64%] object-contain"
        />
      ) : letter !== undefined ? (
        <span className="font-mono text-base font-semibold uppercase">{letter}</span>
      ) : (
        <Fallback className="size-[50%]" />
      )}
    </span>
  );
}

/** Managed services store their id; remote MCP services also identify themselves by their URL. */
export function serviceOf(view: ConnectionView): string | undefined {
  const explicit = view.fields.service?.value;
  if (explicit) return explicit;
  if (view.type === "cli") {
    const tool = view.fields.tool?.value;
    return tool === "vercel" ? "vercel-cli" : tool === "stripe" ? "stripe-cli" : tool;
  }
  if (view.type === "git") return view.fields.provider?.value ?? "gitlab";
  const address = view.fields.url?.value;
  if (!address) return undefined;
  const known = serviceByUrl(address)?.id;
  if (known !== undefined) return known;
  try {
    const host = new URL(address).hostname;
    const hosts: Record<string, string> = {
      "mcp.linear.app": "linear",
      "mcp.sentry.dev": "sentry",
      "mcp.cloudflare.com": "cloudflare",
      "mcp.neon.tech": "neon",
      "mcp.paypal.com": "paypal",
      "mcp.intercom.com": "intercom",
      "mcp.canva.com": "canva",
      "mcp.webflow.com": "webflow",
      "mcp.zapier.com": "zapier",
      "mcp.notion.com": "notion",
      "mcp.atlassian.com": "atlassian",
      "mcp.vercel.com": "vercel",
      "mcp.stripe.com": "stripe",
      "mcp.posthog.com": "posthog",
      "mcp.grafana.com": "grafana",
      "mcp.gitlab.com": "gitlab",
    };
    if (host.endsWith(".mcp.digitalocean.com")) return "digitalocean";
    return hosts[host];
  } catch {
    return undefined;
  }
}
