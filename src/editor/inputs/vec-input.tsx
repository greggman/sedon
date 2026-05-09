import { NumberInput } from './number-input.js';

interface VecInputProps {
  value: readonly number[];
  onChange: (next: number[]) => void;
  integer?: boolean;
}

export function VecInput({ value, onChange, integer }: VecInputProps) {
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      {value.map((component, i) => (
        <NumberInput
          key={i}
          value={component}
          integer={integer ?? false}
          onChange={(n) => {
            const next = [...value];
            next[i] = n;
            onChange(next);
          }}
        />
      ))}
    </div>
  );
}
