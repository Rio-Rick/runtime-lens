import React, { useMemo, useState } from 'react';
import { useCart } from './useCart';

interface AppProps {
  initialCount: number;
}

export function App({ initialCount }: AppProps): JSX.Element {
  const [count, setCount] = useState(initialCount);
  const { items, addItem, total } = useCart();

  const doubled = useMemo(() => {
    const value = count * 2;
    console.debug('recomputing doubled', { count, value });
    return value;
  }, [count]);

  doubled; // ?

  console.log('render', { count, items: items.length, total });

  return (
    <main>
      <h1>Runtime Lens fixture</h1>
      <p data-testid="count">count: {count}</p>
      <button onClick={() => { setCount((c) => c + 1); console.info('increment', count + 1); }}>+1</button>
      <button onClick={() => addItem({ sku: `S-${count}`, qty: 1, price: 3.5 })}>add item</button>
      <ul>
        {items.map((item) => (
          <li key={item.sku}>
            {item.sku} × {item.qty} — {item.price}
          </li>
        ))}
      </ul>
    </main>
  );
}
