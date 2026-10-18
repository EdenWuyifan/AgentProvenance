"""Small local BM25 index. Documents retain their original source metadata."""

import math
from collections import Counter, defaultdict

VERSION = 'bm25-chunks-v1'
CHUNK_CHARS = 420
CHUNK_OVERLAP = 80


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
        if allowed is None:
            for word in terms:
                matches = self.postings.get(word, [])
                idf = math.log(1 + (len(self.documents) - len(matches) + 0.5) / (len(matches) + 0.5))
                for index, count in matches:
                    norm = count + 1.2 * (0.25 + 0.75 * self.lengths[index] / self.average_length)
                    scores[index] += idf * count * 2.2 / norm
        else:
            for index in sorted(index for call_id in allowed
                                for index in self.documents_by_call.get(call_id, ())):
                for word in terms:
                    count = self.term_counts[index].get(word, 0)
                    if not count:
                        continue
                    matches = self.postings.get(word, ())
                    idf = math.log(1 + (len(self.documents) - len(matches) + 0.5) / (len(matches) + 0.5))
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
