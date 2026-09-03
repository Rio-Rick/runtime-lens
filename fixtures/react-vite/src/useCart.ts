import { useCallback, useState } from 'react';

export interface Item {
  sku: string;
  qty: number;
  price: number;
}

export function useCart(): { items: Item[]; addItem: (item: Item) => void; total: number } {
  const [items, setItems] = useState<Item[]>([]);

  const addItem = useCallback((item: Item) => {
    console.log('adding item', item);
    setItems((current) => {
      const next = [...current, item];
      console.debug('cart size', next.length);
      return next;
    });
  }, []);

  const total = items.reduce((sum, item) => sum + item.qty * item.price, 0);
  total; // ?

  return { items, addItem, total };
}
