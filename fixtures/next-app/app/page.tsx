import { Counter } from './counter';
import { loadStats } from './stats';

export default async function Page() {
  const stats = await loadStats();
  console.log('server component stats', stats);
  stats.p95; // ?

  return (
    <main>
      <h1>App router fixture</h1>
      <pre>{JSON.stringify(stats, null, 2)}</pre>
      <Counter start={stats.samples} />
    </main>
  );
}
