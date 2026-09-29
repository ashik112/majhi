import { useState } from "react";
import { CenteredPage } from "@/components/centered-page";
import { cn } from "@/lib/cn";
import { onboardingSteps } from "./steps";

/** Renders the current onboarding step under a small progress header. */
export function OnboardingFlow({ onFinish }: { onFinish: () => void }) {
  const [index, setIndex] = useState(0);
  const step = onboardingSteps[index];
  if (!step) return null;

  const isLast = index === onboardingSteps.length - 1;
  const { Component } = step;

  return (
    <CenteredPage>
      <nav aria-label="Setup progress" className="flex items-center gap-3">
        <ol className="flex items-center gap-1">
          {onboardingSteps.map((s, i) => (
            <li
              key={s.id}
              aria-current={i === index ? "step" : undefined}
              className={cn("h-1 w-6 rounded-full", i <= index ? "bg-amber" : "bg-line-strong")}
            >
              <span className="sr-only">{s.title}</span>
            </li>
          ))}
        </ol>
        <p className="font-mono text-xs text-fg-faint tabular-nums">
          Step {index + 1} of {onboardingSteps.length}
        </p>
      </nav>
      <Component
        key={step.id}
        isLast={isLast}
        onComplete={() => (isLast ? onFinish() : setIndex(index + 1))}
      />
    </CenteredPage>
  );
}
