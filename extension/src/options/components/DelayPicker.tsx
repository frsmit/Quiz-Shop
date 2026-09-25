import { useId } from 'react';

interface Preset {
  readonly label: string;
  readonly value: number;
}

interface DelayPickerProps {
  label: string;
  hint?: string;
  id: string;
  value: number;
  presets: readonly Preset[];
  onChange: (value: number) => void;
}

/**
 * A delay expressed as presets plus a free-text seconds box.
 *
 * Presets cover the cases people actually want; the box is there because
 * someone always wants 45 seconds.
 */
export function DelayPicker({ label, hint, id, value, presets, onChange }: DelayPickerProps) {
  const customId = useId();
  const isPreset = presets.some((preset) => preset.value === value);

  return (
    <div className="field">
      <span className="field-label">{label}</span>

      <div className="chips" role="group" aria-label={label}>
        {presets.map((preset) => (
          <button
            key={preset.value}
            type="button"
            className={`chip ${value === preset.value ? 'chip-on' : ''}`}
            aria-pressed={value === preset.value}
            onClick={() => onChange(preset.value)}
          >
            {preset.label}
          </button>
        ))}
        <span className={`chip chip-custom ${isPreset ? '' : 'chip-on'}`}>
          <label htmlFor={`${id}-${customId}`}>Custom</label>
          <input
            id={`${id}-${customId}`}
            type="number"
            min={0}
            step={1}
            value={Math.round(value / 1000)}
            onChange={(event) => onChange(Math.max(0, Number(event.target.value)) * 1000)}
          />
          <span>s</span>
        </span>
      </div>

      {hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}
