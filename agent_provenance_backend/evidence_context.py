"""Shared occurrence graph and result boundaries for every trace format."""

from collections import defaultdict, deque

from event_order import strictly_earlier
from models import CACHE_DIR, read_cache, write_json
from repeat_patterns import _MISSING, _pointer_value


def bound_input_records(analysis):
    """Resolve recorded references to earlier records, without inferring new edges."""
    calls = {call['id']: call for call in analysis['calls']}
    records = defaultdict(list)
    for edge in context_links(analysis):
        if edge.get('inferred'):
            continue
        source, target = calls[edge['source']], calls[edge['target']]
        if not strictly_earlier(source, target, analysis.get('workflow', {}).get('roundLabel', '')):
            continue
        for item in edge.get('evidence', []):
            if 'sourcePath' not in item or 'targetPath' not in item:
                continue
            value = _pointer_value(source.get('response'), item['sourcePath'])
            consumed = _pointer_value(target.get('args', {}), item['targetPath'])
            if value is _MISSING or consumed is _MISSING or value is None or value != consumed:
                continue
            parent = item['sourcePath'].rsplit('/', 1)[0]
            record = _pointer_value(source.get('response'), parent)
            if isinstance(record, dict):
                records[target['id']].append({'sourceCallId': source['id'], 'sourcePath': parent,
                    'targetPath': item['targetPath'], 'value': consumed, 'record': record})
    return records


def retain_interpretations(analysis, assessment):
    """Source-scoped inferred explanations survive partial or differently focused reviews."""
    path = CACHE_DIR / 'evidence-contexts' / f"{analysis['analysisKey']}.json"
    previous = read_cache(path) or []
    inferred = {(link['sourceCallId'], link['targetCallId'], link['relation']):
                {**link, 'relevance': 'context'} for link in previous}
    for link in assessment['links']:
        if link.get('inferred'):
            inferred[link['sourceCallId'], link['targetCallId'], link['relation']] = link
    if inferred:
        write_json(path, list(inferred.values()))
    return {**assessment, 'links': [link for link in assessment['links'] if not link.get('inferred')]
                                   + list(inferred.values())}


def context_links(analysis):
    """Source call-flow is canonical; import metadata also supports cleaned inputs."""
    if 'flow' in analysis:
        return analysis['flow']
    return analysis.get('workflow', {}).get('eventLinks', [])


def display_links(analysis):
    """Expose reviewed context without adding it to the dependency/skill flow."""
    links = list(context_links(analysis))
    known = {(link['source'], link['target']) for link in links}
    calls = {call['id']: call for call in analysis.get('calls', [])}
    for link in analysis.get('evidenceReview', {}).get('links', []):
        source, target = link['sourceCallId'], link['targetCallId']
        if (not link.get('inferred') or link.get('relevance') != 'context'
                or not link.get('evidence') or (source, target) in known
                or source not in calls or target not in calls
                or not strictly_earlier(calls[source], calls[target], analysis.get('workflow', {}).get('roundLabel', ''))):
            continue
        links.append({**link, 'source': source, 'target': target})
        known.add((source, target))
    return links


class EvidenceContext:
    def __init__(self, calls, links):
        self.calls = {call['id']: call for call in calls}
        self.incoming, self.outgoing = defaultdict(list), defaultdict(list)
        self.links = []
        for link in links:
            if link['source'] not in self.calls or link['target'] not in self.calls:
                raise ValueError('Context links must reference existing activities.')
            row = {**link, 'ref': f'l{len(self.links)}',
                   'relation': link.get('relation') or 'recorded', 'inferred': bool(link.get('inferred'))}
            self.links.append(row)
            self.incoming[row['target']].append(row)
            self.outgoing[row['source']].append(row)

    def ancestors(self, targets):
        found = set(targets)
        queue = deque(targets)
        while queue:
            for link in self.incoming[queue.popleft()]:
                if not link['inferred'] and link['source'] not in found:
                    found.add(link['source'])
                    queue.append(link['source'])
        return found


def result_targets(analysis):
    """Use supplied results and source-cited associations; never infer a new goal."""
    supplied = set(analysis.get('targetCallIds', [])) | set(analysis.get('targets', []))
    supplied.update(analysis.get('resultAnchors', []))
    outcomes = analysis.get('workflow', {}).get('outcomes', analysis.get('outcomes', []))
    system = [outcome for outcome in outcomes if outcome.get('scope') != 'participant']
    finals = [outcome for outcome in system if outcome.get('terminal') or outcome.get('kind') == 'final']
    supplied.update(outcome['eventId'] for outcome in finals or system)
    by_id = {call['id'] for call in analysis['calls']}
    if supplied - by_id:
        raise ValueError('Result targets must reference existing activities.')
    return supplied


def result_path(analysis):
    targets = result_targets(analysis)
    context = EvidenceContext(analysis['calls'], context_links(analysis))
    return targets, context.ancestors(targets)


def is_transport(link):
    return link.get('evidenceRole') == 'transport' or link.get('relation') in {'publishes', 'delivered_to'}
