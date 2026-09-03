import type { Order, OrderLine } from './types.js';

export function lineTotal(line: OrderLine): number {
  const total = line.qty * line.unitPrice;
  console.debug('line total', line.sku, total);
  return total;
}

export function orderTotal(order: Order): number {
  const total = order.lines.reduce<number>((sum, line) => sum + lineTotal(line), 0);
  total; // ?
  return Number(total.toFixed(2));
}
