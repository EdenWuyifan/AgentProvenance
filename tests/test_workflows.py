import asyncio
import json
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'agent_provenance_backend'))
import app
import workflow_store
from workflows import build_workflow_view


def trace(run='one', agents=5):
    events = []
    for round_ in range(3):
        for agent in range(agents):
            for phase in ('choose', 'evaluate'):
                events.append({'id': f'{round_}:{agent}:{phase}', 'name': phase, 'eventType': phase,
                               'agentId': f'a{agent}', 'role': 'planner' if agent % 2 else 'executor',
                               'round': round_, 'phase': phase, 'args': {'numeric_id': 1},
                               'response': {'id': 1, 'value': 10 + round_}})
    events += [
        {'id': 'broadcast', 'name': 'share', 'eventType': 'information_publication', 'agentId': 'a0', 'round': 0},
        {'id': 'delivery', 'name': 'receive', 'eventType': 'information_reception', 'agentId': 'a1', 'round': 0},
    ]
    links = [
        {'source': '0:0:evaluate', 'target': 'broadcast', 'relation': 'summary'},
        {'source': 'broadcast', 'target': 'delivery', 'relation': 'delivered_to'},
        {'source': 'delivery', 'target': '1:1:choose', 'relation': 'used_shared_evidence', 'evidenceLevel': 'contextual'},
        {'source': '1:1:choose', 'target': '1:1:evaluate', 'relation': 'evaluation'},
    ]
    return {'traceId': run, 'id': run, 'eventSchemaVersion': 'workflow-events-v1', 'events': events,
            'eventLinks': links, 'participants': [{'id': f'a{i}', 'label': f'Worker {i}'} for i in range(agents)],
            'outcomes': [{'id': 'result', 'eventId': '1:1:evaluate', 'metric': 'quality', 'value': 11,
                          'name': 'Goal', 'round': 1}], 'score': 11, 'taskId': 'generic',
            'importMetadata': {'featureWindowEnd': 0, 'scoreWindowEnd': 2}}


def joint_context_trace(run='joint', topic='shared-topic', third_sender='D'):
    """Three independent messages arrive before B combines them in one decision."""
    events, links = [], []
    participants = [{'id': f'agent-{name}', 'label': f'Agent {name}', 'role': 'chemist'}
                    for name in ('A', 'B', 'C', 'D', 'E')]

    def add(event_id, name, event_type, agent, round_, args=None, response=None):
        events.append({'id': f'{run}:joint:{event_id}', 'name': name, 'eventType': event_type,
                       'agentId': f'agent-{agent}', 'role': 'chemist', 'round': round_, 'phase': event_type,
                       'args': args or {}, 'response': response, 'status': 'completed',
                       'source': {'file': 'multiagent_fixture.json', 'jsonPointer': f'/{event_id}'}})
        return f'{run}:joint:{event_id}'

    for sender, round_ in (('A', 0), ('C', 2), (third_sender, 2)):
        source = add(f'{sender}-experiment', 'Run local experiment', 'experiment', sender, round_,
                     {'selected_conditions': {'substrate': topic}, 'operation': 'couple'}, {'yield': 80})
        publication = add(f'{sender}-publication', 'Publish findings', 'information_publication', sender, round_,
                          {'sourceExperimentId': source, 'sourcePayload': {'topic': topic},
                           'communicatedPayload': {'topic': topic}}, {'insight': f'{sender} finding about {topic}'})
        reception = add(f'{sender}-reception', 'Receive findings', 'information_reception', 'B', round_,
                        {'sender': f'agent-{sender}', 'sourceExperimentId': source,
                         'sourcePublicationId': publication, 'sourcePayload': {'topic': topic},
                         'payload': {'topic': topic}, 'insight': f'{sender} finding about {topic}'})
        links += [{'source': source, 'target': publication, 'relation': 'publishes', 'evidenceLevel': 'direct'},
                  {'source': publication, 'target': reception, 'relation': 'delivered_to', 'evidenceLevel': 'direct'}]

    irrelevant = add('B-irrelevant', 'Unrelated local exploration', 'experiment', 'B', 1,
                     {'selected_conditions': {'substrate': 'unrelated'}, 'operation': 'screen'}, {'yield': 5})
    target = add('B-result', 'Combine shared findings', 'experiment', 'B', 3,
                 {'selected_conditions': {'substrate': topic}, 'operation': 'couple',
                  'promptEvidence': {'peerMessages': [
                      {'receptionId': f'{run}:joint:{sender}-reception', 'sender': f'agent-{sender}', 'sourceRound': round_, 'topic': topic}
                      for sender, round_ in (('A', 0), ('C', 2), (third_sender, 2))]}}, {'yield': 99})
    for sender in ('A', 'C', third_sender):
        links.append({'source': f'{run}:joint:{sender}-reception', 'target': target,
                      'relation': 'used_shared_evidence', 'evidenceLevel': 'contextual_unique',
                      'evidence': ['matched prompt names the source reception and topic']})
    return {'traceId': run, 'id': run, 'eventSchemaVersion': 'workflow-events-v1', 'events': events,
            'eventLinks': links, 'participants': participants,
            'outcomes': [{'id': f'{run}:final', 'name': 'Final quality', 'metric': 'quality', 'value': 99,
                          'eventId': target, 'round': 3, 'observedThroughRound': 3, 'scope': 'system',
                          'kind': 'final', 'terminal': True}],
            'score': 99, 'scoreMetric': 'quality', 'taskId': 'joint-test',
            'importMetadata': {'featureWindowEnd': 1, 'scoreWindowEnd': 3}}


@pytest.fixture
def local_cache(monkeypatch, tmp_path):
    monkeypatch.setattr(app, 'CACHE_DIR', tmp_path / 'analyses')
    monkeypatch.setattr(workflow_store, 'WORKFLOW_DIR', tmp_path / 'corpora')

    async def review_without_network(analyses, focus=''):
        return _review_runs(analyses, {})

    monkeypatch.setattr(app, 'review_traces', review_without_network)


def analyze(entry):
    return asyncio.run(app.analyze_trace(entry))[0]


def test_generic_lanes_explicit_evidence_and_no_numeric_resource_guessing(local_cache):
    analysis = analyze(trace())
    assert len(analysis['flow']) == 4
    graph, _ = asyncio.run(app.comparison_view([analysis], [], {}, detail='overview'))
    assert len(graph['workflow']['lanes']) == 5
    assert graph['modelMetrics']['requestCount'] == 0
    assert not analysis.get('finalOutput')
    assert graph['compression']['sourceCalls'] == len(graph['nodes']) == 32
    source = next(n for n in graph['nodes'] if n['executionContext']['roundStart'] == 0
                  and any(c['id'] == 'broadcast' for i in n['instances'] for c in i['calls']))
    # Review changes highlighting, never whether a recorded connection exists.
    assert len(graph['edges']) == len(analysis['workflow']['eventLinks'])
    assert not any(w['highlighted'] for edge in graph['edges'] for w in edge['witnesses'])
    assert source['assessment']['level'] == 'supporting'


def test_standard_comparison_reviews_and_preserves_the_supplied_key_call(local_cache, monkeypatch):
    analysis = {'traceId': 'plain-comparison', 'analysisKey': 'plain-comparison-source', 'calls': [
        {'id': 'setup', 'tool': 'prepare', 'args': {}, 'response': 'ready'},
        {'id': 'review-key', 'tool': 'evaluate', 'args': {'method': 'compare'}, 'response': 'best result'},
    ], 'flow': [{'source': 'setup', 'target': 'review-key', 'inferred': False}],
        'targetCallIds': ['review-key']}
    review_inputs, displayed = [], []

    async def annotate(_analyses, focus=''):
        return {}, {'newTypes': 0}

    async def review(analyses, focus=''):
        review_inputs.extend(analyses)
        return {'version': 'test-review', 'cached': False, 'runs': [{
            'traceId': 'plain-comparison',
            'events': {'review-key': {'level': 'key', 'status': 'assessed'}},
            'links': [], 'jointGroups': [],
            'resultEvidence': {'run': 'plain-comparison', 'status': 'available', 'claims': [{
                'id': 'c0', 'links': [{'callId': 'review-key', 'relation': 'supports'}]}]},
            'reviewedActivities': 1, 'suppliedActivities': 2, 'totalActivities': 2}]}

    def build(selected, *_args, **_kwargs):
        displayed.extend(selected)
        return {'nodes': [], 'edges': []}

    monkeypatch.setattr(app, 'annotate_types', annotate)
    monkeypatch.setattr(app, 'instantiate', lambda source, _policy: source)
    monkeypatch.setattr(app, 'review_traces', review)
    monkeypatch.setattr(app, 'build_views', build)

    graph, _ = asyncio.run(app.comparison_view([analysis], [], {}, detail='overview'))

    assert review_inputs[0]['targetCallIds'] == ['review-key']
    assert displayed[0]['resultAnchors'] == ['review-key']
    assert displayed[0]['evidenceReview']['events']['review-key']['level'] == 'key'
    assert graph['semanticReview']['runs'][0] == {'run': 'plain-comparison', 'reviewed': 1,
                                                   'supplied': 2, 'total': 2, 'dependencySearch': None}


def test_support_counts_runs_and_role_grouping_is_generic(local_cache):
    analyses = [analyze(trace(run)) for run in ('one', 'two')]
    graph = build_workflow_view(analyses, detail='all', lane_by='role')
    assert {lane['label'] for lane in graph['workflow']['lanes']} == {'planner', 'executor'}
    event_by_id = {call['id']: call for analysis in analyses for call in analysis['calls']}
    assert all(node['supportCount'] == 2 for node in graph['nodes'])
    for node in graph['nodes']:
        calls = [event_by_id[call['id']] for instance in node['instances'] for call in instance['calls']]
        assert len({call['eventType'] for call in calls}) == 1
        assert len({call['round'] for call in calls}) == 1


def test_context_siblings_fold_without_losing_activities_or_connections(local_cache):
    entry = joint_context_trace()
    # Three independent receipts have the same downstream decision, type and actor.
    for event in entry['events']:
        if event['eventType'] == 'information_reception':
            event['round'] = 2
    analysis = analyze(entry)
    graph = build_workflow_view([analysis])
    receipts = [node for node in graph['nodes'] if node['semanticRole'] == 'information_reception']
    assert len(receipts) == 1
    receipt = receipts[0]
    assert len(receipt['instances']) == len(receipt['operationGroups']) == 3
    assert receipt['supportCount'] == 1  # Three messages are not three independent traces.
    assert graph['compression']['sourceCalls'] == graph['compression']['visibleCalls'] == len(entry['events'])
    represented = {(w['run'], *w['callPath']) for edge in graph['edges'] for w in edge['witnesses']}
    assert represented == {(analysis['traceId'], edge['source'], edge['target']) for edge in entry['eventLinks']}
    assert all(edge['source'] != edge['target'] for edge in graph['edges'])
    assert graph['projection']['contextFolds'] == 2


def test_workflow_failure_uses_actual_tool_output_without_status_flag(local_cache):
    entry = trace()
    entry['events'][0]['response'] = {'error': 'The requested resource was unavailable.'}
    graph = build_workflow_view([analyze(entry)])
    failed = _node_for_call(graph, entry['events'][0]['id'])
    assert failed['importance']['tier'] == 'failure'
    assert failed['operationGroups'][0]['failure'] is True


def _node_for_call(graph, call_id):
    return next(node for node in graph['nodes']
                if any(call['id'] == call_id for instance in node['instances'] for call in instance['calls']))


def _review_runs(analyses, key_ids_by_run, joint_sources=()):
    runs = []
    for analysis in analyses:
        trace_id = analysis['traceId']
        calls = analysis['calls']
        event_assessments = {call['id']: {
            'status': 'assessed',
            'level': 'key' if call['id'] in key_ids_by_run.get(trace_id, set()) else 'supporting',
            'label': call.get('name') or call.get('tool') or call['eventType'],
            'reason': 'Recorded task context fixture.', 'evidence': []}
            for call in calls}
        groups = []
        if trace_id in joint_sources:
            source_ids, target_id = joint_sources[trace_id]
            groups.append({'id': f'{trace_id}:joint-0', 'label': 'Combine supplied findings',
                           'reason': 'The activity used multiple recorded shared inputs together.',
                           'sourceCallIds': source_ids, 'targetCallIds': [target_id],
                           'linkRelations': ['used_shared_evidence'], 'evidence': []})
        runs.append({'traceId': trace_id, 'events': event_assessments, 'links': [], 'jointGroups': groups,
                     'resultEvidence': {'run': trace_id, 'status': 'missing-final', 'claims': []},
                     'reviewedActivities': len(event_assessments),
                     'suppliedActivities': len(event_assessments), 'totalActivities': len(event_assessments)})
    return {'version': 'fast-review-test-v1', 'cached': True, 'runs': runs}


def test_joint_context_importance_marks_only_recorded_result_paths(local_cache):
    analysis = analyze(joint_context_trace())
    events = {call['id']: call for call in analysis['calls']}
    target_id = 'joint:joint:B-result'
    key_ids = {target_id}
    joint_sources = [f'joint:joint:{sender}-reception' for sender in ('A', 'C', 'D')]
    for sender in ('A', 'C', 'D'):
        key_ids.update((f'joint:joint:{sender}-experiment', f'joint:joint:{sender}-publication',
                        f'joint:joint:{sender}-reception'))
    assessment = _review_runs([analysis], {'joint': key_ids}, {'joint': (joint_sources, target_id)})
    analysis['workflowAssessment'] = assessment
    graph = build_workflow_view([analysis], detail='all', workflow_assessments=assessment)
    target = _node_for_call(graph, target_id)
    assert target['assessment']['status'] == 'assessed'
    assert target['assessment']['level'] == 'key'

    # The three histories that the target actually cites, and their corresponding
    # receive/publication activities, share its joint evidence path.
    for sender in ('A', 'C', 'D'):
        source_id = f'joint:joint:{sender}-experiment'
        publication_id = f'joint:joint:{sender}-publication'
        reception_id = f'joint:joint:{sender}-reception'
        assert _node_for_call(graph, source_id)['assessment']['level'] == 'key'
        assert _node_for_call(graph, publication_id)['assessment']['level'] == 'key'
        assert _node_for_call(graph, reception_id)['assessment']['level'] == 'key'
        assert any(link['source'] == reception_id and link['target'] == target_id
                   and link['relation'] == 'used_shared_evidence' for link in analysis['workflow']['eventLinks'])
    irrelevant_id = 'joint:joint:B-irrelevant'
    irrelevant = _node_for_call(graph, irrelevant_id)
    assert irrelevant['assessment']['level'] != 'key'
    assert irrelevant['assessment']['level'] in {'supporting', 'unknown'}
    assert events[irrelevant_id]['round'] == 1 and events[target_id]['round'] == 3

    # Neither activity cards nor their aligned occurrences may mix event type
    # or round, and the 3-parent context must survive the view projection.
    for node in graph['nodes']:
        calls = [events[call['id']] for instance in node['instances'] for call in instance['calls']]
        assert len({call['eventType'] for call in calls}) == 1
        assert len({call['round'] for call in calls}) == 1
    incoming = [edge for edge in graph['edges'] if edge['target'] == target['id']
                and edge['relation'] == 'used_shared_evidence']
    assert len(incoming) >= 3
    joint_ids = set(target['assessment']['jointGroupIds'])
    assert joint_ids
    assert all(joint_ids.intersection(_node_for_call(graph, source)['assessment']['jointGroupIds'])
               for source in joint_sources)


def test_reviewed_uncertainty_is_distinct_from_an_unreviewed_occurrence(local_cache):
    analysis = analyze(joint_context_trace())
    assessment = _review_runs([analysis], {})
    first, second = analysis['calls'][:2]
    assessment['runs'][0]['events'][first['id']]['level'] = 'unknown'
    assessment['runs'][0]['events'][second['id']].update(level='unknown', status='not_assessed')
    graph = build_workflow_view([analysis], workflow_assessments=assessment)
    reviewed = _node_for_call(graph, first['id'])['assessment']
    unreviewed = _node_for_call(graph, second['id'])['assessment']
    assert reviewed['level'] == unreviewed['level'] == 'unknown'
    assert reviewed['assessedSupportCount'] == 1
    assert unreviewed['assessedSupportCount'] == 0


def test_overview_preserves_relevant_flow_between_supporting_activities(local_cache):
    analysis = analyze(joint_context_trace())
    assessments = _review_runs([analysis], {'joint': {'joint:joint:B-result'}})
    assessments['runs'][0]['links'] = [
        {'sourceCallId': edge['source'], 'targetCallId': edge['target'], 'relation': edge['relation'],
         'relevance': 'relevant', 'reason': 'Recorded input in the reviewed result flow.'}
        for edge in analysis['workflow']['eventLinks']]
    graph = build_workflow_view([analysis], detail='overview', workflow_assessments=assessments)
    source = _node_for_call(graph, 'joint:joint:A-publication')
    reception = _node_for_call(graph, 'joint:joint:A-reception')
    assert source['assessment']['level'] == reception['assessment']['level'] == 'supporting'
    assert any(edge['source'] == source['id'] and edge['target'] == reception['id'] for edge in graph['edges'])


def test_delivery_to_key_reception_is_visible_without_promoting_publication(local_cache):
    analysis = analyze(joint_context_trace())
    assessments = _review_runs([analysis], {'joint': {'joint:joint:A-reception'}})
    graph = build_workflow_view([analysis], workflow_assessments=assessments)
    source = _node_for_call(graph, 'joint:joint:A-publication')
    reception = _node_for_call(graph, 'joint:joint:A-reception')
    edge = next(edge for edge in graph['edges'] if edge['source'] == source['id'] and edge['target'] == reception['id'])
    assert edge['witnesses'][0]['highlighted'] is True
    assert source['assessment']['level'] == 'supporting'


def test_cross_run_alignment_requires_same_sender_and_semantic_parameters(local_cache):
    traces = [joint_context_trace('run-one'), joint_context_trace('run-two'),
              joint_context_trace('run-sender-change', third_sender='E'),
              joint_context_trace('run-parameter-change', topic='different-topic')]
    analyses = [analyze(entry) for entry in traces]
    assessment = _review_runs(analyses, {})
    for analysis in analyses:
        analysis['workflowAssessment'] = assessment
    graph = build_workflow_view(analyses, detail='all', workflow_assessments=assessment)
    aligned_a_publication = _node_for_call(graph, 'run-one:joint:A-publication')
    assert set(aligned_a_publication['supportTraces']) == {'run-one', 'run-two', 'run-sender-change'}

    d_publication = _node_for_call(graph, 'run-one:joint:D-publication')
    assert set(d_publication['supportTraces']) == {'run-one', 'run-two'}
    e_publication = _node_for_call(graph, 'run-sender-change:joint:E-publication')
    assert 'run-one' not in e_publication['supportTraces']

    changed_a_publication = _node_for_call(graph, 'run-parameter-change:joint:A-publication')
    assert changed_a_publication['id'] != aligned_a_publication['id']
    assert 'run-one' not in changed_a_publication['supportTraces']


def test_semantic_workflow_assessment_uses_mocked_occurrence_and_joint_context_calls(local_cache, monkeypatch, tmp_path):
    import workflow_semantics

    analysis = analyze(joint_context_trace())
    monkeypatch.setattr(workflow_semantics, 'CACHE_DIR', tmp_path / 'semantic-cache')
    requests = []

    async def mocked_model(prompt, **_kwargs):
        payload = json.loads(prompt.rsplit('\n', 1)[-1])
        requests.append(payload)
        assessments = []
        for event in payload['events']:
            is_target = event['type'] == 'experiment' and event['actor'] == 'agent-B' and event['round'] == 3
            assessments.append({'event': event['ref'], 'level': 'key' if is_target else 'supporting',
                                'label': 'Combine shared findings' if is_target else 'Recorded activity',
                                'reason': 'Uses recorded peer observations in one experiment.' if is_target else 'Provides task context.',
                                'evidence': [next((ref for ref in event['evidence']
                                                  if payload['evidence'][ref]['field'] == 'response'), event['evidence'][0])]
                                if is_target and event['evidence'] else []})
        levels_by_link = [link for link in payload['links'] if link['relation'] == 'used_shared_evidence']
        groups = []
        if len(levels_by_link) >= 2:
            target = levels_by_link[0]['target']
            source_refs = [link['source'] for link in levels_by_link if link['target'] == target]
            refs = {ref for event in payload['events'] if event['ref'] in [*source_refs, target]
                    for ref in event['evidence'][:1]}
            groups.append({'target': target, 'sources': source_refs,
                           'label': 'Joint peer context', 'reason': 'Multiple peer observations inform one experiment.',
                           'evidence': list(refs)})
        cards = {event['ref']: event for event in payload['events']}
        links = [{'link': link['ref'], 'relevance': 'relevant', 'reason': 'The consumer combines these recorded observations.',
                  'evidence': cards[link['source']]['evidence'][:1] + cards[link['target']]['evidence'][:1]}
                 for link in levels_by_link]
        return {'defaultLevel': 'unknown', 'backtrace': {'decision': 'stop', 'reason': 'The supplied result is adequately reviewed.'},
                'assessments': assessments, 'keyParents': [], 'searchQueries': [], 'linkAssessments': links,
                'jointGroups': groups, 'semanticContexts': []}

    monkeypatch.setattr(workflow_semantics, 'infer_json', mocked_model)
    assessment = asyncio.run(workflow_semantics.assess_workflow([analysis]))
    result = assessment['runs'][0]
    target_id = 'joint:joint:B-result'
    assert 1 <= len(requests) <= workflow_semantics.MAX_ROUNDS
    assert result['events'][target_id]['level'] == 'key'
    assert len(result['jointGroups']) == 1
    assert set(result['jointGroups'][0]['sourceCallIds']) == {
        'joint:joint:A-reception', 'joint:joint:C-reception', 'joint:joint:D-reception'}
    assert result['jointGroups'][0]['targetCallIds'] == [target_id]


def test_duplicate_dangling_future_and_cyclic_events_are_rejected(local_cache):
    entry = trace()
    entry['events'].append(dict(entry['events'][0]))
    with pytest.raises(ValueError, match='unique'):
        analyze(entry)
    entry = trace()
    entry['eventLinks'][0]['source'] = 'missing'
    with pytest.raises(ValueError, match='existing'):
        analyze(entry)
    entry = trace()
    entry['eventLinks'].append({'source': '2:0:choose', 'target': '0:0:choose', 'relation': 'wrong'})
    with pytest.raises(ValueError, match='earlier'):
        analyze(entry)
    entry = trace()
    entry['eventLinks'].append({'source': 'broadcast', 'target': '0:0:evaluate', 'relation': 'cycle'})
    with pytest.raises(ValueError, match='acyclic'):
        analyze(entry)


def test_structured_outcome_changes_invalidate_analysis_cache(local_cache):
    entry = trace()
    first = analyze(entry)
    entry['outcomes'][0]['value'] = 12
    second = analyze(entry)
    assert first['analysisKey'] != second['analysisKey']


def test_manifest_is_small_and_lazy_loading_preserves_source_events(local_cache):
    entry = trace()
    manifest = workflow_store.save_corpus([entry])
    summary = manifest['traces'][0]
    assert summary['eventCount'] == len(entry['events'])
    assert 'events' not in summary and 'eventLinks' not in summary
    loaded = workflow_store.resolve_entry({'traceId': 'one', 'workflowRef': summary['workflowRef']})
    assert loaded['events'] == entry['events']
    assert analyze({'traceId': 'one', 'workflowRef': summary['workflowRef']})['workflow']['outcomes'] == entry['outcomes']
    assert not list(workflow_store.WORKFLOW_DIR.glob('import-*'))
    with pytest.raises(ValueError, match='Invalid'):
        workflow_store.resolve_entry({'traceId': 'one', 'workflowRef': {'corpusId': '../bad', 'traceKey': 'bad'}})


def test_result_prefix_keeps_fixed_window_features_and_exposes_import_boundary(local_cache):
    from agent_provenance.workflow_window import prune_after_result
    entry = joint_context_trace()
    entry['importMetadata'] = {'featureWindowEnd': 2, 'scoreWindowEnd': 3}
    for event in entry['events']:
        event['patterns'] = [event['eventType']]
    full = analyze(entry)
    # Keep a prefix before the final event to exercise source-window feature preservation.
    anchor = next(event['id'] for event in entry['events'] if event['round'] == 0)
    cropped = prune_after_result(entry, anchor)
    analysis = analyze(cropped)
    assert analysis['workflow']['patternFeatures'] == full['workflow']['patternFeatures']
    assert analysis['workflow']['roundCount'] == 1
    graph = build_workflow_view([analysis])
    assert graph['workflow']['roundRange'] == [0, 0]
    assert graph['resultWindows'][0]['anchorEventId'] == anchor
    assert graph['resultWindows'][0]['retainedThroughRound'] == 0
    assert graph['resultWindows'][0]['removedEventCount'] > 0


def test_corpus_menu_identifies_earlier_imports_without_removing_them(local_cache):
    previous = workflow_store.save_corpus([trace()], 'Same batch')
    previous_path = workflow_store.WORKFLOW_DIR / previous['corpusId'] / 'manifest.json'
    previous['version'] = 'earlier-event-schema'
    previous_path.write_text(json.dumps(previous))
    current_trace = trace()
    current_trace['score'] = 12
    current = workflow_store.save_corpus([current_trace], 'Same batch')

    corpora = workflow_store.list_corpora()
    assert [item['corpusId'] for item in corpora] == [current['corpusId'], previous['corpusId']]
    assert [item['currentVersion'] for item in corpora] == [True, False]
    assert corpora[1]['version'] == 'earlier-event-schema'
    assert workflow_store.load_manifest(previous['corpusId']) == previous


def test_http_upload_and_lazy_graph_are_model_free(local_cache):
    from fastapi.testclient import TestClient
    client = TestClient(app.app)
    imported = client.post('/api/import-workflows', json={'records': [trace()]})
    assert imported.status_code == 200
    summary = imported.json()['traces'][0]
    response = client.post('/api/prov-graph', json={'traceId': summary['id'], 'workflowRef': summary['workflowRef']})
    assert response.status_code == 200
    assert len(response.json()['tracing']['toolCalls']) == len(trace()['events'])
    joined = client.post('/api/joined-provenance-graph', json={'graphs': [{'traceId': summary['id'], 'workflowRef': summary['workflowRef']}]})
    assert joined.status_code == 200
    assert joined.json()['joinedGraph']['modelMetrics']['requestCount'] == 0


def test_role_path_validation_uses_the_displayed_lane_mode(local_cache, monkeypatch):
    from fastapi.testclient import TestClient
    client = TestClient(app.app)
    entry = trace()
    async def assess_recorded_path(analyses, focus=''):
        base = _review_runs(analyses, {})
        analysis = analyses[0]
        first = analysis['workflow']['eventLinks'][0]
        base['runs'][0]['events'][first['target']]['level'] = 'key'
        base['runs'][0]['links'] = [{'sourceCallId': first['source'], 'targetCallId': first['target'],
                                     'relation': first['relation'], 'relevance': 'relevant',
                                     'reason': 'Fixture explicitly selects this recorded path.', 'evidence': []}]
        return base
    monkeypatch.setattr(app, 'review_traces', assess_recorded_path)
    graph = client.post('/api/joined-provenance-graph', json={'graphs': [entry], 'laneBy': 'role'}).json()['joinedGraph']
    edge = graph['edges'][0]
    response = client.post('/api/validate-path', json={'graphs': [entry], 'laneBy': 'role', 'traceId': 'one',
                                                      'familyPath': [edge['source'], edge['target']]})
    assert response.status_code == 200
    assert response.json()['valid'] is True


def test_native_role_tool_calls_retain_parent_evidence_and_text_results(local_cache, monkeypatch):
    entry = {'traceId': 'roles', 'toolCalls': [
        {'id': 'research', 'name': 'lookup', 'agentId': 0, 'role': 'researcher', 'response': 'Observed result'},
        {'id': 'write', 'name': 'summarize', 'agentId': 1, 'role': 'writer', 'parentCallIds': ['research'], 'response': 'Result confirmed'},
    ], 'finalOutput': 'Result confirmed'}
    async def evidence(analyses, focus=''):
        return {'version': 'test-review', 'cached': True, 'runs': [{
            'traceId': 'roles', 'events': {}, 'links': [], 'jointGroups': [],
            'resultEvidence': {'run': 'roles', 'status': 'available', 'claims': [{
                'id': 'c0', 'text': 'Result confirmed', 'links': [{'callId': 'write',
                    'relation': 'supports', 'reason': 'Output quote', 'evidence': []}]}]},
            'reviewedActivities': 0, 'suppliedActivities': 2, 'totalActivities': 2}]}
    monkeypatch.setattr(app, 'review_traces', evidence)
    analysis = analyze(entry)
    assert analysis['calls'][0]['agentId'] == '0'
    assert analysis['workflow']['roundLabel'] == 'Step'
    graph, _ = asyncio.run(app.comparison_view([analysis], [], {}, detail='all', lane_by='role'))
    assert graph['resultEvidence'][0]['claims'][0]['text'] == 'Result confirmed'
    assert any(node['importance']['result']['status'] == 'supported' for node in graph['nodes'])
    assert len(graph['edges']) == 1
