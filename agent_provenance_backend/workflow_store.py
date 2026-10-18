"""Persistent local workflow corpora, with small manifests and lazy run loading."""

from hashlib import sha256
import json
from pathlib import Path
import re
import tempfile

from models import ROOT
from provenance import normalize_calls
from workflows import VERSION, normalize_workflow

WORKFLOW_DIR = ROOT / 'state_dir' / 'workflow-corpora'


def save_corpus(traces, label='Workflow corpus'):
    WORKFLOW_DIR.mkdir(parents=True, exist_ok=True)
    summaries, fingerprint = [], sha256(VERSION.encode())
    with tempfile.TemporaryDirectory(prefix='import-', dir=WORKFLOW_DIR) as temporary:
        staging = Path(temporary)
        for trace in traces:
            run = str(trace['id'])
            trace_key = sha256(run.encode()).hexdigest()
            if any(item['id'] == run for item in summaries):
                raise ValueError('Corpus run IDs must be unique.')
            payload = json.dumps(trace, ensure_ascii=False, separators=(',', ':'))
            fingerprint.update(payload.encode())
            (staging / f'{trace_key}.json').write_text(payload)
            calls = normalize_calls(trace.get('events', trace.get('toolCalls', [])), run)
            workflow = normalize_workflow(trace, calls)
            first_by_tool = {}
            for call in calls:
                first_by_tool.setdefault(call['tool'], {'id': call['id'], 'name': call['tool']})
            scalar = {key: value for key, value in trace.items() if value is None or isinstance(value, (str, int, float, bool))}
            summaries.append({**scalar, 'id': run, 'toolCalls': list(first_by_tool.values()),
                'eventCount': len(calls), 'participantCount': len(workflow['participants']), 'isSummary': True,
                'participants': workflow['participants'],
                'workflowSummary': {key: workflow[key] for key in ('patternFeatures', 'featureWindowEnd', 'scoreWindowEnd', 'roundCount')},
                'workflowRef': {'traceKey': trace_key}})
        if not summaries:
            raise ValueError('No workflow runs were imported.')
        corpus_id = fingerprint.hexdigest()
        for summary in summaries:
            summary['workflowRef']['corpusId'] = corpus_id
        manifest = {'kind': 'workflow-corpus', 'version': VERSION, 'corpusId': corpus_id,
                    'label': label, 'traces': summaries}
        target = WORKFLOW_DIR / corpus_id
        if not target.exists():
            (staging / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, separators=(',', ':')))
            staging.rename(target)
        return manifest


def _identity(value):
    if not isinstance(value, str) or not re.fullmatch('[0-9a-f]{64}', value):
        raise ValueError('Invalid local workflow reference.')
    return value


def load_manifest(corpus_id):
    return json.loads((WORKFLOW_DIR / _identity(corpus_id) / 'manifest.json').read_text())


def resolve_entry(entry):
    reference = entry.get('workflowRef')
    if not reference:
        return entry
    path = WORKFLOW_DIR / _identity(reference.get('corpusId')) / f"{_identity(reference.get('traceKey'))}.json"
    trace = json.loads(path.read_text())
    if str(trace['id']) != str(entry['traceId']):
        raise ValueError('Workflow reference does not match the requested run.')
    return {**trace, **entry, 'events': trace['events'], 'participants': trace['participants'],
            'eventLinks': trace['eventLinks'], 'outcomes': trace['outcomes'], 'importMetadata': trace.get('importMetadata', {})}


def list_corpora():
    return [{'corpusId': data['corpusId'], 'label': data['label'], 'runCount': len(data['traces']),
             'version': data['version'], 'currentVersion': data['version'] == VERSION}
            for path in sorted(WORKFLOW_DIR.glob('*/manifest.json'), key=lambda p: p.stat().st_mtime, reverse=True)
            for data in [json.loads(path.read_text())]]
