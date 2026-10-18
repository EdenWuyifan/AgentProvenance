"""One measured, bounded gateway request for a batch of pattern annotations."""

import asyncio
import json
import os
import re
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from time import perf_counter

from portkey_ai import AsyncPortkey
from models import CACHE_DIR, ModelResponseError, digest, write_json


def _load_env():
    path = Path(__file__).resolve().parents[1] / 'agent_provenance_react' / '.env'
    if path.exists():
        for line in path.read_text().splitlines():
            if line.strip() and not line.lstrip().startswith('#') and '=' in line:
                key, value = line.split('=', 1)
                os.environ.setdefault(key.strip(), value.strip().strip('\"\''))


_load_env()
SEMANTIC_MODEL = os.getenv('PORTKEY_SEMANTIC_MODEL', '@vertexai/gemini-3.8-flash')
STRUCTURAL_MODEL = os.getenv('PORTKEY_STRUCTURAL_MODEL', '@vertexai/gemini-3.1-flash-lite')
ANNOTATION_SETTINGS = {'reasoning_effort': 'low', 'max_tokens': 8192}
_metrics = ContextVar('model_requests', default=None)


async def together(*work):
    """Finish or cancel every owned request before leaving its metrics scope."""
    tasks = [asyncio.create_task(item) for item in work]
    try:
        return await asyncio.gather(*tasks)
    except BaseException:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise


@contextmanager
def capture_metrics():
    records = []
    token = _metrics.set(records)
    try:
        yield records
    except Exception as error:
        error.request_metrics = records
        raise
    finally:
        _metrics.reset(token)


def portkey_client():
    key = os.getenv('PORTKEY_API_KEY')
    if not key:
        raise RuntimeError('Missing PORTKEY_API_KEY.')
    client = AsyncPortkey(api_key=key,
                       base_url=os.getenv('PORTKEY_BASE_URL', 'https://ai-gateway.apps.cloud.rt.nyu.edu/v1/').rstrip('/'),
                       provider=os.getenv('PORTKEY_PROVIDER'), request_timeout=90_000,
                       strict_open_ai_compliance=False)
    # This SDK hardcodes one transport retry in its constructor.
    client.max_retries = 0
    client.openai_client.max_retries = 0
    return client, SEMANTIC_MODEL


async def infer_json(prompt, tier='semantic', schema=None):
    if tier not in {'semantic', 'structural'}:
        raise ValueError('Unknown model tier.')
    client, _ = portkey_client()
    model = SEMANTIC_MODEL if tier == 'semantic' else STRUCTURAL_MODEL
    started, response, succeeded = perf_counter(), None, False
    try:
        response = await client.chat.completions.create(
            model=model, temperature=0, **ANNOTATION_SETTINGS,
            messages=[{'role': 'user', 'content': prompt}], response_format=(
                {'type': 'json_schema', 'json_schema': {'name': 'result_evidence', 'strict': True, 'schema': schema}}
                if schema is not None else {'type': 'json_object'}))
        if not response.choices:
            raise ModelResponseError('Gateway returned no completion choices.')
        if str(response.choices[0].finish_reason).lower() in {'length', 'max_tokens'}:
            raise ModelResponseError('Pattern annotation exhausted its output token budget.')
        content = response.choices[0].message.content
        if isinstance(content, list):
            content = ''.join(item.get('text', '') for item in content if isinstance(item, dict))
        try:
            result = json.loads(re.sub(r'^\s*```(?:json)?\s*|\s*```\s*$', '', content, flags=re.I))
        except json.JSONDecodeError:
            write_json(CACHE_DIR / 'invalid-responses' / f'{digest(content)}.json',
                       {'model': model, 'content': content})
            raise
        if not isinstance(result, dict):
            raise ModelResponseError('Expected a JSON object.')
        succeeded = True
        return result
    except (json.JSONDecodeError, AttributeError, IndexError, TypeError) as error:
        raise ModelResponseError('Gateway returned an invalid JSON response.') from error
    finally:
        records = _metrics.get()
        if records is not None:
            usage = response.usage if response is not None else None
            details = getattr(usage, 'completion_tokens_details', None)
            records.append({'model': model, 'tier': tier, 'elapsedSeconds': round(perf_counter() - started, 3),
                            'promptTokens': usage.prompt_tokens if usage else None,
                            'completionTokens': usage.completion_tokens if usage else None,
                            'reasoningTokens': getattr(details, 'reasoning_tokens', None),
                            'finishReason': response.choices[0].finish_reason if response is not None and response.choices else None,
                            'settings': ANNOTATION_SETTINGS,
                            'succeeded': succeeded})
        await client.close()
