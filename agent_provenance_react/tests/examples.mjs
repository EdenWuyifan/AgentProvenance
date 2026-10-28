import assert from 'node:assert/strict';
import { EXAMPLES, DEFAULT_TRACE_SOURCE, parseTraceView, traceViewUrl } from '../app/components/trace_sources.ts';
assert.deepEqual(EXAMPLES.map(example=>example.name),['Discovera','App world (Use Case 2)','Suzuki']);
assert.equal(DEFAULT_TRACE_SOURCE.path,'/tracings.jsonl');
assert.deepEqual(parseTraceView('').runs,[]);
assert.equal(EXAMPLES[1].sources.length,2);
for(const source of EXAMPLES.flatMap(example=>example.sources)){
 const view=parseTraceView(traceViewUrl(source,['run-a','run-b'],'evidence',1,{context:'inputs',minSupport:2}).slice(1));
 assert.equal(view.source,source);assert.deepEqual(view.runs,['run-a','run-b']);assert.equal(view.axis,'evidence');assert.deepEqual(view.filters,{minSupport:2,context:'inputs'});
}
assert.equal(parseTraceView('?source=https://untrusted.example/data').source,DEFAULT_TRACE_SOURCE);
assert.equal(parseTraceView('?source=/api/workflow-corpora/imported').source.path,'/api/workflow-corpora/imported');
console.log('Three dropdown examples, generic task sources, unselected default and reproducible views passed');
