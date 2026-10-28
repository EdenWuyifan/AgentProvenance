"""Small local BM25 index. Documents retain their original source metadata."""

import math
import re
from collections import Counter, defaultdict

VERSION = 'bm25-chunks-v1'
CHUNK_CHARS = 420
CHUNK_OVERLAP = 80


def activity_document(tool, excerpts, limit=2400):
    """Pack current reasoning and observed output before nested historical context.

    This text only selects candidates. Exact fields and source citations remain
    in the evidence store and are fetched independently for model review.
    """
    def priority(item):
        direct = item['path'].count('/') <= 1
        reason = re.search(r'/(?:rationale|reason|intent|query|question|goal|insight)$', item['path'], re.I)
        if item['field'] == 'args' and direct and reason:
            return 0
        if item['field'] == 'response':
            return 1
        return 2 if direct else 3

    parts, seen = [str(tool)], set()
    for item in sorted(excerpts, key=priority):
        if item['quote'] in seen:
            continue
        seen.add(item['quote'])
        part = f"{item['field']}{item['path']}: {item['quote']}"
        if len('\n'.join([*parts, part])) <= limit:
            parts.append(part)
    return '\n'.join(parts)


class BM25Retriever:
    def __init__(self, documents, tokenize):
        self.documents = list(documents)
        self.tokenize = tokenize
        self.postings = defaultdict(list)
        self.term_counts = []
        self.documents_by_call = defaultdict(list)
        self.lengths = []
        for index, document in enumerate(self.documents):
            counts = Counter(tokenize(document['quote']))
            self.term_counts.append(counts)
            self.lengths.append(sum(counts.values()))
            self.documents_by_call[document['callId']].append(index)
            for word, count in counts.items():
                self.postings[word].append((index, count))
        self.average_length = sum(self.lengths) / len(self.lengths) if self.lengths else 0

    def search(self, query, limit=5, allowed_call_ids=None):
        allowed = None if allowed_call_ids is None else set(allowed_call_ids)
        scores = defaultdict(float)
        terms = set(self.tokenize(query))
        for word in terms:
            matches = self.postings.get(word, [])
            idf = math.log(1 + (len(self.documents) - len(matches) + 0.5) / (len(matches) + 0.5))
            for index, count in matches:
                if allowed is not None and self.documents[index]['callId'] not in allowed:
                    continue
                norm = count + 1.2 * (0.25 + 0.75 * self.lengths[index] / self.average_length)
                scores[index] += idf * count * 2.2 / norm
        selected, counts = [], Counter()
        for index in sorted(scores, key=lambda i: (-scores[i], i)):
            document = self.documents[index]
            if counts[document['callId']] >= 2:
                continue
            selected.append({**document, 'retrievalScore': round(scores[index], 6)})
            counts[document['callId']] += 1
            if len(selected) == limit:
                break
        return selected
