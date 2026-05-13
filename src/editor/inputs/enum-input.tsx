// Dropdown editor for Int inputs that declare `enumOptions`. The
// stored value stays a plain integer; the dropdown just narrows the
// user to the legal set and gives each option a readable label.
//
// Styled to match the rest of the inline editors (NumberInput,
// BoolInput) — same height + visual weight, no decoration that would
// stand out among them.
interface EnumInputProps {
  value: number;
  options: ReadonlyArray<{ value: number; label: string }>;
  onChange: (next: number) => void;
}

export function EnumInput({ value, options, onChange }: EnumInputProps) {
  return (
    <select
      className="nodrag nopan sedon-enum-edit"
      value={String(value)}
      onChange={(e) => onChange(Number(e.target.value))}
    >
      {options.map((o) => (
        <option key={o.value} value={String(o.value)}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
