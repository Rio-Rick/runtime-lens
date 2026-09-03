export interface Stats {
  samples: number;
  p50: number;
  p95: number;
  collectedAt: Date;
}

export async function loadStats(): Promise<Stats> {
  const samples = [12, 18, 25, 44, 91];
  const sorted = [...samples].sort((a, b) => a - b);
  const stats: Stats = {
    samples: sorted.length,
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    collectedAt: new Date('2026-04-04T12:00:00.000Z')
  };
  console.debug('computed stats', stats);
  return stats;
}
