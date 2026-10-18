export type TraceSource = { name: string; path?: string; text?: string };
export type WorkflowCorpus = {
  corpusId: string;
  label: string;
  runCount: number;
  version: string;
  currentVersion: boolean;
};

export const DISCOVERA_SOURCE: TraceSource & { path: string } = {
  name: "Discovera",
  path: "/tracings.jsonl",
};

export function corpusSource(corpus: WorkflowCorpus) {
  const count = ` · ${corpus.runCount} runs`;
  const name = corpus.label.endsWith(count) ? corpus.label : `${corpus.label}${count}`;
  return {
    name: corpus.currentVersion ? name : `${name} · earlier import (${corpus.version})`,
    path: `/api/workflow-corpora/${corpus.corpusId}`,
  };
}
