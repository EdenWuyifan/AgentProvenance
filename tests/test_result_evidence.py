"""Source-citation validation, batched inference and incremental reuse."""
import asyncio
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'agent_provenance_backend'))
import result_evidence as module
import semantics
from models import ModelResponseError


def trace(run='r'):
    return {'traceId': run, 'finalOutput': 'The Alpha experiment measured accuracy of ninety percent.',
            'calls': [{'id': '0', 'tool': 'unfamiliar_tool', 'timeIndex': 0,
                       'response': {'finding': 'Alpha experiment accuracy ninety percent'}}]}


def test_claim_spans_and_output_quotes_are_exact_source_substrings():
    analysis = trace()
    claims, cards, evidence, _ = module.evidence_cards(analysis)
    assert cards
    for claim in claims:
        source = claim['source']
        assert analysis['finalOutput'][source['start']:source['end']] == source['quote']
    for item in evidence.values():
        assert item['quote'] in json.dumps(analysis['calls'][0]['response'], ensure_ascii=False)


def test_batches_runs_without_scores_and_reuses_per_trace_cache(monkeypatch, tmp_path):
    monkeypatch.setattr(semantics, 'CACHE_DIR', tmp_path)
    calls = []

    async def infer(prompt, **kwargs):
        calls.append(prompt)
        payload = json.loads(prompt.rsplit('\n', 1)[1])
        return {'assessments': [{'id': c['id'], 'links': [{'evidenceIds': [c['outputs'][0]['id']],
                 'relation': 'supports', 'reason': 'Recorded accuracy matches the claim.'}]} for c in payload['claims']]}

    monkeypatch.setattr(module, 'infer_json', infer)
    result, metrics = asyncio.run(module.associate_results([trace('a'), trace('b')]))
    assert len(calls) == 1 and metrics['batchCount'] == 1
    assert result['a']['claims'][0]['links'][0]['callId'] == '0'
    result, metrics = asyncio.run(module.associate_results([trace('b'), trace('a')]))
    assert len(calls) == 1 and metrics['newTraces'] == 0
    assert {r['run'] for r in result.values()} == {'a', 'b'}
    assert 'score' not in json.loads(calls[0].rsplit('\n', 1)[1])


def test_missing_final_and_unsupported_output_do_not_call_model(monkeypatch, tmp_path):
    monkeypatch.setattr(semantics, 'CACHE_DIR', tmp_path)

    async def forbidden(prompt, **kwargs):
        pytest.fail('No candidates should not trigger a model request')

    monkeypatch.setattr(module, 'infer_json', forbidden)
    result, metrics = asyncio.run(module.associate_results([
        {**trace('a'), 'finalOutput': None}, {**trace('b'), 'calls': []}]))
    assert result['a']['status'] == 'missing-final'
    assert result['b']['status'] == 'no-candidates'
    assert metrics['batchCount'] == 0


def test_joint_evidence_keeps_distinct_call_citations_and_shared_bundle(monkeypatch, tmp_path):
    monkeypatch.setattr(semantics, 'CACHE_DIR', tmp_path)
    analysis = trace()
    analysis['calls'].append({**analysis['calls'][0], 'id': 'second', 'timeIndex': 1})

    async def infer(prompt, **kwargs):
        card = json.loads(prompt.rsplit('\n', 1)[1])['claims'][0]
        return {'assessments': [{'id': card['id'], 'links': [{
            'evidenceIds': [item['id'] for item in card['outputs']],
            'relation': 'supports', 'reason': 'These outputs jointly support the measurement.'}]}]}

    monkeypatch.setattr(module, 'infer_json', infer)
    result, _ = asyncio.run(module.associate_results([analysis]))
    links = result['r']['claims'][0]['links']
    assert {link['callId'] for link in links} == {'0', 'second'}
    assert len({link['bundleId'] for link in links}) == 1
    assert all(link['joint'] for link in links)


def test_invented_output_citation_is_rejected_and_not_cached(monkeypatch, tmp_path):
    monkeypatch.setattr(semantics, 'CACHE_DIR', tmp_path)

    async def infer(prompt, **kwargs):
        card = json.loads(prompt.rsplit('\n', 1)[1])['claims'][0]
        return {'assessments': [{'id': card['id'], 'links': [{'evidenceIds': ['invented'],
                    'relation': 'supports', 'reason': 'Not actually evidenced'}]}]}

    monkeypatch.setattr(module, 'infer_json', infer)
    with pytest.raises(ModelResponseError, match='supplied output evidence'):
        asyncio.run(module.associate_results([trace()]))
    assert not list((tmp_path / 'result-evidence').glob('*.json'))


def test_interpreted_output_anchors_use_recorded_ancestry_not_inferred_links():
    from evidence_context import result_path
    analysis = {'calls': [{'id': cid} for cid in ('input', 'evidence', 'speculation')],
                'targets': [], 'resultAnchors': ['evidence'], 'flow': [
        {'source': 'input', 'target': 'evidence', 'inferred': False},
        {'source': 'speculation', 'target': 'evidence', 'inferred': True}]}
    targets, ancestors = result_path(analysis)
    assert targets == {'evidence'} and ancestors == {'input', 'evidence'}


def test_retrieval_covers_all_fragments_beyond_the_model_assessment_budget():
    analysis = trace()
    analysis['finalOutput'] = '\n'.join(f'Alpha experiment accuracy observation number {i}.' for i in range(40))
    claims, cards, evidence, coverage = module.evidence_cards(analysis)
    assert len(claims) == coverage['consideredClaims'] == coverage['totalClaims'] == 40
    assert len(cards) == module.MAX_CLAIMS
    assert all(claim['retrieved'] for claim in claims)
    assert all(not claim['assessed'] for claim in claims)
    assert evidence


def test_chunked_retrieval_finds_single_rare_subject_and_keeps_exact_source_quote():
    analysis = trace()
    analysis['finalOutput'] = 'LEF1 is the candidate for follow-up.'
    text = 'background ' * 300 + 'LEF1 measured expression increased after intervention.'
    analysis['calls'][0]['response'] = {'text': text}
    claims, _, _, coverage = module.evidence_cards(analysis)
    matches = claims[0]['retrieved']
    assert matches and 'LEF1' in matches[0]['quote']
    source = json.dumps(analysis['calls'][0]['response'], ensure_ascii=False)
    assert matches[0]['quote'] == source[matches[0]['start']:matches[0]['start'] + len(matches[0]['quote'])]
    assert coverage['indexedChunks'] > 1


def test_scalar_receipts_are_indexed_at_json_paths_without_private_fields():
    analysis = trace()
    analysis['finalOutput'] = 'Receipt timestamp 1700000000. True.'
    analysis['calls'][0]['response'] = {
        'timestamp': 1700000000, 'accepted': True, 'receipt': 'OK',
        'api_token': 'private-value', 'url': 'https://private.example/item', 'empty': None,
    }

    units = list(module._units(analysis['calls'][0]['response']))
    assert ('/timestamp', '1700000000') in units
    assert ('/accepted', 'true') in units
    assert any('OK' in quote for _, quote in units)
    assert all('api_token' not in path and 'url' not in path for path, _ in units)
    assert all(path != '/empty' for path, _ in units)

    from retrieval import BM25Retriever
    documents = [{'callId': '0', 'path': path, 'quote': quote} for path, quote in units]
    retriever = BM25Retriever(documents, module._terms)
    assert any(item['path'] == '/timestamp' for item in retriever.search('1700000000'))
    assert any(item['path'] == '/accepted' for item in retriever.search('true'))
    claims, _, evidence, coverage = module.evidence_cards(analysis)
    assert all('private-value' not in item['quote'] for item in evidence.values())
    assert coverage['indexedChunks'] > 0


def test_tokenizer_keeps_hyphenated_and_dotted_identifiers_intact():
    assert module._terms('NFKB1/p65:IL-6; TNF-alpha, gene.info_v2!') == [
        'nfkb1', 'p65', 'il-6', 'tnf-alpha', 'gene.info_v2']
