import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

export const badgeVariants = cva(
  "inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-sm border px-1.5 text-xs [&_svg]:size-3",
  {
    variants: {
      tone: {
        neutral: "border-line-strong text-fg-muted",
        amber: "border-amber-line bg-amber-wash text-amber",
        blue: "border-blue-line bg-blue-wash text-blue",
        green: "border-green-line bg-green-wash text-green",
        red: "border-red-line bg-red-wash text-red",
      },
      mono: { true: "font-mono", false: "" },
    },
    defaultVariants: { tone: "neutral", mono: false },
  },
);

export interface BadgeProps extends ComponentProps<"span">, VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, mono, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone, mono }), className)} {...props} />;
}
