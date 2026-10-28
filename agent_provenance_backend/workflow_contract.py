"""Typed output contract for bounded workflow evidence review."""


def _object(**properties):
    return {'type': 'object', 'additionalProperties': False,
            'required': list(properties), 'properties': properties}


def _array(items):
    return {'type': 'array', 'items': items}


def _enum(*values):
    return {'type': 'string', 'enum': list(values)}


_text = {'type': 'string'}
_evidence = _array(_text)
SCHEMA = _object(
    defaultLevel=_enum('unknown'),
    backtrace=_object(decision=_enum('continue', 'stop'), reason=_text),
    assessments=_array(_object(event=_text, level=_enum('key', 'supporting', 'unknown'),
                              label=_text, reason=_text, evidence={**_evidence, 'maxItems': 4})),
    keyParents=_array(_text),
    searchQueries=_array(_object(target=_text, query=_text)),
    linkAssessments=_array(_object(link=_text, relevance=_enum('relevant', 'context', 'unknown'),
                                  reason=_text, evidence=_evidence)),
    jointGroups=_array(_object(target=_text, sources=_array(_text), label=_text, reason=_text, evidence=_evidence)),
    semanticContexts=_array(_object(source=_text, target=_text, relevance=_enum('relevant', 'context'),
                                   reason=_text, evidence=_evidence)),
)
