import { PortkeyProvenanceAgent } from "../../lib/portkey_provenance_agent";
import type { GraphMode } from "../../components/provenance_graph";
import type { Tracing } from "../../components/types";

export const dynamic = "force-dynamic";

type RequestBody = {
  question?: unknown;
  selectedTraces?: unknown;
  graphMode?: unknown;
};

function getGraphMode(value: unknown): GraphMode | "comparison" {
  if (value === "collapsed" || value === "tree" || value === "comparison") {
    return value;
  }

  return "tree";
}

export async function POST(request: Request) {
  let body: RequestBody;

  try {
    body = (await request.json()) as RequestBody;
  } catch {
    return new Response("Invalid JSON body.", {
      status: 400,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }

  const question = typeof body.question === "string" ? body.question.trim() : "";

  if (!question) {
    return new Response("Question is required.", {
      status: 400,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }

  const selectedTraces = Array.isArray(body.selectedTraces)
    ? (body.selectedTraces as Tracing[])
    : [];

  try {
    const agent = new PortkeyProvenanceAgent();
    const stream = await agent.streamChat({
      question,
      selectedTraces,
      graphMode: getGraphMode(body.graphMode),
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to answer question.";

    return new Response(message, {
      status: 500,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }
}