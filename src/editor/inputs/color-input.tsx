type Rgba = readonly [number, number, number, number];

interface ColorInputProps {
  value: Rgba;
  onChange: (next: [number, number, number, number]) => void;
}

function toHex(c: number): string {
  return Math.max(0, Math.min(255, Math.round(c * 255))).toString(16).padStart(2, '0');
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

export function ColorInput({ value, onChange }: ColorInputProps) {
  const [r, g, b, a] = value;
  return (
    <input
      type="color"
      value={rgbToHex(r, g, b)}
      onChange={(e) => {
        const next = hexToRgb(e.target.value);
        if (next) onChange([next[0], next[1], next[2], a]);
      }}
      style={{
        width: '100%',
        height: 22,
        border: '1px solid #555',
        background: 'transparent',
        padding: 0,
        cursor: 'pointer',
      }}
    />
  );
}
