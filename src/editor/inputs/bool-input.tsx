interface BoolInputProps {
  value: boolean;
  onChange: (next: boolean) => void;
}

export function BoolInput({ value, onChange }: BoolInputProps) {
  return (
    <input
      type="checkbox"
      checked={value}
      onChange={(e) => onChange(e.target.checked)}
      className="sedon-boolinput"
    />
  );
}
