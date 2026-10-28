from agent_provenance_backend.retrieval import BM25Retriever


def test_allowed_calls_filter_candidates_before_top_k_without_changing_chunk_cap():
    documents = [
        {'callId': 'future', 'round': 7, 'path': '/response/0', 'quote': 'alpha alpha alpha alpha alpha'},
        {'callId': 'early', 'round': 2, 'path': '/response/0', 'quote': 'alpha'},
        {'callId': 'early', 'round': 2, 'path': '/response/1', 'quote': 'alpha'},
        {'callId': 'early', 'round': 2, 'path': '/response/2', 'quote': 'alpha'},
        {'callId': 'other', 'round': 6, 'path': '/response', 'quote': 'alpha alpha alpha'},
    ]
    retriever = BM25Retriever(documents, lambda text: text.split())

    decision_round = 4
    allowed_call_ids = {doc['callId'] for doc in documents if doc['round'] < decision_round}
    result = retriever.search('alpha', limit=3, allowed_call_ids=allowed_call_ids)
    full_result = retriever.search('alpha', limit=len(documents))

    assert [item['callId'] for item in result] == ['early', 'early']
    assert {item['path'] for item in result} == {'/response/0', '/response/1'}
    assert result == [item for item in full_result if item['callId'] in allowed_call_ids]
    assert retriever.search('alpha', limit=3, allowed_call_ids=set()) == []


def test_allowed_search_scores_only_the_selected_call_documents():
    documents = [{'callId': f'run:{i // 2}', 'quote': f'alpha result {i}'} for i in range(4000)]
    retriever = BM25Retriever(documents, lambda text: text.split())

    assert retriever.search('alpha', limit=5, allowed_call_ids={'run:1500'})


def test_scoped_postings_search_matches_unscoped_scores_and_ties():
    import random
    random.seed(17)
    words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon']
    documents = [{'callId': str(i // 3), 'quote': ' '.join(random.choices(words, k=random.randrange(1, 30)))}
                 for i in range(180)]
    retriever = BM25Retriever(documents, str.split)
    for query in ('alpha beta', 'gamma epsilon delta', 'absent', ''):
        for allowed in (set(), {'0', '3', '19'}, {str(i) for i in range(50)}):
            expected = [d for d in retriever.search(query, limit=180) if d['callId'] in allowed][:7]
            assert retriever.search(query, limit=7, allowed_call_ids=allowed) == expected
