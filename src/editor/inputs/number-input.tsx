import { useEffect, useState } from 'react';

interface NumberInputProps {
  value: number;
  onChange: (next: number) => void;
  integer?: boolean;
  step?: number;
}

export function NumberInput({ value, onChange, integer, step }: NumberInputProps) {
  // Local text state lets the user type intermediate values like "-" or "1."
  // without the underlying number flipping to NaN.
  const [text, setText] = useState(() => String(value));

  useEffect(() => {
    setText(String(value));
  }, [value]);

  const commit = (s: string) => {
    const n = integer ? parseInt(s, 10) : parseFloat(s);
    if (Number.isFinite(n) && n !== value) onChange(n);
    else setText(String(value));
  };

  return (
    <input
      type="number"
      value={text}
      step={step ?? (integer ? 1 : 0.01)}
      onChange={(e) => setText(e.target.value)}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit((e.target as HTMLInputElement).value);
          (e.target as HTMLInputElement).blur();
        }
      }}
      style={inputStyle}
    />
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: '#1a1a1f',
  border: '1px solid #555',
  borderRadius: 3,
  color: '#ddd',
  fontSize: 12,
  padding: '3px 6px',
  fontFamily: 'inherit',
};
