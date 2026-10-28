"""Occurrence-preserving retrieval over recorded same-round transport."""

from collections import defaultdict

from retrieval import BM25Retriever, activity_document
from evidence_context import is_transport

class EvidenceUnits:
    """Group only unambiguous, timed, acyclic recorded transport occurrences."""

    def __init__(self, prepared):
        self.prepared = prepared
        calls = prepared['callById']
        parents = defaultdict(set)
        for link in prepared['links']:
            if (is_transport(link) and not link['inferred']
                    and link['source'] in calls and link['target'] in calls):
                parents[link['target']].add(link['source'])

        cyclic = self._cyclic_calls(parents)
        self.owner = {}
        for call_id in calls:
            root = call_id
            seen = set()
            while root not in cyclic and len(parents[root]) == 1:
                parent = next(iter(parents[root]))
                if parent in cyclic or parent in seen:
                    break
                if calls[parent].get('round') is None or calls[parent].get('round') != calls[root].get('round'):
                    break
                seen.add(root)
                root = parent
            self.owner[call_id] = root

        groups = defaultdict(list)
        for call_id in calls:
            groups[self.owner[call_id]].append(call_id)
        self.units = []
        for root, members in groups.items():
            own = [prepared['evidence'][ref] for ref in prepared['byCall'][root]]
            transported = [prepared['evidence'][ref] for cid in members if cid != root
                           for ref in prepared['byCall'][cid]]
            quote = activity_document(calls[root]['tool'], own, limit=1200)
            if transported:
                quote += '\n' + activity_document('', transported, limit=2399 - len(quote))
            self.units.append({'callId': root, 'members': members, 'round': calls[root].get('round'),
                               'actor': calls[root].get('agentId'), 'quote': quote})
        self.by_id = {unit['callId']: unit for unit in self.units}
        self.retriever = BM25Retriever(self.units, prepared['retriever'].tokenize)
        self.occurrences = prepared['retriever']

    @staticmethod
    def _cyclic_calls(parents):
        """Return all vertices in directed cycles, including ambiguous cycles."""
        children = defaultdict(set)
        for target, sources in parents.items():
            for source in sources:
                children[source].add(target)
        cyclic = set()
        state, path, positions = {}, [], {}

        def visit(call_id):
            state[call_id] = 1
            positions[call_id] = len(path)
            path.append(call_id)
            for child in children[call_id]:
                if state.get(child) == 1:
                    cyclic.update(path[positions[child]:])
                elif state.get(child, 0) == 0:
                    visit(child)
            path.pop()
            positions.pop(call_id)
            state[call_id] = 2

        for call_id in set(parents) | set(children):
            if state.get(call_id, 0) == 0:
                visit(call_id)
        return cyclic

    def search(self, query, allowed_call_ids, limit=5):
        allowed = set(allowed_call_ids)
        if not allowed or limit <= 0:
            return []
        complete = {unit['callId'] for unit in self.units if set(unit['members']) <= allowed}
        partial = {cid for cid in allowed if self.owner[cid] not in complete}
        # A partial unit must never expose text belonging to an excluded recipient.
        rankings = [self.retriever.search(query, limit, complete),
                    self.occurrences.search(query, limit, partial)]
        scores, hits = defaultdict(float), {}
        for ranking in rankings:
            for rank, hit in enumerate(ranking, 1):
                cid = hit['callId']
                scores[cid] += 1 / (60 + rank)
                hits[cid] = hit
        return [{**hits[cid], 'retrievalScore': scores[cid]} for cid in
                sorted(scores, key=lambda cid: (-scores[cid], cid))[:limit]]
