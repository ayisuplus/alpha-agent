import { useEffect, useState, type ReactNode } from "react";

/** `stacked` puts a wide control (text box, list) under its label instead of beside it. */
export function Field({ label, description, children, disabled, stacked }: { label: string; description?: ReactNode; children: ReactNode; disabled?: boolean; stacked?: boolean }) {
  return <div className={["settings-field", disabled ? "disabled" : "", stacked ? "stacked" : ""].filter(Boolean).join(" ")}>
    <div className="settings-field-text">
      <span className="settings-field-label">{label}</span>
      {description && <span className="settings-field-description">{description}</span>}
    </div>
    <div className="settings-field-control">{children}</div>
  </div>;
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange(value: boolean): void; label: string; disabled?: boolean }) {
  return <button role="switch" aria-checked={checked} aria-label={label} className="settings-toggle" disabled={disabled} onClick={() => onChange(!checked)}>
    <span className="settings-toggle-knob" />
  </button>;
}

export function Segmented<T extends string | number>({ value, options, onChange, label }: { value: T; options: Array<{ value: T; label: string }>; onChange(value: T): void; label: string }) {
  return <div className="settings-segmented" role="radiogroup" aria-label={label}>
    {options.map(option => <button key={String(option.value)} role="radio" aria-checked={option.value === value} onClick={() => onChange(option.value)}>{option.label}</button>)}
  </div>;
}

/** A number box that commits on blur or Enter, so typing an intermediate value never saves it. */
export function NumberInput({ value, min, max, step = 1, unit, onCommit, label }: { value: number; min: number; max: number; step?: number; unit?: string; onCommit(value: number): void; label: string }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) { setDraft(String(value)); return; }
    const next = Math.min(max, Math.max(min, Math.round(parsed / step) * step));
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };
  return <span className="settings-number">
    <input type="number" inputMode="numeric" aria-label={label} value={draft} min={min} max={max} step={step}
      onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.key === "Enter") commit(); }} />
    {unit && <span>{unit}</span>}
  </span>;
}

export function SectionTitle({ title, description }: { title: string; description?: string }) {
  return <header className="settings-section-header">
    <h2>{title}</h2>
    {description && <p>{description}</p>}
  </header>;
}
