export interface Tracing {
  id: string | number;
  toolCalls: ToolCall[];
  score?: number | null;
  finalOutput?: string | null;
  eventSchemaVersion?: string;
  participants?: WorkflowParticipant[];
  events?: ToolCall[];
  eventLinks?: WorkflowEventLink[];
  outcomes?: WorkflowOutcome[];
  importMetadata?: Record<string, unknown>;
  workflowRef?: { corpusId: string; traceKey: string };
  workflowSummary?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ToolCall {
  id?: string;
  name: string;
  args?: unknown;
  response?: unknown;
  status?: string | null;
  parentCallIds?: Array<string | number>;
  eventType?: string;
  agentId?: string;
  role?: string;
  round?: number;
  phase?: string;
  source?: Record<string, unknown>;
  diagnostics?: Array<{ kind: string; severity: string; description: string }>;
  patterns?: string[];
}

export type WorkflowParticipant = { id: string; label: string; role?: string; environment?: Record<string, unknown> };
export type WorkflowEventLink = { source: string; target: string; relation: string; evidenceLevel?: string; inferred?: boolean; evidence?: unknown[] };
export type WorkflowOutcome = { id: string; name: string; metric: string; value: number; eventId: string; round: number; direction?: string;
  scope?: string; kind?: string; terminal?: boolean; observedThroughRound?: number };

export type WorkflowInsights = {
  version: 'workflow-insights-v1';
  scope: { runCount: number; eventCount: number; roundIndexing: 'zero-based' };
  timing: {
    runs: Array<{
      traceId: string; roundCount: number;
      activitiesByAgent: Array<{ agentId: string; role: string | null; eventCount: number; firstRound: number | null; lastRound: number | null; activeSpanRounds: number | null; activeRoundCount: number; activeRounds: number[] }>;
      communication: {
        publications: number; receptions: number; sourcePayloadMismatchCount: number; transportMismatchCount: number; linkedDeliveries: number;
        deliveryLag: { count: number; meanRounds: number | null; maxRounds: number | null };
        sharedExposureCount: number; localExposureCount: number; uniqueExposedReceptionCount: number; observedReceptionCoverage: number | null;
        promptExposures: number; exposureLag: { count: number; meanRounds: number | null; maxRounds: number | null };
        coverageBasis: string;
      };
    }>;
    aggregate: {
      publicationCount: number; receptionCount: number; sourcePayloadMismatchCount: number; transportMismatchCount: number; linkedDeliveryCount: number;
      deliveryLag: { count: number; meanRounds: number | null; maxRounds: number | null };
      sharedExposureCount: number; localExposureCount: number; uniqueExposedReceptionCount: number; observedReceptionCoverage: number | null;
      promptExposureCount: number; exposureLag: { count: number; meanRounds: number | null; maxRounds: number | null };
      coverageBasis: string;
    };
  };
  outcomes: { runs: Array<{ traceId: string; scoreMetric: string | null; score: number | null; metrics: Array<{
    name: string; metric: string; scope: string; participantId: string | null;
    finalMeaning: 'terminal_outcome' | 'last_recorded_milestone';
    first: { value: number; round: number | null; eventId: string | null; observedThroughRound: number | null } | null;
    final: { value: number; round: number | null; eventId: string | null; observedThroughRound: number | null } | null;
    best: { value: number; round: number | null; eventId: string | null; observedThroughRound: number | null } | null;
  }> }> };
  keySteps: { runs: Array<{ traceId: string; metrics: Array<{ name: string; metric: string; value: number; eventId: string | null; round: number | null; observedThroughRound: number | null; witness: Array<{
    eventId: string; eventType: string | null; agentId: string | null; round: number | null; relationToNext: string | null; truncatedEarlierPath?: boolean;
  }> }> }> };
  skills: Array<{ id: string; pattern: string; patternTypes: string[]; label: string; role: string | null; runSupport: number;
    status: 'candidate'; preconditions?: string[]; procedure?: string[]; outcomeEvidence?: string;
    sourceExamples: Array<{ traceId: string; agentId: string; eventIds: string[] }>;
    applicability?: string | null; limitations?: string | null }>;
};

export type ToolSets = Record<string, string[]>;

export type ToolImpact = {
  toolName: string;
  usageCount: number;
  impact: number;
  impactAbs: number;
  meanPresentScore: number | null;
  meanAbsentScore: number | null;
};

export type GraphMode = "collapsed" | "tree";

export type ProvenanceGraphMode = GraphMode | "comparison";

export type ActivityNode = {
  id: string;
  kind: "Activity";
  toolCallId: string;
  tool: string;
  timeIndex: number;
  args?: unknown;
  status?: string | null;
  eventType?: string;
  agentId?: string;
  role?: string;
  round?: number;
  phase?: string;
  source?: Record<string, unknown>;
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
    kind: "recorded" | "reference" | "token" | "semantic";
    shared?: string[];
    score?: number;
  }>;
  inferred?: boolean;
  eventRelation?: string;
};

export type ProvGraph = {
  nodes: ProvNode[];
  edges: ProvEdge[];
};

export type AgentDag = ProvGraph;

export type JoinedProvenanceNode = {
  id: string;
  kind: "JoinedActivity";
  label: string;
  semanticRole: string;
  supportTraces: string[];
  supportCount: number;
  methods: string[];
  source?: { label: string; identity: string };
  attention: "key" | "supporting";
  resultBackbone: boolean;
  executionContext?: { laneId: string; roundStart: number; roundEnd: number; phase?: string; eventOrder?: number };
  assessment?: {
    status: 'assessed' | 'unknown';
    level: 'key' | 'supporting' | 'unknown';
    semanticLabel: string;
    reason: string;
    evidence: Array<{ callId: string; field: string; path: string; quote: string }>;
    jointGroupIds: string[];
    keySupportCount?: number;
    assessedSupportCount?: number;
    perTrace?: Array<{ run: string; level: 'key' | 'supporting' | 'unknown'; reason: string }>;
  };
  eventSummary?: { eventCount: number; diagnostics: string[]; outcomes: Array<{ name: string; value: number }> };
  importance: {
    decision: "expand" | "summarize" | "collapse";
    reasons: string[];
    support: number;
    tier: "key" | "result" | "failure" | "context";
    facets: Array<{ id: string; label: string }>;
    semantic: { level: "key" | "supporting" };
    result: {
      status: "supported" | "contradicted" | "referenced" | "none" | "missing-final" | "no-candidates";
      supportedClaims: string[];
      contradictedClaims: string[];
      onRecordedPath: boolean;
    };
    outcome: {
      status: "available" | "exploratory" | "insufficient" | "unavailable" | "not_identifiable";
      contributions: Array<{ traceId: string; taskId: string; scoreMetric: string; value: number; sampleCount: number; stability: number }> | null;
      cohorts: Array<{ taskId: string; sampleCount: number; status: string }>;
      globalTools: Array<{
        tool: string; status: "available" | "exploratory"; scoreMetric: string;
        importance: number; meanWhenPresent: number; sampleCount: number; taskCount: number;
        varyingTaskCount: number; presentCount: number; absentCount: number; cvGain: number | null;
        contributions: Array<{ traceId: string; value: number }>;
      }>;
      patterns?: Array<{ name: string; importance: number; status: string; sampleCount: number; stability: number; contributions: Array<{ traceId: string; value: number }> }>;
    };
    outcomeStatistics?: object | null;
  };
  variants: Array<{
    run: string;
    instanceId: string;
    parameters: object;
    roleBindings: Record<string, unknown>;
    diagnostics: unknown[];
    evidence: unknown[];
  }>;
  instances: Array<{
    id: string;
    run: string;
    calls: Array<{ id: string; tool: string; step: number }>;
    internalFlow: Array<{ source: string; target: string }>;
    resultTargets: string[];
    resultBackbone: boolean;
    background: boolean;
    attention: "key" | "supporting";
    targetEvidence: unknown[];
    resultStatus?: "available" | "missing-final" | "no-candidates";
    resultEvidence?: Array<{
      claimId: string;
      claimText: string;
      relation: "supports" | "contradicts" | "context";
      reason: string;
      bundleId?: string;
      joint?: boolean;
      evidence: Array<{ path: string; quote: string }>;
    }>;
    source?: { label: string; callId: string; identity: string };
  }>;
  operationGroups: Array<{
    id: string;
    tool: string;
    failure: boolean;
    supportTraces: string[];
    members: Array<{
      run: string;
      callId: string;
      step: number;
      inputEntityIds: string[];
      outputEntityIds: string[];
    }>;
    parameterVariants: Array<{
      parameters: object;
      members: Array<{ run: string; callId: string }>;
    }>;
  }>;
  scoreSummary?: JoinedScoreSummary;
};

export type JoinedProvenanceEdge = {
  id: string;
  source: string;
  target: string;
  supportTraces: string[];
  supportCount: number;
  inferred: boolean;
  relation?: string;
  witnesses: Array<{
    run: string;
    sourceInstance: string;
    targetInstance: string;
    callPath: string[];
    inferred: boolean;
    highlighted: boolean;
    relevance?: 'relevant' | 'context' | 'unknown';
    jointGroupIds?: string[];
    internalPath: unknown[];
    reason?: string;
    evidence?: Array<{ callId: string; field: "args" | "response"; path: string; quote: string }>;
  }>;
  evidence?: ProvEdge['evidence'];
  scoreSummary?: JoinedScoreSummary;
};

export type JoinedScoreSummary = {
  average: number | null;
  maximum: number | null;
};

export type JoinedProvenanceGraph = {
  nodes: JoinedProvenanceNode[];
  edges: JoinedProvenanceEdge[];
  omittedCalls: Array<{ run: string; id: string; tool: string; step: number }>;
  generation: "mechanical";
  detail: "overview" | "all";
  templateVersion: string;
  workflow?: {
    lanes: Array<{ id: string; label: string; kind: 'agent' | 'role'; participantIds: string[] }>;
    roundRange: [number, number]; roundLabel: string; laneBy: 'agent' | 'role'; granularity?: 'activity';
  };
  workflowAssessment?: {
    version: string; cached: boolean; coverage: Record<string, number>;
    retrieval?: Record<string, unknown>;
    runs?: Array<{ run: string; retrieval: { rounds: number; cachedRounds: number; assessedEvents: number; unassessedEvents: number;
      stopReason: string; remainingFrontier: number } }>;
    jointGroups: Array<{ id: string; run: string; label: string; reason: string;
      sourceCallIds: string[]; targetCallIds: string[];
      evidence: Array<{ callId: string; field: string; path: string; quote: string }> }>;
  };
  workflowAttribution?: { cohorts: Array<Record<string, unknown>> };
  workflowInsights?: WorkflowInsights;
  structuredOutcomes?: Array<{ run: string; outcomes: WorkflowOutcome[] }>;
  projection?: { candidateEdges: number; shownEdges: number; hiddenContextEdges?: number };
  warnings: string[];
  cohort: {
    cachedCount: number;
    requestedCount: number;
    missingCount: number;
    source: string;
  };
  model?: string;
  scoreSummary?: JoinedScoreSummary;
  alignment: {
    mode: "tool-signature" | "participant-episode";
    sharedPatterns: number;
  };
  compression: {
    sourceCalls: number;
    visibleCalls: number;
    hiddenCalls: number;
    visibleNodes: number;
    multiCallGroups: number;
    expandedActivities?: number;
    supportingPoints?: number;
    unknownPoints?: number;
  };
  modelMetrics: {
    requestCount: number;
    elapsedSeconds: number;
    promptTokens: number;
  };
  resultEvidence?: Array<{
    run: string;
    status: "available" | "missing-final" | "no-candidates";
    claims: Array<{
      id: string;
      text: string;
      assessed: boolean;
      source: { start: number; end: number; quote: string };
      retrieved: Array<{ callId: string; tool: string; step: number; path: string; quote: string; retrievalScore: number }>;
      links: Array<{
        callId: string;
        relation: "supports" | "contradicts" | "context";
        reason: string;
        bundleId?: string;
        joint?: boolean;
        evidence: Array<{ path: string; quote: string }>;
      }>;
    }>;
    coverage?: { totalClaims: number; consideredClaims: number; candidateClaims: number; assessedClaims: number; linkedClaims: number };
  }>;
};
