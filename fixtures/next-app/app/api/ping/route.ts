export async function GET(request: Request) {
  const url = new URL(request.url);
  console.log('route handler ping', { path: url.pathname, at: Date.now() > 0 });
  const payload = { ok: true, engine: 'app-router' };
  payload; // ?
  return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
}
