import { NumberInput } from './number-input.js';

interface VecInputProps {
  value: readonly number[];
  onChange: (next: number[]) => void;
  integer?: boolean;
}

export function VecInput({ value, onChange, integer }: VecInputProps) {
  return (
    <div className="sedon-vecinput">
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
