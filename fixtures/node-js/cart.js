'use strict';

function computeTotals(items) {
  const subtotal = items.reduce((sum, item) => sum + item.qty * item.price, 0);
  const tax = Math.round(subtotal * 0.0825 * 100) / 100;
  const result = { subtotal, tax, total: Math.round((subtotal + tax) * 100) / 100 };
  console.log('totals computed', result);
  return result;
}

module.exports = { computeTotals };
