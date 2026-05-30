import { useEffect, useState } from 'react';

interface StringInputProps {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
}

// Inline text input. Mirrors NumberInput's "edit locally, commit on
// blur / Enter / Escape-to-cancel" pattern so a half-typed string never
// triggers a graph-mutation (and a downstream re-eval) on every
// keystroke. Common case: typing/pasting a URL into core/image, where
// each keystroke would otherwise trigger a fetch.
export function StringInput({ value, onChange, placeholder }: StringInputProps) {
  const [text, setText] = useState(value);
  const [editing, setEditing] = useState(false);

  // Sync external value into local text whenever we're NOT mid-edit.
  // Mid-edit we keep the user's draft so a re-render from another
  // source (e.g. a sibling node's re-evaluation) doesn't clobber it.
  useEffect(() => {
    if (!editing) setText(value);
  }, [value, editing]);

  const commit = () => {
    if (text !== value) onChange(text);
    setEditing(false);
  };

  return (
    <input
      type="text"
      value={text}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onFocus={() => setEditing(true)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        } else if (e.key === 'Escape') {
          setText(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
      className="sedon-stringinput"
    />
  );
}
