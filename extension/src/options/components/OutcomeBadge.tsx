import type { ActivityOutcome } from '../../shared/types';

/**
 * Monochrome status chips.
 *
 * With no colour to lean on, each outcome is told apart by fill weight, border
 * style and a leading glyph - which is also how it stays readable for anyone
 * who could not use the colour anyway.
 */
const STYLE: Record<ActivityOutcome, { variant: string; glyph: string; label: string }> = {
  answered: { variant: 'outline', glyph: '✓', label: 'answered' },
  cached: { variant: 'muted', glyph: '↺', label: 'cached' },
  filled: { variant: 'solid', glyph: '✓', label: 'filled' },
  'no-match': { variant: 'dashed', glyph: '?', label: 'no match' },
  'no-control': { variant: 'faint', glyph: '–', label: 'nothing to fill' },
  skipped: { variant: 'faint', glyph: '–', label: 'skipped' },
  error: { variant: 'strong', glyph: '!', label: 'error' },
};

export function OutcomeBadge({ outcome }: { outcome: ActivityOutcome }) {
  const style = STYLE[outcome];
  return (
    <span className={`badge badge-${style.variant}`}>
      <span className="badge-glyph" aria-hidden="true">
        {style.glyph}
      </span>
      {style.label}
    </span>
  );
}
