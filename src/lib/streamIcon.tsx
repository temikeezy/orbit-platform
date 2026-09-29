import {
  Antenna,
  Blocks,
  CalendarDays,
  ClipboardList,
  Code2,
  FlaskConical,
  GraduationCap,
  Lightbulb,
  Megaphone,
  Microscope,
  Palette,
  PenLine,
  Sparkles,
  Wrench,
  Layers,
  type LucideIcon,
} from 'lucide-react';

/**
 * The icon for a stream.
 *
 * Streams used to render as INITIALS in a grey box — "S", "GD", "EC" — which is
 * an avatar convention borrowed from people and applied to teams, where it says
 * nothing. A stream is a kind of work, and an icon names that at a glance in a
 * way two letters never will.
 *
 * Matched on the stream NAME rather than an id, because streams are created by
 * admins and the set is not fixed: a new stream picks up a sensible icon without
 * a code change, and an unmatched one falls back to `Layers` rather than
 * breaking the layout.
 *
 * Ordered most-specific first — "Software Engineering" must be tested before
 * "Engineering", or every engineering stream would share one icon.
 */
const RULES: { match: RegExp; icon: LucideIcon }[] = [
  { match: /software|coding|app develop/i, icon: Code2 },
  { match: /product test|testing|\bqa\b/i, icon: FlaskConical },
  { match: /blockchain|web3|crypto/i, icon: Blocks },
  { match: /graphic|design|animation/i, icon: Palette },
  { match: /social media|content creation/i, icon: Megaphone },
  { match: /writing|storytell|blog/i, icon: PenLine },
  { match: /research|documentation/i, icon: Microscope },
  { match: /entrepreneur|innovation support|business/i, icon: Lightbulb },
  { match: /admin|task support|organis|organiz/i, icon: ClipboardList },
  { match: /event|community/i, icon: CalendarDays },
  { match: /e-?learning|course|training/i, icon: GraduationCap },
  { match: /telecom/i, icon: Antenna },
  { match: /mechanical|automobile|automotive/i, icon: Wrench },
  { match: /special|emerging/i, icon: Sparkles },
];

export function streamIconFor(name: string | null | undefined): LucideIcon {
  const value = (name ?? '').trim();
  for (const rule of RULES) if (rule.match.test(value)) return rule.icon;
  return Layers;
}

/** Renders the icon at a given pixel size, for the square badge on stream cards. */
export function StreamIcon({
  name,
  className,
}: {
  name: string | null | undefined;
  className?: string;
}) {
  const Icon = streamIconFor(name);
  return <Icon className={className} strokeWidth={1.75} aria-hidden />;
}
