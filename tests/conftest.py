"""Network-free application fixtures; review tests exercise real preparation and validation."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'agent_provenance_backend'))


@pytest.fixture(autouse=True)
def local_review(monkeypatch):
    import app

    async def unreviewed(analyses, focus=''):
        return {'version': 'unit-test-unreviewed', 'cached': True,
                'runs': [{'traceId': a['traceId'], 'events': {}, 'links': [], 'jointGroups': [],
                          'resultEvidence': {'run': a['traceId'], 'claims': [], 'status': 'missing-final'},
                          'reviewedActivities': 0, 'suppliedActivities': 0, 'totalActivities': len(a['calls'])}
                         for a in analyses]}

    monkeypatch.setattr(app, 'review_traces', unreviewed)
