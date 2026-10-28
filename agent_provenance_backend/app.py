"""Fast recorded provenance with one cached batch of semantic pattern annotations."""

import re
import sys
from time import perf_counter

from fastapi import FastAPI, Request
from fastapi.responses import PlainTextResponse

from abstraction import align_instances, build_views, compatible_path
from copilot import provenance_agent_response
from inference import capture_metrics, SEMANTIC_MODEL, together
from models import CACHE_DIR, FRAMEWORK_VERSION, ModelResponseError, digest, read_cache, write_json
from models import ROOT
from provenance import build_recorded_graph, call_flow, normalize_calls, project_dependencies
from fast_review import review_traces, VERSION as REVIEW_VERSION
from semantics import PROMPT_VERSION, annotate_types, instantiate, resolve_targets
from score_attribution import VERSION as OUTCOME_VERSION
from workflows import has_workflow, normalize_workflow, build_workflow_view
from workflow_store import resolve_entry, save_corpus, list_corpora, load_manifest
from skill_patterns import mine_input_patterns
from initial_context import normalize_initial_context
from analysis_snapshots import load_snapshot
from evidence_records import retain_cited_containers

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
    outcome = entry.get('trainingOutcome', {})
    if not isinstance(outcome, dict) or outcome.get('status') not in {None, 'success', 'failure', 'unknown'}:
        raise ValueError('trainingOutcome.status must be success, failure, or unknown.')
    return trace_id, calls


def analysis_key(entry):
    trace_id, calls = trace_inputs(entry)
    initial_context = normalize_initial_context(entry)
    source = [FRAMEWORK_VERSION, trace_id, calls, entry.get('taskDescription'), entry.get('finalOutput'),
              entry.get('participants'), entry.get('eventLinks'), entry.get('outcomes'), entry.get('importMetadata'),
              initial_context]
    if entry.get('referenceSchema') is not None:
        source.append(entry['referenceSchema'])
    return digest(source)


def with_context(analysis, entry):
    return {**analysis, 'taskId': entry.get('taskId'), 'score': entry.get('score'),
            'initialContext': normalize_initial_context(entry),
            'trainingOutcome': entry.get('trainingOutcome', {}),
            'scoreMetric': entry.get('scoreMetric', 'score'),
            'targetCallIds': entry.get('targetCallIds', []),
            'outcomes': entry.get('outcomes', analysis.get('outcomes', [])),
            'finalOutput': entry.get('finalOutput', analysis.get('finalOutput'))}


async def analyze_trace(entry):
    entry = resolve_entry(entry)
    if entry.get('snapshotRef'):
        cached = load_snapshot(entry)
        return with_context(cached, {**cached, **entry}), True
    key = analysis_key(entry)
    path = CACHE_DIR / 'analyses' / f'{key}.json'
    cached = read_cache(path)
    if cached is not None:
        return with_context(cached, entry), True
    started = perf_counter()
    trace_id, calls = trace_inputs(entry)
    workflow = normalize_workflow(entry, calls) if has_workflow(entry) else None
    graph = build_recorded_graph(calls, workflow['eventLinks'] if workflow else entry.get('eventLinks'),
                                 entry.get('referenceSchema'))
    analysis = {'traceId': trace_id, 'calls': calls, 'graph': graph, 'flow': call_flow(graph),
                'analysisKey': key, 'frameworkVersion': FRAMEWORK_VERSION,
                'taskDescription': entry.get('taskDescription'), 'finalOutput': entry.get('finalOutput'),
                'initialContext': normalize_initial_context(entry),
                'generationMetrics': [], 'buildSeconds': round(perf_counter() - started, 6)}
    if workflow:
        analysis['workflow'] = workflow
    if entry.get('referenceSchema') is not None:
        analysis['referenceSchema'] = entry['referenceSchema']
    write_json(path, analysis)
    return with_context(analysis, entry), False


async def analyze_selection(entries):
    ids = [str(entry['traceId']) for entry in entries]
    if len(set(ids)) != len(ids):
        raise ValueError('Selected trace IDs must be unique.')
    results = [await analyze_trace(entry) for entry in sorted(entries, key=lambda e: str(e['traceId']))]
    return [analysis for analysis, _ in results], all(cached for _, cached in results)


def with_review(analysis, review):
    review = retain_cited_containers(review)
    result = review['resultEvidence']
    recorded = [edge for edge in analysis['flow'] if not edge.get('inferred')]
    known = {(edge['source'], edge['target']) for edge in recorded}
    return {**analysis, 'resultEvidence': result, 'evidenceReview': review,
            'resultAnchors': sorted({link['callId'] for claim in result['claims'] for link in claim['links']
                                     if link['relation'] in {'supports', 'contradicts'}} |
                                    {row['callId'] for row in review.get('observedResults', [])}),
            'observedResults': review.get('observedResults', []),
            'initialContextUses': review.get('initialContextUses', []),
            'inputBindings': review.get('inputBindings', []),
            'flow': recorded + [
                {'source': link['sourceCallId'], 'target': link['targetCallId'], 'inferred': True,
                 'relation': link['relation'], 'reason': link['reason'], 'evidence': link['evidence'],
                 'selectedEvidence': link.get('selectedEvidence', []),
                 'evidenceRole': link.get('evidenceRole', 'inferred_input'),
                 'parameterUses': link.get('parameterUses', []),
                 'missingInputs': link.get('missingInputs', [])}
                for link in review['links'] if link.get('inferred')
                and link.get('relevance') == 'relevant'
                and (link['sourceCallId'], link['targetCallId']) not in known]}


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
            found[str(entry['traceId'])] = with_context(cached, {**cached, **entry} if cached.get('importedSnapshot') else entry)
    requested = {str(entry['traceId']) for entry in entries}
    return list(found.values()), {'requestedCount': len(requested), 'cachedCount': len(found),
                                 'missingCount': len(requested - found.keys()),
                                 'source': 'Cached source traces only; missing traces are unknown.'}


async def comparison_view(analyses, reference, cohort, focus='', detail='overview', tool_reference=(), lane_by='agent'):
    started = perf_counter()
    if any(a.get('importedSnapshot') for a in analyses):
        if not all(a.get('importedSnapshot') for a in analyses):
            raise ValueError('Select imported snapshots separately from live analyses.')
        analyses = [resolve_targets(a) for a in analyses]
        if any(a.get('workflow') for a in analyses):
            if not all(a.get('workflow') for a in analyses):
                raise ValueError('Select workflow snapshots separately from ordinary analysis snapshots.')
            references = {a['traceId']: a for a in reference if a.get('workflow')}
            for entry in tool_reference:
                if entry.get('workflowSummary'):
                    references.setdefault(str(entry['traceId']), {**entry, 'traceId': str(entry['traceId']),
                                                                   'workflow': entry['workflowSummary']})
            assessment_sources = [*reference, *analyses]
            assessment_by_run = {a['traceId']: a['workflowAssessment'] for a in assessment_sources
                                 if a.get('workflowAssessment')}
            workflow_assessments = {'version': 'imported-workflow-assessment', 'cached': True,
                'runs': [{'traceId': run, **assessment} for run, assessment in assessment_by_run.items()]}
            graph = build_workflow_view(analyses, list(references.values()), cohort, focus, detail, lane_by,
                                        workflow_assessments=workflow_assessments)
            graph['semanticReview'] = {'version': 'imported-analysis-snapshot', 'cached': True,
                'runs': [{'run': a['traceId'], 'reviewed': sum(
                    event.get('status') == 'assessed' for event in
                    a.get('workflowAssessment', {}).get('events', {}).values()), 'supplied': None,
                          'total': len(a['calls'])} for a in analyses]}
        else:
            analyses = [align_instances(a) for a in analyses]
            graph = build_views(analyses, reference, cohort, focus, detail, tool_reference)
            graph['semanticReview'] = {'version': 'imported-analysis-snapshot', 'cached': True,
                'runs': [{'run': a['traceId'], 'reviewed': a['evidenceReview']['reviewedActivities'],
                    'supplied': a['evidenceReview']['suppliedActivities'], 'total': len(a['calls'])}
                    for a in analyses]}
        graph['inputPatterns'] = mine_input_patterns(analyses)
        graph['importedSnapshots'] = [{'run': a['traceId'], **a['importedSnapshot']} for a in analyses]
        graph['modelMetrics'] = {'requestCount': 0, 'embeddingRequestCount': 0, 'elapsedSeconds': 0,
                                 'promptTokens': 0, 'requests': []}
        graph['processingSeconds'] = round(perf_counter() - started, 6)
        graph['warnings'].append('Frozen imported interpretations; local selection and filtering do not rerun inference.')
        return graph, True
    lanes = any(analysis.get('workflow') for analysis in analyses)
    if lanes:
        lane_analyses = []
        for analysis in analyses:
            if not analysis.get('workflow'):
                calls = [dict(call) for call in analysis['calls']]
                analysis = {**analysis, 'calls': calls, 'workflow': normalize_workflow(
                    {'eventLinks': analysis['flow'], 'outcomes': analysis.get('outcomes', [])}, calls)}
            lane_analyses.append(analysis)
        analyses = lane_analyses
    universe = {a['traceId']: a for a in reference}
    universe.update({a['traceId']: a for a in analyses})
    sources = [resolve_targets(universe[key]) for key in sorted(universe)]

    async def stage_plans():
        if lanes:
            return {a['traceId']: a for a in sources}, None, None
        policy, annotation = await annotate_types(sources, focus)
        return {a['traceId']: a for a in sources}, annotation, policy

    try:
        with capture_metrics() as metrics:
            (enriched, annotation, policy), assessments = await together(stage_plans(), review_traces(analyses, focus))
            for review in assessments['runs']:
                run = review['traceId']
                enriched[run] = with_review(enriched[run], review)
            if policy is not None:
                enriched = {run: instantiate(a, policy) for run, a in enriched.items()}
            selected = [enriched[a['traceId']] for a in analyses]
    except (KeyError, TypeError, IndexError) as error:
        raise ModelResponseError(f'Invalid evidence interpretation: {error}') from error

    if lanes:
        references = {a['traceId']: a for a in reference if a.get('workflow')}
        for entry in tool_reference:
            if entry.get('workflowSummary'):
                references.setdefault(str(entry['traceId']), {**entry, 'traceId': str(entry['traceId']),
                                                              'workflow': entry['workflowSummary']})
        graph = build_workflow_view(selected, list(references.values()), cohort, focus, detail, lane_by,
                                    workflow_assessments=assessments)
    else:
        enriched_reference = [{**entry, 'instances': enriched[entry['traceId']]['instances']} for entry in reference]
        graph = build_views(selected, enriched_reference, cohort, focus, detail, tool_reference)
    graph['semanticReview'] = {'version': assessments['version'], 'cached': assessments['cached'],
        'runs': [{'run': r['traceId'], 'reviewed': r['reviewedActivities'], 'supplied': r['suppliedActivities'],
                  'total': r['totalActivities'], 'dependencySearch': r.get('dependencySearch')} for r in assessments['runs']]}
    graph['inputPatterns'] = mine_input_patterns(selected)
    retrieval = [r['dependencySearch'] for r in assessments['runs'] if not r.get('cached') and r.get('dependencySearch')]
    embedding_count = sum(r['embeddingRequests'] for r in retrieval)
    graph['modelMetrics'] = {'requestCount': sum(not m.get('cached') for m in metrics),
                             'embeddingRequestCount': embedding_count,
                             'elapsedSeconds': round(sum(m['elapsedSeconds'] for m in metrics)
                                                     + sum(r['embeddingSeconds'] for r in retrieval), 3),
                             'promptTokens': sum(m['promptTokens'] or 0 for m in metrics), 'requests': metrics}
    if annotation is not None:
        graph['annotation'] = annotation
    graph['processingSeconds'] = round(perf_counter() - started, 6)
    return graph, (assessments['cached'] and (annotation is None or annotation['newTypes'] == 0))


@app.get('/health')
def health():
    return {'ok': True, 'framework': FRAMEWORK_VERSION, 'promptVersion': PROMPT_VERSION,
            'semanticReviewVersion': REVIEW_VERSION, 'workflowReviewRoundLimit': 0,
            'inferenceProvider': 'codex', 'model': SEMANTIC_MODEL}


@app.get('/api/pattern-policy')
def pattern_policy():
    return {'promptVersion': PROMPT_VERSION, 'reviewVersion': REVIEW_VERSION,
            'outcomeVersion': OUTCOME_VERSION, 'framework': FRAMEWORK_VERSION}


@app.post('/api/prov-graph')
async def prov_graph(request: Request):
    try:
        analysis, cached = await analyze_trace(await request.json())
        result = {'dag': project_dependencies(analysis), 'analysis': {key: analysis[key] for key in ('traceId', 'analysisKey', 'frameworkVersion')}, 'cached': cached}
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
    return await provenance_agent_response(await request.json())
