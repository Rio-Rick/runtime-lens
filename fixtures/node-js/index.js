/* Runtime Lens fixture: CommonJS Node app.
   Exercises multi-arg logs, every console level, containers, circular refs,
   execution counts in a loop, and a string that *looks* like a console call. */
'use strict';

const { computeTotals } = require('./cart');

const cart = {
  id: 'cart_1024',
  items: [
    { sku: 'A-1', qty: 2, price: 9.99 },
    { sku: 'B-7', qty: 1, price: 24.5 }
  ],
  createdAt: new Date('2026-01-15T10:30:00.000Z'),
  tags: new Set(['fresh', 'priority']),
  index: new Map([['A-1', 0], ['B-7', 1]])
};

// A trap for regex-based instrumentation: this is a *string*, not a call.
const helpText = 'call console.log(value) to print a value';

function main() {
  console.log('cart loaded', cart.id, cart.items.length);
  console.info('help text is', helpText.length, 'chars');

  const totals = computeTotals(cart.items);
  totals; // ?

  for (let i = 0; i < 3; i++) {
    console.debug('iteration', i, { squared: i * i });
  }

  const self = { name: 'root' };
  self.self = self;
  console.log('circular', self);

  console.warn('low stock for', cart.items[0].sku);

  try {
    JSON.parse('{ not json');
  } catch (err) {
    console.error('parse failed', err);
  }

  console.table(cart.items);
  return totals;
}

module.exports = { main, cart };

if (require.main === module) {
  main();
}
