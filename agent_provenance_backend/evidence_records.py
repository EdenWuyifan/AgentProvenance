"""Local, privacy-aware excerpts that keep recorded values in their containers."""

import json
import re


MAX_RECORD_CHARS = 2400
_EMAIL = re.compile(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}")
_URL = re.compile(r"https?://[^\s\"'<>]+", re.I)


def _pointer(path, part):
    return path + "/" + str(part).replace("~", "~0").replace("/", "~1")


def _secret_key(key):
    compact = re.sub(r"[^a-z0-9]", "", str(key).casefold())
    return any(term in compact for term in (
        "password", "passwd", "passphrase", "token", "secret", "authorization",
        "apikey", "credential", "privatekey", "accesstoken", "refreshtoken",
    )) or compact in {"auth", "authtoken"}


def _secret_kind(key):
    compact = re.sub(r"[^a-z0-9]", "", str(key).casefold())
    for kind, terms in (
        ("password", ("password", "passwd", "passphrase")),
        ("token", ("token", "secret")),
        ("credential", ("credential", "privatekey")),
        ("auth", ("authorization", "apikey", "auth")),
    ):
        if any(term in compact for term in terms):
            return kind
    return "credential"


class EvidenceAliases:
    """Redact secrets and assign local aliases for rendered evidence."""

    def __init__(self):
        self._aliases = {}
        self._secret_aliases = {}

    def _safe(self, value):
        if isinstance(value, dict):
            return {key: self._secret_handle(child, _secret_kind(key)) if _secret_key(key)
                    else self._safe(child)
                    for key, child in value.items()}
        if isinstance(value, list):
            return [self._safe(child) for child in value]
        if isinstance(value, str):
            value = _URL.sub(lambda m: self._alias(m.group(), "url"), value)
            return _EMAIL.sub(lambda m: self._alias(m.group(), "email"), value)
        return value

    def _secret_handle(self, value, kind):
        serialized = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        key = (kind, serialized)
        if key not in self._secret_aliases:
            ordinal = sum(1 for existing_kind, _ in self._secret_aliases if existing_kind == kind) + 1
            self._secret_aliases[key] = f"<secret_{kind}_{ordinal}>"
        return self._secret_aliases[key]

    def _alias(self, value, kind):
        key = (kind, value.casefold() if kind == "email" else value)
        if key not in self._aliases:
            self._aliases[key] = f"<{kind}_{len(self._aliases) + 1}>"
        return self._aliases[key]


class RecordEvidence(EvidenceAliases):
    """Index exact arguments, output records, and source-provided context locally."""

    def __init__(self, analysis):
        super().__init__()
        self.analysis = analysis
        self._identity_key = re.compile(r"email|recipient|sender|name|path|file|resource|uri|url|id", re.I)
        self._copy_index = {}
        self._secret_copy_index = {}
        self.private_sources = set()
        for source in analysis.get('calls', []):
            has_private, has_content = False, False
            for path, key, value in self._scalar_locations(source.get('response'), ''):
                if _secret_key(key):
                    has_private = True
                    if isinstance(value, (str, dict, list)):
                        kind = _secret_kind(key)
                        secret_value = json.dumps(value, ensure_ascii=False, sort_keys=True,
                                                  separators=(",", ":"))
                        self._secret_copy_index.setdefault((kind, secret_value), []).append(
                            (source.get('id'), path))
                    continue
                if (not self._identity_key.search(key) and
                        value not in ('success', 'ok', source.get('tool'))):
                    has_content = True
                is_text_identity = isinstance(value, str) and value.strip() and (
                    self._identity_key.search(key) or _EMAIL.fullmatch(value) or _URL.fullmatch(value))
                is_numeric_identity = (isinstance(value, (int, float)) and not isinstance(value, bool)
                                       and self._identity_key.search(key))
                if is_text_identity or is_numeric_identity:
                    self._copy_index.setdefault((type(value), value), []).append(
                        (source.get('id'), path, key))
            if has_private and not has_content:
                self.private_sources.add(source.get('id'))

    def _scalar_locations(self, value, path):
        if isinstance(value, dict):
            for key, child in value.items():
                child_path = _pointer(path, key)
                if _secret_key(key):
                    # A sensitive slot is one opaque value. Never descend into it: a
                    # nested name, identifier, or email must not enter public matching.
                    yield child_path, key, child
                else:
                    yield from self._scalar_locations(child, child_path)
        elif isinstance(value, list):
            for index, child in enumerate(value):
                yield from self._scalar_locations(child, _pointer(path, index))
        elif isinstance(value, (str, int, float)) and not isinstance(value, bool):
            key = path.rsplit('/', 1)[-1] if '/' in path else ''
            yield path, key, value

    def _record(self, path, value, collection_path=None, collection_length=None):
        safe = self._safe(value)
        quote = safe if isinstance(safe, str) else json.dumps(safe, ensure_ascii=False, separators=(",", ":"))
        base = {'path': path, 'quote': quote, 'complete': True}
        if collection_path is not None:
            base.update(collectionPath=collection_path, collectionLength=collection_length)
        if len(quote) <= MAX_RECORD_CHARS:
            return [base]
        chunks = []
        for start in range(0, len(quote), MAX_RECORD_CHARS):
            end = min(start + MAX_RECORD_CHARS, len(quote))
            item = {**base, 'quote': quote[start:end], 'complete': False,
                    'start': start, 'end': end}
            chunks.append(item)
        return chunks

    def _records(self, value, path, collection_path=None, collection_length=None):
        if isinstance(value, list):
            if not value:
                return self._record(path, value, path, 0)
            result = []
            for index, item in enumerate(value):
                item_path = _pointer(path, index)
                if isinstance(item, dict):
                    result.extend(self._record(item_path, item, path, len(value)))
                else:
                    result.extend(self._records(item, item_path, path, len(value)))
            return result
        if isinstance(value, dict):
            safe = value
            # Preserve a whole scalar record (for example sender and content) as one unit.
            if all(not isinstance(child, (dict, list)) for child in safe.values()):
                return self._record(path, safe, collection_path, collection_length)
            if (not any(isinstance(child, list) for child in safe.values())
                    and len(json.dumps(self._safe(safe), ensure_ascii=False)) <= MAX_RECORD_CHARS):
                return self._record(path, safe, collection_path, collection_length)
            result = []
            for key, child in safe.items():
                if _secret_key(key):
                    result.extend(self._record(_pointer(path, key), {key: child},
                                               collection_path, collection_length))
                    continue
                result.extend(self._records(child, _pointer(path, key), collection_path, collection_length))
            return result
        if isinstance(value, str) and not value:
            return []
        return self._record(path, value, collection_path, collection_length)

    def arguments(self, call):
        """Return each recorded argument at its exact argument path."""
        arguments = call.get('args') or {}
        result = []
        if isinstance(arguments, dict):
            for key, value in arguments.items():
                record_value = {key: value} if _secret_key(key) else value
                result.extend(self._record(_pointer('', key), record_value))
        elif arguments:
            result.extend(self._record('', arguments))
        return result

    def outputs(self, call):
        """Return coherent records from the recorded response value."""
        return self._records(call.get('response'), '')

    def context(self):
        """Return source-provided context with its recorded fields intact."""
        result = []
        for index, item in enumerate(self.analysis.get('initialContext', [])):
            result.extend(self._record(f'/{index}', item))
        return result

    def copies(self, target_call, allowed_source_ids):
        """Return exact identity-like scalar copies as candidate evidence only."""
        candidates = []
        allowed = set(allowed_source_ids)
        for target_path, target_key, target_value in self._scalar_locations(target_call.get('args'), ''):
            if _secret_key(target_key):
                if not isinstance(target_value, (str, dict, list)):
                    continue
                kind = _secret_kind(target_key)
                secret_value = json.dumps(target_value, ensure_ascii=False, sort_keys=True,
                                          separators=(",", ":"))
                matches = self._secret_copy_index.get((kind, secret_value), ())
                for source_id, source_path in matches:
                    if source_id not in allowed:
                        continue
                    candidates.append({'sourceCallId': source_id, 'sourcePath': source_path,
                                       'targetPath': target_path,
                                       'quote': self._secret_handle(target_value, kind),
                                       'sensitivity': 'secret'})
                continue
            matches = self._copy_index.get((type(target_value), target_value), ())
            for source_id, source_path, source_key in matches:
                if source_id not in allowed:
                    continue
                if isinstance(target_value, (int, float)) and not isinstance(target_value, bool):
                    if not (self._identity_key.search(source_key) and self._identity_key.search(target_key)):
                        continue
                if not (self._identity_key.search(source_key) or self._identity_key.search(target_key)
                        or (isinstance(target_value, str) and
                            (_EMAIL.fullmatch(target_value) or _URL.fullmatch(target_value)))):
                    continue
                quote = self._safe(target_value)
                if not isinstance(quote, str):
                    quote = json.dumps(quote, ensure_ascii=False)
                candidates.append({'sourceCallId': source_id, 'sourcePath': source_path,
                                   'targetPath': target_path, 'quote': quote})
        return candidates


def containing_record(records, pointer):
    """Select the most specific complete container that contains a JSON pointer."""
    matches = [record for record in records if record.get('complete') and
               (pointer == record['path'] or pointer.startswith(record['path'].rstrip('/') + '/'))]
    return max(matches, key=lambda record: len(record['path']), default=None)


def compact_collections(records, max_characters):
    """Bundle all observed members of a small array into one literal citation.

    Completeness concerns this returned array, never unobserved pages.
    Partial records and incomplete arrays retain their original units.
    """
    groups = {}
    for record in records:
        if record.get('collectionLength', 0) > 0:
            groups.setdefault(record['collectionPath'], []).append(record)
    bundles = {}
    for path, members in groups.items():
        length = members[0]['collectionLength']
        expected = [path + '/' + str(i) for i in range(length)]
        if [row['path'] for row in members] != expected or not all(row['complete'] for row in members):
            continue
        quote = '[' + ','.join(row['quote'] for row in members) + ']'
        # Scalar strings use plain excerpt text rather than JSON literals.
        try:
            json.loads(quote)
        except json.JSONDecodeError:
            continue
        if len(quote) <= max_characters:
            bundles[path] = {'path': path, 'quote': quote, 'complete': True,
                             'collectionPath': path, 'collectionLength': length}
    result, emitted = [], set()
    for record in records:
        path = record.get('collectionPath')
        if path in bundles:
            if path not in emitted:
                result.append(bundles[path])
                emitted.add(path)
        else:
            result.append(record)
    return result


def retain_cited_containers(review):
    """Keep exposed record context beside a selected scalar citation, without adding edges."""
    import copy
    review = copy.deepcopy(review)
    links = {(link['sourceCallId'], link['targetCallId']): link for link in review.get('links', [])}
    rows = [(link, link.get('evidence', [])) for link in links.values()]
    rows += [(parent, links.get((parent['sourceCallId'], binding['targetCallId']), {}).get('evidence', []))
             for binding in review.get('inputBindings', []) for parent in binding['parents']]
    for row, available in rows:
        selected = row.get('selectedEvidence', [])
        for citation in list(selected):
            if citation.get('field') != 'response':
                continue
            containers = [item for item in available if item.get('callId') == citation.get('callId')
                          and item.get('field') == 'response' and item['path'] != citation['path']]
            container = containing_record(containers, citation['path'])
            if container is not None and not any(
                    all(item.get(key) == container.get(key) for key in ('callId', 'field', 'path', 'quote'))
                    for item in selected):
                selected.append({**container, 'citationScope': 'containing_record'})
    return review
