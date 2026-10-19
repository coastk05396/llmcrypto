import type { ReactNode } from "react";
import { CheckIcon, ClockIcon, InfoIcon, MinusCircleIcon, TriangleIcon, XCircleIcon } from "./Icons";
import { GUIDE_STATUS_LABEL, type GuideStatus } from "../lib/snippets";

export type { BadgeTone } from "../lib/tone";
import type { BadgeTone } from "../lib/tone";
const ICONS: Record<BadgeTone, ReactNode> = {
  success: <CheckIcon />,
  pending: <ClockIcon />,
  warning: <TriangleIcon />,
  danger: <XCircleIcon />,
  info: <InfoIcon />,
  neutral: <MinusCircleIcon />,
};

/** Icon shape and text label carry the meaning; color only reinforces it. */
export function Badge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return (
    <span className={`badge badge--${tone}`}>
      {ICONS[tone]}
      <span>{children}</span>
    </span>
  );
}

const GUIDE_TONE: Record<GuideStatus, BadgeTone> = { tested: "success", "api-checked": "info", "docs-only": "neutral" };
export function GuideStatusBadge({ status }: { status: GuideStatus }) {
  return <Badge tone={GUIDE_TONE[status]}>{GUIDE_STATUS_LABEL[status]}</Badge>;
}
