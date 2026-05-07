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

export type JoinedProvenanceNode = {
  id: string;
  kind: "Root" | "JoinedActivity";
  label: string;
  supportTraces: string[];
  supportCount: number;
  multiplicityByTrace: Record<string, number>;
  members: unknown[];
  representativeSignature: unknown;
  rootSetsByTrace: Record<string, string[][]>;
  confidence: number;
  supportRatio?: number;
  scoreSummary?: JoinedScoreSummary;
};

export type JoinedProvenanceEdge = {
  id: string;
  source: string;
  target: string;
  supportTraces: string[];
  supportCount: number;
  relationTypes: string[];
  rawEdges: unknown[];
  count: number;
  scoreSummary?: JoinedScoreSummary;
};

export type JoinedScoreSummary = {
  highScoreTraces: string[];
  lowScoreTraces: string[];
  averageScore: number | null;
  isAnomaly: boolean;
};

export type JoinedProvenanceGraph = {
  nodes: JoinedProvenanceNode[];
  edges: JoinedProvenanceEdge[];
  motifs: Array<{
    path: string[];
    supportTraces: string[];
    supportCount: number;
    highScoreSupport?: number;
    lowScoreSupport?: number;
    scoreLift?: number;
  }>;
  threshold: number;
  rootDefinitionsByTrace: Record<string, unknown[]>;
  scoreSummary?: {
    min: number;
    max: number;
    median: number;
  } | null;
};
