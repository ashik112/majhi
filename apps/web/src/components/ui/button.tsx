import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

export const buttonVariants = cva(
  [
    "inline-flex shrink-0 cursor-pointer select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md",
    "font-medium transition-[background-color,border-color,color] duration-150",
    "disabled:pointer-events-none disabled:opacity-45 aria-disabled:pointer-events-none aria-disabled:opacity-45",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        primary: [
          "bg-accent font-semibold text-accent-ink shadow-[0_6px_18px_-8px_var(--c-accent)] hover:bg-accent-hover active:bg-accent-press",
          "[&_kbd]:border-accent-ink/25 [&_kbd]:text-accent-ink/75",
        ],
        secondary:
          "border border-line-control bg-raised text-fg hover:border-line-hover hover:bg-selected active:bg-selected",
        ghost: "text-fg-muted hover:bg-raised hover:text-fg active:bg-selected",
      },
      size: {
        sm: "h-7 px-2.5 text-sm [&_svg]:size-3.5",
        md: "h-[34px] px-3 text-base [&_svg]:size-3.5",
        lg: "h-10 px-4 text-base [&_svg]:size-4",
        xl: "h-11 px-4 text-body [&_svg]:size-4",
        icon: "size-8 [&_svg]:size-4",
        "icon-sm": "size-7 [&_svg]:size-3.5",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export interface ButtonProps extends ComponentProps<"button">, VariantProps<typeof buttonVariants> {
  /** Render the single child (for example a router Link) with button styles. */
  asChild?: boolean;
}

export function Button({ className, variant, size, asChild = false, type, ...props }: ButtonProps) {
  if (asChild) return <Slot className={cn(buttonVariants({ variant, size }), className)} {...props} />;
  return (
    <button type={type ?? "button"} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  );
}
