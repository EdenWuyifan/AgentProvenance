export interface Tracing {
  id: string | number;
  toolCalls: ToolCall[];
  score?: number | null;
  [key: string]: unknown;
}

export interface ToolCall {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
  response?: unknown;
}
