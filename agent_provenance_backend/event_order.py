"""Ordering evidence for inferred links; recorded dependencies stay authoritative."""

from datetime import datetime
from math import isfinite


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and isfinite(value)


def _timestamp(value):
    if _number(value):
        return value
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
            return parsed.timestamp() if parsed.tzinfo else None
        except ValueError:
            return None
    return None


def strictly_earlier(source, target, round_label=''):
    """Use explicit rounds, then completion/start time, then recorded step order.

    Timestamp-bearing traces never fall back to array position when timestamps
    are missing or invalid. Overlapping activities cannot imply evidence use.
    ``sequence`` is a trace-wide ordinal; ``timeIndex`` is recorded step order
    for sequential trace formats such as an ordered tool-call transcript.
    """
    if round_label.casefold() == 'round':
        a, b = source.get('round'), target.get('round')
        return _number(a) and _number(b) and a < b
    if any(key in call for call in (source, target) for key in ('timestamp', 'startedAt', 'endedAt')):
        a = _timestamp(source.get('endedAt', source.get('timestamp')))
        b = _timestamp(target.get('startedAt', target.get('timestamp')))
        return a is not None and b is not None and a < b
    field = 'sequence' if 'sequence' in source or 'sequence' in target else 'timeIndex'
    a, b = source.get(field), target.get(field)
    return _number(a) and _number(b) and a < b
