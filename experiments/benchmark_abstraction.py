"""Measure actual model annotation and warm projection against historical traces.

Cold cases use an isolated temporary rule cache. Source data stays local; the
production annotator sends only its compact operation-type catalogue. Reports
contain counts and call indices, never source result bodies or credentials.
"""

import argparse
import asyncio
import json
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from time import perf_counter

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'agent_provenance_backend'))

import app
import semantics
from abstraction import build_views
from agent_provenance.parser import parse_traces
from models import FRAMEWORK_VERSION, write_json

DEFAULT_IDS = ['o4_mini:1215:5.1', 'o4_mini:1212:1', 'o4_mini:1216:1']


def selection(ids):
    return [{'traceId': str(t['id']), 'toolCalls': t['tool_calls'], 'score': t.get('score'),
             'taskId': t.get('task_id', t.get('taskId')), 'scoreMetric': 'score',
             'taskDescription': t.get('task_description'), 'finalOutput': t.get('finalOutput')}
            for t in parse_traces(ROOT / 'agent_provenance_react/public/tracings.jsonl') if str(t['id']) in ids]


def summary(graph):
    return {**graph['compression'], 'model': graph['modelMetrics'],
            'processingSeconds': graph['processingSeconds'], 'annotation': graph['annotation'],
            'reasoning': graph['reasoning'],
            'recordedEdges': sum(not e['inferred'] for e in graph['edges']),
            'inferredEdges': sum(e['inferred'] for e in graph['edges']),
            'connections': [{'source': edge['source'], 'target': edge['target'],
                             'witnesses': [{key: witness[key] for key in
                                            ('run', 'sourceInstance', 'targetInstance', 'callPath', 'inferred')}
                                           for witness in edge['witnesses']]} for edge in graph['edges']],
            'groups': [{'familyId': n['id'], 'label': n['label'], 'source': n.get('source'), 'tier': n['importance']['tier'],
                        'attention': {key: n['importance'][key] for key in ('semantic', 'result', 'outcome')},
                        'runs': [{'traceId': i['run'], 'steps': [c['step'] for c in i['calls']],
                                  'tools': [c['tool'] for c in i['calls']], 'source': i.get('source'),
                                  'internalFlow': i.get('internalFlow', [])} for i in n['instances']]}
                       for n in graph['nodes']],
            'sharedPatterns': graph['alignment']['sharedPatterns']}


def _family_quality(graph):
    def methods(node):
        tools = {call['tool'] for instance in node['instances'] for call in instance['calls']}
        return {tool for tool in ('ora_pipe', 'gsea_pipe', 'enrich_rumma') if tool in tools}

    def conditions(value):
        if isinstance(value, dict):
            if isinstance(value.get('column'), str) and isinstance(value.get('value'), (int, float)):
                column, op, threshold = value['column'].lower(), value.get('op'), value['value']
                if 'l2fc' in column or 'log2fc' in column:
                    if op in {'>', '>='} and threshold >= 0:
                        yield 'up'
                    elif op in {'<', '<='} and threshold <= 0:
                        yield 'down'
            for child in value.values():
                yield from conditions(child)
        elif isinstance(value, list):
            for child in value:
                yield from conditions(child)

    def predicates(value):
        if isinstance(value, dict):
            if 'column' in value and 'op' in value:
                yield value
            for child in value.values():
                yield from predicates(child)
        elif isinstance(value, list):
            for child in value:
                yield from predicates(child)

    all_nodes = graph['nodes']
    method_separate = all(len(methods(node)) <= 1 for node in all_nodes)
    opposite_directions_separate = True
    selection_join_nonfusion = True
    failure_isolated = True
    for node in all_nodes:
        direction_set = set()
        has_validation = False
        has_selection = False
        has_join = False
        has_lookup = False
        has_population = False
        all_diagnostics = []
        variants = {(v['run'], v['instanceId']): v for v in node.get('variants', [])}
        for instance in node['instances']:
            variant = variants.get((instance['run'], instance['id']), {})
            direction_set.update(conditions(variant.get('parameters', {})))
            tools = {call['tool'].lower() for call in instance['calls']}
            has_validation |= any(any(word in tool for word in ('validat', 'verify', 'check')) for tool in tools)
            has_selection |= bool(tools & {'csv_filter', 'csv_select'})
            has_join |= any('join' in tool for tool in tools)
            params = variant.get('parameters', {})
            if tools & {'csv_filter', 'filter'}:
                for condition in predicates(params):
                    column = str(condition['column']).lower()
                    has_lookup |= condition['op'] == '==' and column in {'gene', 'gene_name', 'symbol'}
                    has_population |= any(token in column for token in ('log2fc', 'l2fc', 'pval', 'fdr', 'adjusted'))
            diagnostics = bool(variant.get('diagnostics'))
            all_diagnostics.append(diagnostics)
        opposite_directions_separate &= not {'up', 'down'} <= direction_set
        has_method = bool(methods(node))
        selection_join_nonfusion &= not (has_validation and (has_selection or has_join or has_method)
                                         or has_join and has_method
                                         or has_lookup and (has_population or has_join or has_method))
        if any(all_diagnostics) and not all(all_diagnostics):
            failure_isolated = False
    return {'analyticalMethodsSeparate': method_separate,
            'oppositeDirectionsSeparate': opposite_directions_separate,
            'selectionJoinNonfusion': selection_join_nonfusion,
            'recordedFailureIsolated': failure_isolated}


def quality(graph, trace_id, source_calls=None):
    groups = [set(c['step'] for c in i['calls']) for n in graph['nodes']
              for i in n['instances'] if trace_id is None or i['run'] == trace_id]
    failure_visible = any(bool(v.get('diagnostics')) and (trace_id is None or v['run'] == trace_id)
                          for n in graph['nodes'] for v in n.get('variants', []))
    checks = {'hasMultiCallStage': any(len(group) > 1 for group in groups),
              **_family_quality(graph), 'recordedFailureVisible': True if failure_visible else None}
    if source_calls is not None:
        expected = {call['id'] for call in source_calls if semantics.recorded_diagnostics(call)}
        visible = {call['id'] for node in graph['nodes'] for instance in node['instances']
                   if instance['run'] == trace_id for call in instance['calls']}
        checks['recordedFailuresPreserved'] = expected <= visible
    if trace_id == 'o4_mini:1215:5.1':
        families = [set(c['step'] for i in n['instances'] if i['run'] == trace_id for c in i['calls'])
                    for n in graph['nodes']]
        sources = [n for n in graph['nodes'] if n.get('source') and any(i['run'] == trace_id for i in n['instances'])]
        flow = {}
        call_steps = {}
        for node in graph['nodes']:
            for instance in node['instances']:
                if instance['run'] != trace_id:
                    continue
                call_steps.update({call['step']: call['id'] for call in instance['calls']})
                for edge in instance.get('internalFlow', []):
                    if not edge.get('inferred'):
                        flow.setdefault(edge['source'], set()).add(edge['target'])
        for edge in graph.get('edges', []):
            for witness in edge['witnesses']:
                if witness['run'] == trace_id and not witness['inferred']:
                    for left, right in zip(witness['callPath'], witness['callPath'][1:]):
                        flow.setdefault(left, set()).add(right)

        def reachable(start, target):
            queue, seen = [start], set()
            while queue:
                current = queue.pop()
                if current == target:
                    return True
                if current not in seen:
                    seen.add(current)
                    queue.extend(flow.get(current, []))
            return False

        roots = [instance['source']['callId'] for node in sources for instance in node['instances']
                 if instance['run'] == trace_id and instance.get('source')]
        checks.update({'twoDistinctInputRoots': len(roots) == 2,
                       'bothInputsReachIntersection': len(roots) == 2 and 7 in call_steps
                           and all(reachable(root, call_steps[7]) for root in roots),
                       'bothInputsReachORA': len(roots) == 2 and 8 in call_steps
                           and all(reachable(root, call_steps[8]) for root in roots),
                       'oraRefinementMerged': any({8, 9} <= g for g in groups),
                       'gseaRefinementMerged': any({13, 14} <= g for g in groups),
                       'validationSelectionJoinSeparate': not any(bool({10, 11, 12, 17} & g)
                                                                 and bool({5, 6, 7} & g) for g in families)})
    return checks


def _summary_graph(summary, trace_id, calls):
    by_step = {call['timeIndex'] + 1: call for call in calls}
    visible = {by_step[step]['id'] for group in summary.get('groups', []) for run in group.get('runs', [])
               if run['traceId'] == trace_id for step in run['steps'] if step in by_step}
    hidden = {call['id'] for call in calls} - visible
    recorded = app.call_flow(app.build_recorded_graph(calls))
    nodes = []
    for index, group in enumerate(summary.get('groups', [])):
        instances, variants = [], []
        for run_index, run in enumerate(group.get('runs', [])):
            if run['traceId'] != trace_id:
                continue
            chosen = [by_step[step] for step in run['steps'] if step in by_step]
            allowed = {call['id'] for call in chosen} | hidden
            identifier = f'recheck:{index}:{run_index}'
            instances.append({'id': identifier, 'run': trace_id,
                              'source': run.get('source', group.get('source')),
                              'internalFlow': run.get('internalFlow', [e for e in recorded
                                  if e['source'] in allowed and e['target'] in allowed]),
                              'calls': [{'id': c['id'], 'tool': c['tool'], 'step': c['timeIndex'] + 1}
                                        for c in chosen]})
            variants.append({'run': trace_id, 'instanceId': identifier,
                             'parameters': {str(c['timeIndex'] + 1): c['args'] for c in chosen},
                             'diagnostics': [d for c in chosen for d in semantics.recorded_diagnostics(c)]})
        nodes.append({'id': group.get('familyId', f'cold:{index}'), 'source': group.get('source'),
                      'instances': instances, 'variants': variants})
    return {'nodes': nodes, 'edges': summary.get('connections', [])}


def recheck_report(path):
    """Recompute semantic-family checks from a saved graph, without model calls."""
    path = Path(path)
    report = json.loads(path.read_text())
    graph_path = path.with_suffix('.graph.json')
    graph = json.loads(graph_path.read_text())
    for case in report.get('coldPerTrace', []):
        trace_id = case['traceId']
        entry = selection([trace_id])[0]
        _, calls = app.trace_inputs(entry)
        cold_graph = _summary_graph(case['cold'], trace_id, calls)
        case['qualityChecks'] = quality(cold_graph, trace_id, calls)
    report['coldBatch']['qualityChecks'] = {**_family_quality(graph),
                                           'recordedFailureVisible': quality(graph, None)['recordedFailureVisible']}
    for case in report.get('batchPerTrace', []):
        entry = selection([case['traceId']])[0]
        _, calls = app.trace_inputs(entry)
        case['qualityChecks'] = quality(graph, case['traceId'], calls)
        case['familyQualityChecks'] = _family_quality(graph)
    report['qualityRecheck'] = {'sourceGraph': graph_path.name,
                                'note': 'Cold checks use each case summary plus local source-call metadata; joint checks use the saved joint graph. No model calls were made.'}
    write_json(path, report)
    return report


async def run(args):
    ids = args.trace_id or DEFAULT_IDS
    entries = selection(ids)
    if set(ids) != {e['traceId'] for e in entries}:
        raise ValueError('Requested traces were not found.')
    before = json.loads((ROOT / 'experiments/results/abstraction-before.json').read_text())
    cases = []
    write_json(args.output, {'status': 'running', 'promptVersion': semantics.PROMPT_VERSION,
                            'coldPerTrace': cases})
    # One independent cold request per trace permits a per-trace cost comparison.
    # A final cold joint case measures batching, followed by actual cached additions.
    original_cache, original_source_cache = semantics.CACHE_DIR, app.CACHE_DIR
    for trace_id in ([] if args.batch_only else ids):
        with TemporaryDirectory(prefix='agenttrails-pattern-benchmark-') as folder:
            semantics.CACHE_DIR = Path(folder)
            app.CACHE_DIR = Path(folder) / 'sources'
            started = perf_counter()
            selected, _ = await app.analyze_selection([e for e in entries if e['traceId'] == trace_id])
            graph, _ = await app.comparison_view(selected, [], {}, detail='overview')
            cold = summary(graph)
            cold['backendWallSeconds'] = round(perf_counter() - started, 6)
            warm, _ = await app.comparison_view(selected, [], {}, detail='overview')
            cases.append({'traceId': trace_id, 'qualityChecks': quality(graph, trace_id, selected[0]['calls']),
                          'cold': cold, 'warm': summary(warm)})
            write_json(args.output, {'status': 'running', 'promptVersion': semantics.PROMPT_VERSION,
                                    'coldPerTrace': cases})
            print(json.dumps({'traceId': trace_id, 'nodes': cold['visibleNodes'],
                              'multiCallGroups': cold['multiCallGroups'],
                              'modelRequests': cold['model']['requestCount'], 'seconds': cold['backendWallSeconds']}), flush=True)
    with TemporaryDirectory(prefix='agenttrails-pattern-benchmark-') as folder:
        semantics.CACHE_DIR = Path(folder)
        app.CACHE_DIR = Path(folder) / 'sources'
        started = perf_counter()
        analyses, _ = await app.analyze_selection(entries)
        joint, _ = await app.comparison_view(analyses, [], {}, detail='overview')
        batch_seconds = round(perf_counter() - started, 6)
        write_json(args.output.with_suffix('.graph.json'), joint)
        increments = []
        for length in range(1, len(ids) + 1):
            selected = [a for a in analyses if a['traceId'] in ids[:length]]
            graph, _ = await app.comparison_view(selected, [], {}, detail='overview')
            increments.append({'traceIds': ids[:length], **summary(graph)})
        policy_file = next((Path(folder) / 'annotations').glob('*.json'))
        policy = json.loads(policy_file.read_text())
        # Benchmark policies are reviewable artifacts, never installed over an
        # application's existing rules. All benchmark caches are temporary.
        write_json(args.output.with_suffix('.policy.json'), policy)
        write_json(args.output.with_suffix('.prompts.json'), [json.loads(p.read_text())
                   for p in (Path(folder) / 'annotation-prompts').glob('*.json')])
        write_json(args.output.with_suffix('.reasoning-prompts.json'), [json.loads(p.read_text())
                   for p in (Path(folder) / 'reasoning-prompts').glob('*.json')])
        enriched = [semantics.instantiate(semantics.resolve_targets(a), policy) for a in analyses]
        per_trace = [{'traceId': a['traceId'], **build_views([a], [], {}, detail='overview')['compression'],
                      'qualityChecks': quality(joint, a['traceId'], a['calls'])}
                     for a in enriched]
    cold_incremental = []
    with TemporaryDirectory(prefix='agenttrails-pattern-benchmark-') as folder:
        semantics.CACHE_DIR = Path(folder)
        app.CACHE_DIR = Path(folder) / 'sources'
        for length in ([] if args.batch_only else range(1, len(ids) + 1)):
            started = perf_counter()
            selected, _ = await app.analyze_selection([e for e in entries if e['traceId'] in ids[:length]])
            graph, _ = await app.comparison_view(selected, [], {}, detail='overview')
            cold_incremental.append({'traceIds': ids[:length], **summary(graph),
                                     'backendWallSeconds': round(perf_counter() - started, 6)})
    semantics.CACHE_DIR = original_cache
    app.CACHE_DIR = original_source_cache
    report = {'status': 'completed', 'framework': FRAMEWORK_VERSION, 'promptVersion': semantics.PROMPT_VERSION,
              'models': {'semantic': semantics.SEMANTIC_MODEL}, 'before': before,
              'coldPerTrace': cases, 'coldBatch': {**summary(joint), 'backendWallSeconds': batch_seconds},
              'batchPerTrace': per_trace,
              'coldIncremental': cold_incremental, 'warmIncremental': increments,
              'limitations': ['Historical times sum model request durations; old end-to-end wall time was not recorded.',
                              'Scores are observational; no causal outcome credit is estimated.',
                              'Mechanical graph only: no unrecorded semantic dependency is invented.']}
    write_json(args.output, report)
    if args.preview:
        write_json(args.preview, {'traces': entries, 'analyses': analyses, 'graph': joint})
    print(json.dumps({'report': str(args.output), 'coldBatch': joint['compression'],
                      'requests': joint['modelMetrics']['requestCount'],
                      'warmIncrementalRequests': [x['model']['requestCount'] for x in increments]}), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--trace-id', action='append')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--preview', type=Path)
    parser.add_argument('--batch-only', action='store_true', help='Measure one cold batch and warm projections only.')
    parser.add_argument('--recheck', action='store_true',
                        help='Recompute saved benchmark quality checks from the report and .graph.json, without model calls.')
    args = parser.parse_args()
    try:
        if args.recheck:
            report = recheck_report(args.output)
            print(json.dumps({'report': str(args.output), 'qualityRecheck': report['qualityRecheck']}), flush=True)
            raise SystemExit(0)
        asyncio.run(run(args))
    except Exception as error:
        report = json.loads(args.output.read_text()) if args.output.exists() else {}
        write_json(args.output, {**report, 'status': 'failed', 'error': str(error),
                                'failedRequestMetrics': getattr(error, 'request_metrics', [])})
        raise
