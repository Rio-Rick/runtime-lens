export interface Order {
  id: string;
  customer: string;
  lines: OrderLine[];
  placedAt: Date;
}

export interface OrderLine {
  sku: string;
  qty: number;
  unitPrice: number;
}

export type Currency = 'USD' | 'EUR';
