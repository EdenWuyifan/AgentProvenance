"""Explicit local replay of previously built analyses, without relabeling inference caches."""

import re

from models import CACHE_DIR, digest, read_cache, write_json


def save_snapshot(analysis, metadata):
    record = {**analysis, 'importedSnapshot': {
        **metadata, 'sourceAnalysisKey': analysis['analysisKey'],
        'sourceFramework': analysis['frameworkVersion'], 'templateVersion': analysis['templateVersion']}}
    key = digest(['analysis-snapshot-v1', record])
    write_json(CACHE_DIR / 'analyses' / f'{key}.json', {**record, 'analysisKey': key})
    return key


def load_snapshot(entry):
    key = entry['snapshotRef']
    if not isinstance(key, str) or not re.fullmatch(r'[0-9a-f]{64}', key):
        raise ValueError('snapshotRef must be a SHA-256 digest.')
    record = read_cache(CACHE_DIR / 'analyses' / f'{key}.json')
    if record is None:
        raise ValueError('Imported analysis snapshot is missing. Reimport its JSONL and cache together.')
    if record.get('analysisKey') != key or not record.get('importedSnapshot') \
            or record['traceId'] != str(entry['traceId']):
        raise ValueError('Snapshot reference does not match the requested trace.')
    return record
