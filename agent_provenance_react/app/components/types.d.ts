export interface Tracing {
  id: string | number;
  toolCalls: ToolCall[];
  score?: number | null;
}

export interface ToolCall {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
  response?: unknown;
}
