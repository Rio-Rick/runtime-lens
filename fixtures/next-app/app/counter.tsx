'use client';

import { useState } from 'react';

export function Counter({ start }: { start: number }) {
  const [value, setValue] = useState(start);
  console.log('client counter render', value);

  const next = value + 1;
  next; // ?

  return (
    <button
      onClick={() => {
        console.info('counter clicked', { from: value, to: next });
        setValue(next);
      }}
    >
      count: {value}
    </button>
  );
}
