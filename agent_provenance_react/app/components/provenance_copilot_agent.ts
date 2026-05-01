import type { GraphMode, ProvenanceGraphMode, Tracing } from "./types";

export type CopilotTool = {
  name: string;
  execute: (args: unknown) => unknown | Promise<unknown>;
};

type CopilotAgentOptions = {
  endpoint?: string;
  tools?: CopilotTool[];
};

type CopilotRunInput = {
  question: string;
  selectedTraces: Tracing[];
  graphMode: GraphMode;
};

export class ProvenanceCopilotAgent {
  private readonly endpoint: string;
  private readonly tools: Map<string, CopilotTool>;

  constructor(options: CopilotAgentOptions = {}) {
    this.endpoint = options.endpoint ?? "/api/provenance-agent";
    this.tools = new Map(options.tools?.map((tool) => [tool.name, tool]));
  }

  async run(input: CopilotRunInput, onText: (text: string) => void) {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        question: input.question.trim(),
        selectedTraces: input.selectedTraces,
        graphMode: this.getGraphMode(input),
      }),
    });

    if (!response.ok) {
      throw new Error((await response.text()) || "Unable to get an answer.");
    }

    if (!response.body) {
      throw new Error("Streaming is not available for this response.");
    }

    await this.readTextStream(response.body, onText);
  }

  async callTool(name: string, args: unknown) {
    const tool = this.tools.get(name);

    if (!tool) {
      throw new Error(`Unknown copilot tool: ${name}`);
    }

    return tool.execute(args);
  }

  private getGraphMode(input: CopilotRunInput): ProvenanceGraphMode {
    return input.selectedTraces.length >= 2 ? "comparison" : input.graphMode;
  }

  private async readTextStream(
    body: ReadableStream<Uint8Array>,
    onText: (text: string) => void
  ) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let text = "";

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      text += decoder.decode(value, { stream: true });
      onText(text);
    }

    text += decoder.decode();
    onText(text);
  }
}
