import type {
  AgentDag,
  GraphMode,
  JoinedProvenanceGraph,
  ProvenanceGraphMode,
  Tracing,
} from "./types";

type CopilotRunInput = {
  question: string;
  chatHistory: CopilotHistoryMessage[];
  selectedTraces: Tracing[];
  selectedTraceDags: Record<string, AgentDag>;
  joinedGraph: JoinedProvenanceGraph | null;
  graphMode: GraphMode;
};

export type CopilotHistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

export type CopilotStreamEvent =
  | { type: "message_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_call"; id: string; name: string; args?: unknown }
  | { type: "tool_result"; id: string; name?: string; result?: unknown }
  | { type: "final"; output?: string }
  | { type: "error"; message: string };

export class ProvenanceCopilotAgent {
  private readonly endpoint: string;

  constructor(endpoint = "/api/provenance-agent") {
    this.endpoint = endpoint;
  }

  async run(input: CopilotRunInput, onEvent: (event: CopilotStreamEvent) => void) {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        question: input.question.trim(),
        chatHistory: input.chatHistory,
        selectedTraces: input.selectedTraces,
        selectedTraceDags: input.selectedTraceDags,
        joinedGraph: input.joinedGraph,
        graphMode: this.getGraphMode(input),
      }),
    });

    if (!response.ok) {
      throw new Error((await response.text()) || "Unable to get an answer.");
    }

    if (!response.body) {
      throw new Error("Streaming is not available for this response.");
    }

    await this.readEventStream(response.body, onEvent);
  }

  private getGraphMode(input: CopilotRunInput): ProvenanceGraphMode {
    return input.selectedTraces.length >= 2 ? "comparison" : input.graphMode;
  }

  private async readEventStream(
    body: ReadableStream<Uint8Array>,
    onEvent: (event: CopilotStreamEvent) => void
  ) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      buffer = this.readLines(buffer, onEvent);
    }

    buffer += decoder.decode();
    this.readLines(`${buffer}\n`, onEvent);
  }

  private readLines(buffer: string, onEvent: (event: CopilotStreamEvent) => void) {
    const lines = buffer.split("\n");
    const rest = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      try {
        onEvent(JSON.parse(line) as CopilotStreamEvent);
      } catch {
        onEvent({ type: "message_delta", delta: line });
      }
    }

    return rest;
  }
}
