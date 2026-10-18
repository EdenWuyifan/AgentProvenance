"""Fast recorded provenance with one cached batch of semantic pattern annotations."""

import re
import sys
from time import perf_counter

from fastapi import FastAPI, Request
from fastapi.responses import PlainTextResponse

from abstraction import build_views, compatible_path
from copilot import provenance_agent_response
from inference import capture_metrics, portkey_client, together
from models import CACHE_DIR, FRAMEWORK_VERSION, ModelResponseError, digest, read_cache, write_json
from models import ROOT
from provenance import build_recorded_graph, call_flow, normalize_calls
from reasoning_links import PROMPT_VERSION as REASONING_VERSION, infer_links
from result_evidence import PROMPT_VERSION as RESULT_VERSION, associate_results
from semantics import PROMPT_VERSION, annotate_types, instantiate, resolve_targets
from score_attribution import VERSION as OUTCOME_VERSION
from workflows import has_workflow, normalize_workflow, event_graph, build_workflow_view
from workflow_store import resolve_entry, save_corpus, list_corpora, load_manifest
from workflow_semantics import assess_workflow, VERSION as WORKFLOW_PROMPT_VERSION, MAX_ROUNDS as WORKFLOW_ROUND_LIMIT

sys.path.insert(0, str(ROOT))
from agent_provenance.workflow_import import import_record

app = FastAPI()


def trace_inputs(entry):
    trace_id = str(entry['traceId'])
    raw_calls = entry.get('events', entry.get('toolCalls', []))
    if entry.get('eventSchemaVersion'):
        identifiers = [call.get('id') for call in raw_calls]
        if any(not isinstance(identifier, str) or not identifier for identifier in identifiers) or len(set(identifiers)) != len(identifiers):
            raise ValueError('Workflow events need unique nonempty string IDs.')
    calls = normalize_calls(raw_calls, trace_id)
    for field in ('taskDescription', 'finalOutput'):
        if entry.get(field) is not None and not isinstance(entry[field], str):
            raise ValueError(f'{field} must be text.')
    return trace_id, calls


def analysis_key(entry):
    trace_id, calls = trace_inputs(entry)
    return digest([FRAMEWORK_VERSION, trace_id, calls, entry.get('taskDescription'), entry.get('finalOutput'),
                   entry.get('participants'), entry.get('eventLinks'), entry.get('outcomes'), entry.get('importMetadata')])


def with_context(analysis, entry):
    return {**analysis, 'taskId': entry.get('taskId'), 'score': entry.get('score'),
            'scoreMetric': entry.get('scoreMetric', 'score'),
            'targetCallIds': entry.get('targetCallIds', []),
            'finalOutput': entry.get('finalOutput', analysis.get('finalOutput'))}


async def analyze_trace(entry):
    entry = resolve_entry(entry)
    key = analysis_key(entry)
    path = CACHE_DIR / 'analyses' / f'{key}.json'
    cached = read_cache(path)
    if cached is not None:
        return with_context(cached, entry), True
    started = perf_counter()
    trace_id, calls = trace_inputs(entry)
    workflow = normalize_workflow(entry, calls) if has_workflow(entry) else None
    graph = event_graph(calls, workflow) if workflow else build_recorded_graph(calls)
    analysis = {'traceId': trace_id, 'calls': calls, 'graph': graph, 'flow': call_flow(graph),
                'analysisKey': key, 'frameworkVersion': FRAMEWORK_VERSION,
                'taskDescription': entry.get('taskDescription'), 'finalOutput': entry.get('finalOutput'),
                'generationMetrics': [], 'buildSeconds': round(perf_counter() - started, 6)}
    if workflow:
        analysis['workflow'] = workflow
    write_json(path, analysis)
    return with_context(analysis, entry), False


async def analyze_selection(entries):
    ids = [str(entry['traceId']) for entry in entries]
    if len(set(ids)) != len(ids):
        raise ValueError('Selected trace IDs must be unique.')
    results = [await analyze_trace(entry) for entry in sorted(entries, key=lambda e: str(e['traceId']))]
    return [analysis for analysis, _ in results], all(cached for _, cached in results)


def reference_analyses(entries):
    found = {}
    for entry in entries:
        key = entry.get('analysisKey')
        if key is None:
            continue
        if not isinstance(key, str) or not re.fullmatch(r'[0-9a-f]{64}', key):
            raise ValueError('Reference analysisKey must be a SHA-256 digest.')
        cached = read_cache(CACHE_DIR / 'analyses' / f'{key}.json')
        if cached is not None and cached['traceId'] == str(entry['traceId']) and cached['frameworkVersion'] == FRAMEWORK_VERSION:
            found[str(entry['traceId'])] = with_context(cached, entry)
    requested = {str(entry['traceId']) for entry in entries}
    return list(found.values()), {'requestedCount': len(requested), 'cachedCount': len(found),
                                 'missingCount': len(requested - found.keys()),
                                 'source': 'Cached source traces only; missing traces are unknown.'}


async def comparison_view(analyses, reference, cohort, focus='', detail='overview', tool_reference=(), lane_by='agent'):
    started = perf_counter()
    if any(analysis.get('workflow') for analysis in analyses):
        for analysis in analyses:
            if not analysis.get('workflow'):
                analysis['workflow'] = normalize_workflow({}, analysis['calls'])
        references = {analysis['traceId']: analysis for analysis in reference if analysis.get('workflow')}
        for entry in tool_reference:
            if entry.get('workflowSummary'):
                references.setdefault(str(entry['traceId']), {**entry, 'traceId': str(entry['traceId']), 'workflow': entry['workflowSummary']})
        text_runs = [analysis for analysis in analyses if analysis.get('finalOutput')]
        with capture_metrics() as metrics:
            if text_runs:
                evidence, interpretation = await associate_results(text_runs)
                analyses = [{**analysis, 'resultEvidence': evidence[analysis['traceId']],
                             'resultAnchors': sorted({link['callId'] for claim in evidence[analysis['traceId']]['claims']
                                                      for link in claim['links'] if link['relation'] in {'supports', 'contradicts'}})}
                            if analysis['traceId'] in evidence else analysis for analysis in analyses]
            assessments = await assess_workflow(analyses, focus=focus)
        graph = build_workflow_view(analyses, list(references.values()), cohort, focus, detail, lane_by,
                                    workflow_assessments=assessments)
        graph['modelMetrics'] = {'requestCount': len(metrics),
                                 'elapsedSeconds': round(sum(m['elapsedSeconds'] for m in metrics), 3),
                                 'promptTokens': sum(m['promptTokens'] or 0 for m in metrics), 'requests': metrics}
        if text_runs:
            graph['resultInterpretation'] = interpretation
        graph['processingSeconds'] = round(perf_counter() - started, 6)
        return graph, assessments['cached'] and (not text_runs or interpretation['newTraces'] == 0)
    universe = {a['traceId']: a for a in reference}
    universe.update({a['traceId']: a for a in analyses})
    sources = [resolve_targets(universe[key]) for key in sorted(universe)]

    async def annotate_and_link():
        policy, annotation = await annotate_types(sources, focus)
        enriched = {a['traceId']: instantiate(a, policy) for a in sources}
        links, reasoning = await infer_links([enriched[a['traceId']] for a in analyses])
        enriched = {key: {**a, 'flow': a['flow'] + links[key]} if key in links else a
                    for key, a in enriched.items()}
        return enriched, annotation, reasoning

    try:
        with capture_metrics() as metrics:
            (enriched, annotation, reasoning), (results, result_metrics) = await together(
                annotate_and_link(), associate_results(analyses))
            enriched = {key: {**a, 'resultEvidence': results[key], 'resultAnchors': sorted({
                link['callId'] for claim in results[key]['claims'] for link in claim['links']
                if link['relation'] in {'supports', 'contradicts'}})} if key in results else a
                for key, a in enriched.items()}
    except (KeyError, TypeError, IndexError) as error:
        raise ModelResponseError(f'Invalid pattern annotation: {error}') from error
    selected = [enriched[a['traceId']] for a in analyses]
    enriched_reference = [{**entry, 'instances': enriched[entry['traceId']]['instances']} for entry in reference]
    graph = build_views(selected, enriched_reference, cohort, focus, detail, tool_reference)
    graph['modelMetrics'] = {'requestCount': len(metrics),
                             'elapsedSeconds': round(sum(m['elapsedSeconds'] for m in metrics), 3),
                             'promptTokens': sum(m['promptTokens'] or 0 for m in metrics),
                             'requests': metrics}
    graph['annotation'] = annotation
    graph['reasoning'] = reasoning
    graph['resultInterpretation'] = result_metrics
    graph['processingSeconds'] = round(perf_counter() - started, 6)
    return graph, annotation['newTypes'] == 0 and reasoning['newTraces'] == 0 and result_metrics['newTraces'] == 0


@app.get('/health')
def health():
    return {'ok': True, 'framework': FRAMEWORK_VERSION, 'promptVersion': PROMPT_VERSION,
            'workflowPromptVersion': WORKFLOW_PROMPT_VERSION, 'workflowReviewRoundLimit': WORKFLOW_ROUND_LIMIT}


@app.get('/api/pattern-policy')
def pattern_policy():
    return {'promptVersion': PROMPT_VERSION, 'reasoningVersion': REASONING_VERSION,
            'resultVersion': RESULT_VERSION, 'outcomeVersion': OUTCOME_VERSION, 'framework': FRAMEWORK_VERSION}


@app.post('/api/prov-graph')
async def prov_graph(request: Request):
    try:
        analysis, cached = await analyze_trace(await request.json())
        result = {'dag': analysis['graph'], 'analysis': {key: analysis[key] for key in ('traceId', 'analysisKey', 'frameworkVersion')}, 'cached': cached}
        if analysis.get('workflow'):
            result['tracing'] = {'id': analysis['traceId'], 'eventSchemaVersion': 'workflow-events-v1',
                                 'toolCalls': [{'name': call['tool'], **{key: value for key, value in call.items()
                                               if key not in {'tool', 'sourceId', 'traceId', 'timeIndex'}}} for call in analysis['calls']],
                                 'participants': analysis['workflow']['participants'],
                                 'outcomes': analysis['workflow']['outcomes']}
        return result
    except (ValueError, KeyError, TypeError, FileNotFoundError) as error:
        return PlainTextResponse(f'Invalid trace: {error}', status_code=422)


@app.get('/api/workflow-corpora')
def workflow_corpora():
    return {'corpora': list_corpora()}


@app.get('/api/workflow-corpora/{corpus_id}')
def workflow_corpus(corpus_id: str):
    try:
        return load_manifest(corpus_id)
    except (ValueError, FileNotFoundError) as error:
        return PlainTextResponse(str(error), status_code=404)


@app.post('/api/import-workflows')
async def import_workflows(request: Request):
    try:
        body = await request.json()
        records = body['records']
        traces = (record if record.get('eventSchemaVersion') else import_record(record, f'upload:{index}')
                  for index, record in enumerate(records))
        return save_corpus(traces, body.get('label', 'Imported workflows'))
    except (ValueError, KeyError, TypeError) as error:
        return PlainTextResponse(f'Invalid workflow import: {error}', status_code=422)


@app.post('/api/joined-provenance-graph')
async def joined_provenance_graph(request: Request):
    try:
        body = await request.json()
        detail = body.get('detail', 'overview')
        if detail not in {'overview', 'all'}:
            raise ValueError('detail must be overview or all.')
        analyses, cached = await analyze_selection(body.get('graphs', []))
        reference, cohort = reference_analyses(body.get('referenceCohort', []))
        graph, annotated = await comparison_view(analyses, reference, cohort, body.get('focus', ''), detail,
                                                body.get('referenceCohort', []), body.get('laneBy', 'agent'))
        return {'joinedGraph': graph, 'cached': cached and annotated}
    except ModelResponseError as error:
        return PlainTextResponse(f'Invalid pattern annotation: {error}', status_code=502)
    except (ValueError, KeyError, TypeError) as error:
        return PlainTextResponse(f'Invalid comparison: {error}', status_code=422)
    except Exception as error:
        return PlainTextResponse(f'Pattern annotation failed: {type(error).__name__}: {error}', status_code=502)


@app.post('/api/validate-path')
async def validate_path(request: Request):
    try:
        body = await request.json()
        if not isinstance(body.get('familyPath'), list) or len(body['familyPath']) < 2:
            raise ValueError('familyPath needs at least two stage IDs.')
        analyses, _ = await analyze_selection(body.get('graphs', []))
        reference, cohort = reference_analyses(body.get('referenceCohort', []))
        graph, _ = await comparison_view(analyses, reference, cohort, body.get('focus', ''), body.get('detail', 'overview'),
                                        body.get('referenceCohort', []), body.get('laneBy', 'agent'))
        witnesses = compatible_path(graph, body['familyPath'], str(body['traceId']))
        return {'valid': bool(witnesses), 'witnessChains': witnesses}
    except ModelResponseError as error:
        return PlainTextResponse(f'Invalid pattern annotation: {error}', status_code=502)
    except (ValueError, KeyError, TypeError) as error:
        return PlainTextResponse(f'Invalid path: {error}', status_code=422)


@app.post('/api/tool-sets')
async def tool_sets(request: Request):
    names = sorted(set((await request.json()).get('toolNames', [])))
    groups = {}
    for name in names:
        namespace = re.split(r'[_.:/]', name, maxsplit=1)[0] or 'Tools'
        groups.setdefault(namespace, []).append(name)
    return {'toolSets': groups, 'cached': True}


@app.post('/api/provenance-agent')
async def provenance_agent(request: Request):
    return await provenance_agent_response(await request.json(), portkey_client)
