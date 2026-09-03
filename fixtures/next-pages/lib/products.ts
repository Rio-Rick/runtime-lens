export interface Product {
  id: string;
  name: string;
  price: number;
}

const CATALOG: Product[] = [
  { id: 'p1', name: 'Lens cloth', price: 4.5 },
  { id: 'p2', name: 'Tripod', price: 89 }
];

export function listProducts(): Product[] {
  console.log('listing products', CATALOG.length);
  return CATALOG;
}

export function findProduct(id: string): Product | undefined {
  const found = CATALOG.find((p) => p.id === id);
  found; // ?
  return found;
}
