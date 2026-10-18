import tempfile
import unittest
from pathlib import Path
import sys
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'agent_provenance_backend'))
from agent_provenance_backend import graph_focus


def catalog():
    return {
        'nodes': [
            {'id': 'n0', 'label': 'Read file', 'tools': ['read'], 'intent': 'inspect config', 'subjects': ['config'], 'role': 'key', 'result': 'success', 'failed': False, 'support': 1},
            {'id': 'n1', 'label': 'Write file', 'tools': ['write'], 'intent': 'update config', 'subjects': ['config'], 'role': 'supporting', 'result': 'success', 'failed': False, 'support': 1},
        ],
        'edges': [{'id': 'e0', 'source': 'n0', 'target': 'n1', 'kind': 'recorded', 'resultPath': True, 'support': 1}],
    }


class GraphFocusTests(unittest.IsolatedAsyncioTestCase):
    async def test_one_batched_call_and_cache_hit_has_zero_model_metrics(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(graph_focus, 'CACHE_DIR', Path(directory)):
            response = {'nodes': [{'id': 'n0', 'reason': 'Reads the requested configuration.'}],
                        'edges': [{'id': 'e0', 'reason': 'Recorded transition to the update.'}], 'summary': 'The read-to-write flow matches.'}
            mocked = AsyncMock(return_value=response)
            with patch.object(graph_focus, 'infer_json', mocked):
                first = await graph_focus.focus_graph('Which step reads config?', catalog())
                second = await graph_focus.focus_graph('Which step reads config?', catalog())
            self.assertEqual(mocked.await_count, 1)
            self.assertFalse(first['cached'])
            self.assertTrue(second['cached'])
            self.assertEqual(second['modelMetrics'], [])
            self.assertEqual(first['nodeMatches'], response['nodes'])
            self.assertEqual(first['edgeMatches'], response['edges'])

    async def test_rejects_invented_ids_and_invalid_catalog(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(graph_focus, 'CACHE_DIR', Path(directory)):
            with patch.object(graph_focus, 'infer_json', AsyncMock(return_value={
                'nodes': [{'id': 'trace-raw-id', 'reason': 'invented'}], 'edges': [], 'summary': ''
            })):
                with self.assertRaisesRegex(ValueError, 'invalid or duplicate ID'):
                    await graph_focus.focus_graph('find config', catalog())
            bad = catalog()
            bad['edges'][0]['target'] = 'missing'
            with self.assertRaisesRegex(ValueError, 'endpoint'):
                await graph_focus.focus_graph('find config', bad)

    async def test_accepts_no_matches(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(graph_focus, 'CACHE_DIR', Path(directory)):
            with patch.object(graph_focus, 'infer_json', AsyncMock(return_value={'nodes': [], 'edges': [], 'summary': 'No matching steps.'})):
                result = await graph_focus.focus_graph('find a database call', catalog())
            self.assertEqual(result['nodeMatches'], [])
            self.assertEqual(result['edgeMatches'], [])


if __name__ == '__main__':
    unittest.main()
