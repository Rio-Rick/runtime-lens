/* Runtime Lens fixture: ESM + TypeScript Node app.
   Type annotations, generics, enums and `satisfies` must all survive the
   type-stripping pass, and probes must report original .ts line numbers. */
import { orderTotal } from './pricing.js';
import type { Currency, Order } from './types.js';

enum Channel {
  Web = 'web',
  Store = 'store'
}

const order: Order = {
  id: 'ord_77',
  customer: 'ada',
  placedAt: new Date('2026-02-02T08:00:00.000Z'),
  lines: [
    { sku: 'X-1', qty: 3, unitPrice: 12.5 },
    { sku: 'Y-2', qty: 1, unitPrice: 99 }
  ]
};

const currency: Currency = 'USD';

export function run(): number {
  console.log('order', order.id, 'channel', Channel.Web);
  const total = orderTotal(order);
  console.info('total', total, currency);

  const registry = new Map<string, { hits: bigint }>([['a', { hits: 10n }]]);
  console.log('registry', registry);

  const missing = (order as Partial<Order>).customer ?? 'anonymous';
  missing; // ?

  return total;
}

run();
