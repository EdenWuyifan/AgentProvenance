"""Evaluate provenance graph coverage across cached Discovera and Suzuki cases.

By default every semantic inference path fails closed on a cache miss. Pass
``--live`` only when fresh gateway requests are intended.
"""

import argparse
import asyncio
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path
from time import perf_counter

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'agent_provenance_backend'))

import app
import benchmark_abstraction
import reasoning_links
import result_evidence
import semantics
import workflow_semantics
import workflow_store
from agent_provenance.parser import parse_traces
from models import write_json

CASE_IDS = {
    'discovera-single': ['o4_mini:1215:5.1'],
    'discovera-two': ['o4_mini:1215:5.1', 'o4_mini:1212:5.1'],
    'discovera-other': ['o4_mini:1212:9.3'],
}
ALL_CASES = [*CASE_IDS, 'suzuki-42', 'suzuki-65', 'suzuki-78', 'suzuki-42+65']


async def _uncached_request(*_args, **_kwargs):
    raise RuntimeError('Offline evaluation stopped: an uncached model request was attempted; pass --live to allow it.')


def _offline_only():
    semantics.infer_json = _uncached_request
    reasoning_links.infer_json = _uncached_request
    result_evidence.infer_json = _uncached_request
    workflow_semantics.infer_json = _uncached_request


def _discovera_entries():
    path = ROOT / 'agent_provenance_react/public/tracings.jsonl'
    traces = {str(trace['id']): trace for trace in parse_traces(path)}
    entries = {}
    for trace_id in {item for ids in CASE_IDS.values() for item in ids}:
        trace = traces[trace_id]
        entries[trace_id] = {'traceId': trace_id, 'toolCalls': trace['tool_calls'],
                             'score': trace.get('score'), 'taskId': trace.get('task_id', trace.get('taskId')),
                             'scoreMetric': 'score', 'taskDescription': trace.get('task_description'),
                             'finalOutput': trace.get('finalOutput')}
    return entries


def _suzuki_entries():
    current = next(corpus for corpus in workflow_store.list_corpora() if corpus['currentVersion'])
    manifest = workflow_store.load_manifest(current['corpusId'])
    by_seed = {int(trace['seed']): trace for trace in manifest['traces']}
    return {seed: {'traceId': str(by_seed[seed]['id']), 'workflowRef': by_seed[seed]['workflowRef'],
                   'score': by_seed[seed].get('score'), 'taskId': by_seed[seed].get('task_id'),
                   'scoreMetric': by_seed[seed].get('scoreMetric'), 'taskDescription': by_seed[seed].get('task_description'),
                   'finalOutput': by_seed[seed].get('finalOutput')}
            for seed in (42, 65, 78)}


def _source_edges(analysis):
    return {(analysis['traceId'], edge['source'], edge['target'])
            for edge in analysis.get('flow', []) if not edge.get('inferred')
            and edge.get('source') is not None and edge.get('target') is not None}


def _represented_edges(graph):
    represented = set()
    for node in graph.get('nodes', []):
        for instance in node.get('instances', []):
            run = instance['run']
            represented.update((run, edge['source'], edge['target'])
                               for edge in instance.get('internalFlow', []) if not edge.get('inferred'))
    for edge in graph.get('edges', []):
        for witness in edge.get('witnesses', []):
            if witness.get('inferred'):
                continue
            path = witness.get('callPath', [])
            represented.update((witness['run'], source, target) for source, target in zip(path, path[1:]))
    return represented


def _graph_counts(graph, analyses):
    source_calls = {(analysis['traceId'], call['id']) for analysis in analyses for call in analysis['calls']}
    graph_calls, canvas_calls, graph_anchors, levels = set(), set(), {}, Counter()
    calls_by_node_run = defaultdict(set)
    for node in graph.get('nodes', []):
        level = node.get('assessment', {}).get('level') or node.get('importance', {}).get('semantic', {}).get('level')
        if level not in {'key', 'supporting', 'unknown'}:
            level = 'supporting' if node.get('attention') == 'supporting' else 'unknown'
        for instance in node.get('instances', []):
            calls = instance.get('calls', [])
            for call in calls:
                identity = (instance['run'], call['id'])
                canvas_calls.add(identity)
                graph_calls.add(identity)
                calls_by_node_run[(node['id'], instance['run'])].add(call['id'])
                levels[level] += 1
            graph_calls.update((instance['run'], call_id) for call_id in instance.get('internalCalls', []))
            graph_anchors.setdefault(instance['run'], set()).update(instance.get('resultTargets', []))
    source_edges = set().union(*(_source_edges(analysis) for analysis in analyses)) if analyses else set()
    represented_edges = _represented_edges(graph)
    missing_edges = sorted(source_edges - represented_edges)
    roots, anchors = {}, {}
    for result in graph.get('resultEvidence', []):
        run = result.get('run') or result.get('traceId')
        if run is None:
            continue
        anchors.setdefault(run, set())
        anchors[run].update(link['callId'] for claim in result.get('claims', [])
                            for link in claim.get('links', [])
                            if link.get('relation') in {'supports', 'contradicts'})
    for analysis in analyses:
        run = analysis['traceId']
        incoming = {target for r, _source, target in source_edges if r == run}
        roots[run] = sorted(call['id'] for call in analysis['calls'] if call['id'] not in incoming)
        anchor_ids = set(analysis.get('resultAnchors', [])) | set(analysis.get('targetCallIds', []))
        workflow = analysis.get('workflow', {})
        anchor_ids.update(outcome['eventId'] for outcome in workflow.get('outcomes', [])
                          if outcome.get('eventId') and outcome.get('scope') != 'participant'
                          and (outcome.get('terminal') or outcome.get('kind') == 'final'))
        anchors.setdefault(run, set()).update(anchor_ids)
    return {
        'sourceCalls': len(source_calls), 'graphRepresentedCalls': len(graph_calls),
        'canvasVisibleCalls': len(canvas_calls),
        'callCoverage': len(source_calls & graph_calls) / len(source_calls) if source_calls else 1,
        'missingCallCount': len(source_calls - graph_calls),
        'missingCallExamples': sorted(source_calls - graph_calls)[:20],
        'sourceRecordedEdges': len(source_edges),
        'graphRepresentedRecordedEdges': len(source_edges & represented_edges),
        'recordedEdgeCoverage': len(source_edges & represented_edges) / len(source_edges) if source_edges else 1,
        'missingRecordedEdgeCount': len(missing_edges), 'missingRecordedEdgeExamples': missing_edges[:20],
        'semanticLevelsByCall': dict(levels),
        'multiCallGroups': sum(len(call_ids) > 1 for call_ids in calls_by_node_run.values()),
        'roots': roots, 'sourceResultAnchors': {run: sorted(ids) for run, ids in anchors.items()},
        'graphResultAnchors': {run: sorted(ids) for run, ids in graph_anchors.items()},
        'graphNodeCount': len(graph.get('nodes', [])), 'graphEdgeCount': len(graph.get('edges', [])),
        'defaultCanvasProjection': {'familyNodes': len(graph.get('nodes', [])),
                                    'visibleCalls': len(canvas_calls),
                                    'edges': len(graph.get('edges', [])),
                                    'expandedOperationNodes': 0},
        'backendCompression': graph.get('compression'),
        'projection': graph.get('projection'),
    }


def _quality(graph, case, analyses):
    relevant = [analysis for analysis in analyses if analysis['traceId'] in {
        'o4_mini:1215:5.1', 'o4_mini:1212:5.1'}]
    return {analysis['traceId']: benchmark_abstraction.quality(
        graph, analysis['traceId'], analysis['calls']) for analysis in relevant}


def _projection_graph(graph):
    """Keep projection fields and prepared parameters while omitting source payloads."""
    private = {'args', 'response', 'finalOutput', 'taskDescription', 'prompt', 'quote'}
    if isinstance(graph, dict):
        return {key: _projection_graph(value) for key, value in graph.items() if key not in private}
    if isinstance(graph, list):
        return [_projection_graph(value) for value in graph]
    return graph


async def _run_case(case, entries, output_dir, live):
    started = perf_counter()
    analyses, source_cached = await app.analyze_selection(entries)
    source_seconds = round(perf_counter() - started, 6)
    view_started = perf_counter()
    graph, first_cached = await app.comparison_view(analyses, [], {}, detail='overview')
    first_view_seconds = round(perf_counter() - view_started, 6)
    repeated_started = perf_counter()
    repeated_graph, repeated_cached = await app.comparison_view(analyses, [], {}, detail='overview')
    repeated_view_seconds = round(perf_counter() - repeated_started, 6)
    requests = graph.get('modelMetrics', {}).get('requestCount', 0)
    repeated_requests = repeated_graph.get('modelMetrics', {}).get('requestCount', 0)
    report = {
        'case': case, 'traceIds': [analysis['traceId'] for analysis in analyses],
        'sourceAnalysisCached': source_cached, 'sourceSeconds': source_seconds,
        'firstViewSeconds': first_view_seconds, 'firstViewCached': first_cached,
        'modelRequests': requests, 'modelRequestSeconds': graph.get('modelMetrics', {}).get('elapsedSeconds', 0),
        'promptTokens': graph.get('modelMetrics', {}).get('promptTokens', 0),
        'repeatViewSeconds': repeated_view_seconds, 'repeatViewCached': repeated_cached,
        'repeatModelRequests': repeated_requests,
        'repeatCacheZeroCalls': repeated_requests == 0 and repeated_cached,
        'coverage': _graph_counts(graph, analyses),
        'discoveraQuality': _quality(graph, case, analyses),
    }
    write_json(output_dir / f'{case}.graph.json', _projection_graph(graph))
    return report


def _assert_case(report):
    coverage = report['coverage']
    if coverage['callCoverage'] != 1:
        raise AssertionError(f"{report['case']}: graph call coverage is {coverage['callCoverage']}")
    if coverage['recordedEdgeCoverage'] != 1:
        raise AssertionError(f"{report['case']}: recorded-edge coverage is {coverage['recordedEdgeCoverage']}")
    anchors = coverage['sourceResultAnchors']
    if any(not anchors.get(run) for run in report['traceIds']):
        raise AssertionError(f"{report['case']}: source result anchors are missing")
    if not report['repeatCacheZeroCalls']:
        raise AssertionError(f"{report['case']}: repeated cached view was not zero-call")
    for trace_id, checks in report['discoveraQuality'].items():
        failed = [name for name, value in checks.items() if value is False]
        if failed:
            raise AssertionError(f"{report['case']} {trace_id}: quality checks failed: {', '.join(failed)}")


def _write_progress(output_dir, status, mode, rounds, case_reports, selected_cases, failure=None):
    report = {'status': status, 'mode': mode, 'workflowRounds': rounds, 'cases': case_reports,
              'graphFiles': [f'{case}.graph.json' for case in selected_cases],
              'notes': ['Graph coverage counts calls and recorded event edges independently from overview render counts.',
                        'Recorded edge coverage accepts either an internalFlow edge or a consecutive pair in a recorded witness callPath.',
                        'Saved graphs omit raw arguments, output payloads, prompt text, and evidence quotes; prepared variant parameters remain for UI projection.']}
    if failure:
        report['failure'] = failure
    write_json(output_dir / 'report.json', report)
    return report


async def run(args):
    if not args.live:
        _offline_only()
    output_dir = args.output
    output_dir.mkdir(parents=True, exist_ok=True)
    discovera = _discovera_entries()
    suzuki = _suzuki_entries()
    selections = {case: [discovera[trace_id] for trace_id in ids] for case, ids in CASE_IDS.items()}
    selections.update({f'suzuki-{seed}': [entry] for seed, entry in suzuki.items()})
    selections['suzuki-42+65'] = [suzuki[42], suzuki[65]]
    case_reports = []
    selected_cases = args.case or ALL_CASES
    mode = 'live' if args.live else 'offline-cache-only'
    _write_progress(output_dir, 'running', mode, args.rounds, case_reports, selected_cases)
    for case in selected_cases:
        workflow_semantics.MAX_ROUNDS = args.rounds
        try:
            case_report = await _run_case(case, selections[case], output_dir, args.live)
            _assert_case(case_report)
        except Exception as error:
            _write_progress(output_dir, 'failed', mode, args.rounds, case_reports, selected_cases,
                            {'case': case, 'message': str(error)})
            raise
        case_reports.append(case_report)
        _write_progress(output_dir, 'running', mode, args.rounds, case_reports, selected_cases)
        print(json.dumps({'case': case,
                          'sourceCalls': case_report['coverage']['sourceCalls'],
                          'graphRepresentedCalls': case_report['coverage']['graphRepresentedCalls'],
                          'canvasVisibleCalls': case_report['coverage']['canvasVisibleCalls'],
                          'callCoverage': case_report['coverage']['callCoverage'],
                          'recordedEdgeCoverage': case_report['coverage']['recordedEdgeCoverage'],
                          'multiCallGroups': case_report['coverage']['multiCallGroups'],
                          'graphNodeCount': case_report['coverage']['graphNodeCount'],
                          'graphEdgeCount': case_report['coverage']['graphEdgeCount'],
                          'modelRequests': case_report['modelRequests'],
                          'repeatModelRequests': case_report['repeatModelRequests']}, separators=(',', ':')), flush=True)
    report = _write_progress(output_dir, 'completed', mode, args.rounds, case_reports, selected_cases)
    print(json.dumps({'report': str(output_dir / 'report.json'), 'mode': report['mode'],
                      'caseCount': len(case_reports)}, separators=(',', ':')), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--case', action='append', choices=ALL_CASES,
                        help='Case to run; repeat to select multiple. Defaults to all requested cases.')
    parser.add_argument('--output', type=Path, default=ROOT / 'experiments/results/iterate-provenance',
                        help='Output directory for the report and one graph per selected case.')
    parser.add_argument('--rounds', type=int, default=3, help='Maximum backward workflow assessment rounds.')
    parser.add_argument('--live', action='store_true', help='Allow uncached gateway requests.')
    args = parser.parse_args()
    asyncio.run(run(args))
