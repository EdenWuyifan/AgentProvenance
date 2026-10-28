import asyncio

import pytest

import analysis_snapshots
import app
import semantics


@pytest.fixture
def snapshots(monkeypatch, tmp_path):
    monkeypatch.setattr(app, 'CACHE_DIR', tmp_path)
    monkeypatch.setattr(analysis_snapshots, 'CACHE_DIR', tmp_path)

    def make(run):
        entry = {'traceId': run, 'taskId': 'generic', 'score': 1,
            'taskDescription': 'Combine both inputs.', 'initialContext': [{'id': 'context', 'role': 'user', 'content': 'Keep both inputs.'}],
            'toolCalls': [
                {'id': 'left', 'tool': 'produce_left', 'response': {'id': 'left-data'}},
                {'id': 'right', 'tool': 'produce_right', 'response': {'id': 'right-data'}},
                {'id': 'combine', 'tool': 'combine', 'args': {'left': 'left-data', 'right': 'right-data'}, 'response': {'value': 'done'}}]}
        analysis, _ = asyncio.run(app.analyze_trace(entry))
        catalogue, _ = semantics.operation_types(analysis)
        policy = {'version': 'frozen-test-policy', 'stages': {}, 'rules': {key: {
            'action': 'group', 'stage': value['tool'], 'label': value['tool'], 'attention': 'key'}
            for key, value in catalogue.items()}}
        analysis = semantics.instantiate(semantics.resolve_targets(analysis), policy)
        analysis['evidenceReview'] = {'events': {}, 'links': [], 'reviewedActivities': 3, 'suppliedActivities': 3}
        analysis['resultEvidence'] = {'run': run, 'claims': [], 'status': 'missing-final'}
        key = analysis_snapshots.save_snapshot(analysis, {'label': 'Frozen experiment', 'reviewVersion': 'historical'})
        return {'traceId': run, 'snapshotRef': key}, analysis
    return make


def test_snapshot_replay_preserves_full_sources_and_joins_without_inference(snapshots, monkeypatch):
    entries, original = zip(*(snapshots(run) for run in ('one', 'two')))

    async def forbidden(*args, **kwargs):
        raise AssertionError('A frozen replay must never request inference.')

    monkeypatch.setattr(app, 'review_traces', forbidden)
    monkeypatch.setattr(app, 'annotate_types', forbidden)
    analyses, cached = asyncio.run(app.analyze_selection(entries))
    assert cached and analyses[0]['initialContext'] == original[0]['initialContext']
    graph, cached = asyncio.run(app.comparison_view(analyses, analyses, {}, detail='all'))
    assert cached and graph['modelMetrics']['requestCount'] == 0
    assert graph['modelMetrics']['embeddingRequestCount'] == 0
    assert graph['compression']['sourceCalls'] == graph['compression']['visibleCalls'] == 6
    assert len(graph['nodes']) == 3 and len(graph['edges']) == 2
    assert all(edge['supportCount'] == 2 for edge in graph['edges'])
    assert {m['reviewVersion'] for m in graph['importedSnapshots']} == {'historical'}


def test_snapshot_rejects_missing_and_wrong_run(snapshots):
    entry, _ = snapshots('one')
    with pytest.raises(ValueError, match='requested trace'):
        asyncio.run(app.analyze_trace({**entry, 'traceId': 'other'}))
    with pytest.raises(ValueError, match='missing'):
        asyncio.run(app.analyze_trace({**entry, 'snapshotRef': '0' * 64}))
    with pytest.raises(ValueError, match='SHA-256'):
        asyncio.run(app.analyze_trace({**entry, 'snapshotRef': '../secret'}))


def test_snapshot_validates_targets_and_does_not_mix_live_inference(snapshots):
    entry, _ = snapshots('one')
    analysis, _ = asyncio.run(app.analyze_trace({**entry, 'targetCallIds': ['missing']}))
    with pytest.raises(ValueError, match='Target call IDs'):
        asyncio.run(app.comparison_view([analysis], [], {}))
    frozen, _ = asyncio.run(app.analyze_trace(entry))
    with pytest.raises(ValueError, match='separately'):
        asyncio.run(app.comparison_view([frozen, {'traceId': 'live'}], [], {}))
