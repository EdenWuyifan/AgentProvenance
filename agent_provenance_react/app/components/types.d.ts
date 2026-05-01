export interface Tracing {
  id: string | number;
  toolCalls: ToolCall[];
  score?: number | null;
  [key: string]: unknown;
}

export interface ToolCall {
  id?: string;
  name: string;
  args?: unknown;
  response?: unknown;
  status?: string | null;
}

export type GraphMode = "collapsed" | "tree";

export type ProvenanceGraphMode = GraphMode | "comparison";

export type ActivityNode = {
  id: string;
  kind: "Activity";
  toolCallId: string;
  tool: string;
  timeIndex: number;
  args?: unknown;
};

export type EntityNode = {
  id: string;
  kind: "Entity";
  entityType: string;
  response?: unknown;
};

export type ProvNode = ActivityNode | EntityNode;

export type ProvEdge = {
  source: string;
  target: string;
  relation: "usedBy" | "generatedBy" | "informedBy";
  evidence?: Array<{
    kind: "artifact" | "shared_token" | "llm";
    shared?: string[];
    score?: number;
  }>;
};

export type ProvNodePatch = {
  tool?: string;
  entityType?: string;
  args?: unknown;
  response?: unknown;
};

export type ProvGraphEdit =
  | {
      op: "addEdge";
      edge: ProvEdge;
    }
  | {
      op: "removeEdge";
      edge: ProvEdge;
    }
  | {
      op: "editEdge";
      edge: ProvEdge;
      nextEdge: ProvEdge;
    }
  | {
      op: "addNode";
      node: EntityNode;
    }
  | {
      op: "removeNode";
      nodeId: string;
    }
  | {
      op: "editNode";
      nodeId: string;
      patch: ProvNodePatch;
    };

export type ProvGraph = {
  nodes: ProvNode[];
  edges: ProvEdge[];
};

export type AgentDag = ProvGraph;
