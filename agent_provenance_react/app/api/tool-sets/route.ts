export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEFAULT_BACKEND_URL = "http://127.0.0.1:8008/";

function backendUrl(path: string) {
  return new URL(
    path,
    (process.env.PROVENANCE_BACKEND_URL ?? DEFAULT_BACKEND_URL).replace(/\/?$/, "/")
  );
}

export async function POST(request: Request) {
  try {
    const response = await fetch(backendUrl("api/tool-sets"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: await request.text(),
      cache: "no-store",
    });

    return new Response(response.body, {
      status: response.status,
      headers: {
        "Content-Type": response.headers.get("Content-Type") ?? "application/json",
      },
    });
  } catch {
    return new Response("Provenance backend is unavailable.", {
      status: 502,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}
