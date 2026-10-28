"""Export frozen analyses as app-readable JSONL and seed explicit local replay caches."""

import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'agent_provenance_backend'))
from analysis_snapshots import save_snapshot


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--analyses', type=Path, action='append', required=True)
    parser.add_argument('--packet', type=Path, action='append', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--label', required=True)
    parser.add_argument('--review-version', required=True)
    args = parser.parse_args()
    analyses = {a['traceId']: a for path in args.analyses for a in json.loads(path.read_text())}
    runs = list(dict.fromkeys(run for path in args.packet
                             for run in json.loads(path.read_text())['sourceRuns']))
    rows = []
    for run in runs:
        analysis = analyses[run]
        key = save_snapshot(analysis, {'label': args.label, 'reviewVersion': args.review_version})
        rows.append({'id': run, 'task_id': analysis['taskId'], 'taskDescription': analysis['taskDescription'],
            'score': analysis['score'], 'scoreMetric': analysis['scoreMetric'],
            'trainingOutcome': analysis['trainingOutcome'], 'snapshotRef': key,
            'initialContext': analysis['initialContext'], 'finalOutput': analysis['finalOutput'],
            'referenceSchema': analysis.get('referenceSchema'),
            'toolCalls': [{'id': c['id'], 'name': c['tool'], 'args': c['args'],
                'response': c['response'], 'status': c['status']} for c in analysis['calls']]})
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in rows))
    print(json.dumps({'path': str(args.output), 'traces': len(rows),
        'calls': sum(len(row['toolCalls']) for row in rows), 'modelRequests': 0}))


if __name__ == '__main__':
    main()
