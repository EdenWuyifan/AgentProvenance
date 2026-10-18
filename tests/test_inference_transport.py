import asyncio
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent_provenance_backend"))
import inference
from models import ModelResponseError


@pytest.fixture(autouse=True)
def isolated_diagnostics(monkeypatch, tmp_path):
    monkeypatch.setattr(inference, 'CACHE_DIR', tmp_path)


class FakeClient:
    def __init__(self, response):
        self.response = response
        self.closed = False
        self.request = None
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))

    async def create(self, **kwargs):
        self.request = kwargs
        return self.response

    async def close(self):
        self.closed = True


def response(content, finish_reason="stop"):
    return SimpleNamespace(
        choices=[SimpleNamespace(finish_reason=finish_reason,
                                 message=SimpleNamespace(content=content))],
        usage=SimpleNamespace(prompt_tokens=10, completion_tokens=12,
                              completion_tokens_details=SimpleNamespace(reasoning_tokens=3)),
    )


@pytest.mark.parametrize("finish_reason", ["length", "MAX_TOKENS"])
def test_truncated_response_fails_with_metrics_and_closes_client(monkeypatch, finish_reason):
    client = FakeClient(response('{"partial":', finish_reason))
    monkeypatch.setattr(inference, "portkey_client", lambda: (client, "model"))

    try:
        with inference.capture_metrics() as metrics:
            asyncio.run(inference.infer_json("compact prompt"))
    except ModelResponseError as error:
        caught = error
    else:
        pytest.fail("truncated response should fail")

    assert client.closed
    assert caught.request_metrics == metrics
    assert metrics[0]["finishReason"] == finish_reason
    assert metrics[0]["succeeded"] is False
    assert metrics[0]["settings"] == {"reasoning_effort": "low", "max_tokens": 8192}
    assert client.request["reasoning_effort"] == "low"
    assert client.request["max_tokens"] == 8192
    assert client.request["temperature"] == 0


def test_invalid_json_records_request_settings_and_closes_client(monkeypatch):
    client = FakeClient(response("not json"))
    monkeypatch.setattr(inference, "portkey_client", lambda: (client, "model"))

    try:
        with inference.capture_metrics() as metrics:
            asyncio.run(inference.infer_json("compact prompt", tier="structural"))
    except ModelResponseError as error:
        caught = error
    else:
        pytest.fail("invalid JSON should fail")

    assert client.closed
    assert caught.request_metrics == metrics
    assert metrics[0]["tier"] == "structural"
    assert metrics[0]["succeeded"] is False
    assert metrics[0]["finishReason"] == "stop"
    assert client.request["reasoning_effort"] == "low"
    assert client.request["max_tokens"] == 8192
    assert client.request["temperature"] == 0
    assert client.request["response_format"] == {"type": "json_object"}


def test_evidence_schema_is_sent_as_structured_output(monkeypatch):
    client = FakeClient(response('{"assessments": []}'))
    monkeypatch.setattr(inference, 'portkey_client', lambda: (client, 'model'))
    schema = {'type': 'object', 'properties': {'assessments': {'type': 'array'}}}
    assert asyncio.run(inference.infer_json('Return JSON', schema=schema)) == {'assessments': []}
    assert client.request['response_format']['type'] == 'json_schema'
    assert client.request['response_format']['json_schema']['schema'] == schema


def test_failed_batch_cancels_and_joins_its_other_owned_requests():
    finished = []

    async def pending():
        try:
            await asyncio.Event().wait()
        finally:
            finished.append('closed')

    async def fail():
        await asyncio.sleep(0)
        raise ModelResponseError('invalid source citation')

    with pytest.raises(ModelResponseError, match='invalid source citation'):
        asyncio.run(inference.together(pending(), fail()))
    assert finished == ['closed']
