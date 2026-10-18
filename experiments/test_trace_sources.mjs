import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { corpusSource, DISCOVERA_SOURCE } from '../agent_provenance_react/app/components/trace_sources.ts';
import { parseTracingPayload } from '../agent_provenance_react/app/components/visualization_shared.js';

const current = { corpusId: 'current', label: 'Cooperative chemistry · 40 runs', runCount: 40,
  version: 'workflow-activities-v2', currentVersion: true };
const previous = { ...current, corpusId: 'previous', label: 'Cooperative chemistry',
  version: 'workflow-events-v1', currentVersion: false };
assert.equal(corpusSource(current).name, 'Cooperative chemistry · 40 runs');
assert.equal(corpusSource(previous).name, 'Cooperative chemistry · 40 runs · earlier import (workflow-events-v1)');
assert.equal(corpusSource(current).path, '/api/workflow-corpora/current');
assert.notEqual(corpusSource(current).path, corpusSource(previous).path);
assert.notEqual(corpusSource(current).path, DISCOVERA_SOURCE.path);

const discovera = parseTracingPayload(readFileSync(new URL(`../agent_provenance_react/public${DISCOVERA_SOURCE.path}`, import.meta.url), 'utf8'));
assert.ok(discovera.length > 0);
assert.ok(discovera.some((trace) => trace.task_id === '5.1'));
assert.ok(discovera.every((trace) => !trace.workflowRef));
console.log(`Trace sources passed: Discovera (${discovera.length} runs), current and earlier workflow imports.`);
