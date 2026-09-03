import type { GetServerSideProps } from 'next';
import { listProducts, type Product } from '../lib/products';

interface Props {
  products: Product[];
  renderedAt: string;
}

export const getServerSideProps: GetServerSideProps<Props> = async () => {
  const products = listProducts();
  console.info('SSR products', products.map((p) => p.id));
  return { props: { products, renderedAt: new Date('2026-03-03T00:00:00.000Z').toISOString() } };
};

export default function Home({ products, renderedAt }: Props) {
  console.log('client render', { count: products.length, renderedAt });
  const cheapest = products.reduce((min, p) => (p.price < min.price ? p : min), products[0]);
  cheapest; // ?

  return (
    <main>
      <h1>Pages router fixture</h1>
      <ul>
        {products.map((product) => (
          <li key={product.id}>
            {product.name} — {product.price}
          </li>
        ))}
      </ul>
      <button onClick={() => console.warn('clicked', cheapest?.id)}>log cheapest</button>
    </main>
  );
}
