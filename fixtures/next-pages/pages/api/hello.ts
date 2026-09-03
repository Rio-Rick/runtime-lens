import type { NextApiRequest, NextApiResponse } from 'next';
import { findProduct } from '../../lib/products';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const id = typeof req.query.id === 'string' ? req.query.id : 'p1';
  console.log('api request', { id, method: req.method });
  const product = findProduct(id);
  if (!product) {
    console.error('product not found', id);
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.status(200).json({ product });
}
