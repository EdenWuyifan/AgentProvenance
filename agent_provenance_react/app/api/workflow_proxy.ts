export async function workflowProxy(path: string, request?: Request) {
  try {
    const base = (process.env.PROVENANCE_BACKEND_URL ?? 'http://127.0.0.1:8008/').replace(/\/?$/, '/');
    const response = await fetch(new URL(path, base), {
      method: request ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: request ? await request.text() : undefined,
      cache: 'no-store',
    });
    return new Response(response.body, { status: response.status,
      headers: { 'Content-Type': response.headers.get('Content-Type') ?? 'application/json' } });
  } catch {
    return new Response('Provenance backend is unavailable.', { status: 502 });
  }
}
