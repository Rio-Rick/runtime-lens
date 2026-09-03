import type { ReactNode } from 'react';

export const metadata = { title: 'Runtime Lens app-router fixture' };

export default function RootLayout({ children }: { children: ReactNode }) {
  console.log('rendering root layout');
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
