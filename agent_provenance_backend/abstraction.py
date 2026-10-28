"""Mechanical projection of call graphs into inspectable pattern groups."""

from collections import defaultdict, deque
import json
import re
from urllib.parse import urlsplit

from importance import assess_importance, score_summary
from score_attribution import fit_score_models
from models import digest
from provenance import output_resources, declared_resources, project_dependencies
from evidence_context import display_links, result_path


def _flow(analysis):
    outgoing = defaultdict(list)
    incoming = defaultdict(list)
    for edge in display_links(analysis):
        outgoing[edge["source"]].append(edge)
        incoming[edge["target"]].append(edge)
    return outgoing, incoming


def _internal_path(instance, start, end):
    allowed = set(instance.get("internalCalls", [call["id"] for call in instance["calls"]]))
    if start not in allowed or end not in allowed:
        return None
    outgoing = defaultdict(list)
    for edge in instance.get("internalFlow", []):
        outgoing[edge["source"]].append(edge)
    queue = deque([(start, [start])])
    seen = {start}
    while queue:
        current, path = queue.popleft()
        if current == end:
            return path
        for edge in outgoing[current]:
            target = edge["target"]
            if target in allowed and target not in seen:
                seen.add(target)
                queue.append((target, path + [target]))
    return None


def instance_edges(analysis: dict, kept_instances: set | None = None) -> list:
    """Keep a shortest call witness for each pair of visible boundary ports."""
    instances = analysis["instances"]
    by_call = {cid: instance for instance in instances for cid in instance["callIds"]}
    kept = {i["id"] for i in instances} if kept_instances is None else kept_instances
    outgoing, _ = _flow(analysis)
    result = []
    for instance in instances:
        if instance["id"] not in kept:
            continue
        for start in instance["callIds"]:
            seen = {(start, False)}
            queue = deque([(edge["target"], [start, edge["target"]], [edge])
                           for edge in outgoing[start] if by_call[edge["target"]]["id"] != instance["id"]])
            while queue:
                target, path, steps = queue.popleft()
                inferred = any(step.get('inferred', False) for step in steps)
                state = (target, inferred)
                if state in seen:
                    continue
                seen.add(state)
                target_instance = by_call[target]
                if target_instance["id"] in kept:
                    witness = {"run": analysis["traceId"], "sourceInstance": instance["id"],
                               "targetInstance": target_instance["id"], "callPath": path,
                               "inferred": any(step.get("inferred", False) for step in steps)}
                    if witness['inferred']:
                        witness['reason'] = ' '.join(dict.fromkeys(step['reason'] for step in steps if step.get('reason')))
                        witness['evidence'] = [item for step in steps if step.get('inferred')
                                               for item in step.get('evidence', [])]
                    result.append({"source": instance["familyId"], "target": target_instance["familyId"],
                                   "witness": witness})
                    continue
                for edge in outgoing[target]:
                    next_instance = by_call[edge["target"]]
                    if next_instance["id"] == instance["id"]:
                        continue
                    queue.append((edge["target"], path + [edge["target"]], steps + [edge]))
    return result


def compatible_path(graph: dict, family_path: list[str], trace_id: str) -> list:
    """Return witness chains whose ports connect within each repeated group."""
    if len(family_path) < 2:
        return []
    instances = {i["id"]: i for node in graph["nodes"] for i in node["instances"] if i["run"] == trace_id}
    states = [([], None)]
    for source, target in zip(family_path, family_path[1:]):
        witnesses = [w for edge in graph["edges"] if edge["source"] == source and edge["target"] == target
                     for w in edge["witnesses"] if w["run"] == trace_id]
        next_states = []
        for chain, previous in states:
            for witness in witnesses:
                internal = []
                if previous is not None:
                    if previous["targetInstance"] != witness["sourceInstance"]:
                        continue
                    instance = instances[witness["sourceInstance"]]
                    path = _internal_path(instance, previous["callPath"][-1], witness["callPath"][0])
                    if path is None:
                        continue
                    internal = path
                hop = dict(witness)
                hop["internalPath"] = internal
                next_states.append((chain + [hop], witness))
        states = next_states
    return [chain for chain, _ in states]


_PRIVATE_PARAMETER = re.compile(r'password|secret|token|authorization|api.?key|^email$', re.I)
_LOCATION_PARAMETER = re.compile(r'url|path|file', re.I)
_PROJECTION_PARAMETER = re.compile(r'^(?:keep_columns|select|suffixes)$', re.I)
_THRESHOLD_PARAMETER = re.compile(r'threshold|cutoff|p.?value|fdr|q.?value|alpha|significance', re.I)


def _operation_value(value, resources, latest, source, key='', display=False, output_aliases=None,
                     threshold_value=False):
    if _PRIVATE_PARAMETER.search(key):
        return None
    if not display and (_PROJECTION_PARAMETER.fullmatch(key)
                        or key.casefold() == 'name' and isinstance(value, str) and value in (output_aliases or set())):
        return None
    if source and re.fullmatch(r'name|url|path|file|.*_url|.*_path', key, re.I):
        return None
    if isinstance(value, dict):
        parts = {child_key: child for child_key, raw in sorted(value.items())
                 if (child := _operation_value(
                    raw, resources, latest, source, str(child_key), display, output_aliases,
                    bool(_THRESHOLD_PARAMETER.search(str(child_key)))
                    or key.casefold() in {'conditions', 'filters'}
                    and str(child_key).casefold() in {'value', 'threshold', 'cutoff'}
                    and value.get('op', value.get('operator')) in ('<', '<=', '>', '>=')
                )) is not None}
        if not display and str(value.get('op', value.get('operator', ''))).casefold() in {'in', 'not in'}:
            for field in ('value', 'values'):
                if isinstance(parts.get(field), list):
                    parts[field].sort(key=lambda item: json.dumps(item, sort_keys=True, ensure_ascii=False))
        return parts
    if isinstance(value, list):
        items = [_operation_value(child, resources, latest, source, key, display, output_aliases,
                                  threshold_value) for child in value]
        if key.casefold() in {'conditions', 'filters'}:
            return sorted(items, key=lambda item: json.dumps(item, sort_keys=True, ensure_ascii=False))
        return items
    if isinstance(value, str):
        if value in latest:
            return '<artifact>' if display else {'inputFrom': latest[value]}
        if value in resources:
            return '<artifact>' if display else {'unresolvedArtifact': digest(value)}
        if _LOCATION_PARAMETER.search(key) or re.match(r'^[A-Za-z][A-Za-z\d+.-]*://|/|^[A-Za-z]:\\', value):
            if display:
                return '<location>'
            parsed = urlsplit(value)
            return {'location': digest([parsed.scheme.lower(), parsed.netloc.lower(), parsed.path])}
        if display and len(value) > 400:
            return '<text>'
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        resource_value = str(value)
        if resource_value in latest:
            return '<artifact>' if display else {'inputFrom': latest[resource_value]}
        if resource_value in resources:
            return '<artifact>' if display else {'unresolvedArtifact': digest(resource_value)}
        if not display and threshold_value:
            return {'numberSign': 'negative' if value < 0 else 'zero' if value == 0 else 'positive'}
    return value


def _entity_ports(analysis):
    graph = project_dependencies(analysis)
    nodes = {node['id']: node for node in graph.get('nodes', [])}
    inputs, outputs = defaultdict(list), defaultdict(list)
    for edge in graph.get('edges', []):
        if edge.get('relation') == 'generatedBy' and edge.get('source') in nodes:
            call_id = nodes[edge['source']].get('toolCallId')
            if call_id is not None:
                outputs[call_id].append(edge['target'])
        elif (edge.get('relation') == 'usedBy' and not edge.get('inferred', False)
              and edge.get('target') in nodes):
            call_id = nodes[edge['target']].get('toolCallId')
            if call_id is not None:
                inputs[call_id].append(edge['source'])
    return inputs, outputs


def _output_aliases(value, key=''):
    aliases = set()
    if isinstance(value, dict):
        resource_record = any(str(child_key).casefold() in {'path', 'url', 'uri', 'file_id', 'artifact_id'}
                              for child_key in value)
        if resource_record:
            aliases.update(child for child_key, child in value.items()
                           if isinstance(child, str) and re.fullmatch(r'name|filename|file_name',
                                                                        str(child_key), re.I))
        for child in value.values():
            aliases.update(_output_aliases(child))
    elif isinstance(value, list):
        for child in value:
            aliases.update(_output_aliases(child, key))
    return aliases


def _operation_aliases(args, response):
    aliases = _output_aliases(response)
    if isinstance(args, dict) and isinstance(args.get('name'), str):
        # In a structured operation, `name` labels the produced view. A name-only
        # lookup remains substantive and is kept in the match key.
        if any(key in args for key in ('conditions', 'filters', 'on')):
            aliases.add(args['name'])
    return aliases


def _recorded_failure(call):
    if str(call.get('status')).lower() in {'error', 'failed', 'failure'}:
        return True
    response = call.get('response')
    return bool(isinstance(response, dict) and response.get('error')
                or isinstance(response, str) and response.lstrip().startswith('Error:'))


def _operation_signature_parameters(parameters):
    if isinstance(parameters, dict) and parameters.get('how') == 'inner':
        # An inner intersection is symmetric in its two inputs. Keep the exact
        # side-specific projection in parameterVariants, but align the operation
        # by the same two lineage ports regardless of their argument order.
        for left_key, value in parameters.items():
            if not left_key.startswith('left_') or not isinstance(value, dict) or set(value) != {'inputFrom'}:
                continue
            right_key = 'right_' + left_key[5:]
            right_value = parameters.get(right_key)
            if not isinstance(right_value, dict) or set(right_value) != {'inputFrom'}:
                continue
            left = json.dumps(value, sort_keys=True, ensure_ascii=False)
            right = json.dumps(right_value, sort_keys=True, ensure_ascii=False)
            if left > right:
                parameters = {**parameters, left_key: right_value, right_key: value}
    return parameters


def _projection_lineage(parameters, args):
    """Treat supporting column-only preparation as the same pattern input.

    This aligns operations, not their results: the original preparation activity,
    entity ports and per-run values remain in the graph.
    """
    if not isinstance(parameters, dict) or not isinstance(args, dict) or not any(
            key in {'columns', 'keep_columns', 'select'} for key in args):
        return None
    inputs = set()
    for key, value in parameters.items():
        if isinstance(value, dict) and set(value) == {'inputFrom'}:
            inputs.add(value['inputFrom'])
        elif key not in {'columns', 'keep_columns', 'select', 'name'}:
            return None
    return next(iter(inputs)) if len(inputs) == 1 else None


def _declared_arguments(call, schema, latest, display=False):
    refs = {path: '<artifact>' if display else {'inputFrom': latest[identity]}
            if identity in latest else {'unresolvedArtifact': digest(identity)}
            for identity, path, _ in declared_resources(call, schema, 'inputs')}

    def replace(value, path=''):
        if path in refs:
            return refs[path]
        if isinstance(value, dict):
            return {key: replace(child, path + '/' + str(key).replace('~', '~0').replace('/', '~1'))
                    for key, child in value.items()}
        if isinstance(value, list):
            return [replace(child, path + f'/{index}') for index, child in enumerate(value)]
        return value

    return replace(call.get('args'))


def _operation_records(analysis):
    source_by_call = {cid: member['source'] for member in analysis['instances'] if member.get('source')
                      for cid in member['callIds']}
    supporting = {cid for member in analysis['instances'] if member.get('attention') == 'supporting'
                  for cid in member['callIds']}
    schema = analysis.get('referenceSchema')
    resources = ({value for call in analysis['calls'] for _, value in output_resources(call)}
                 if schema is None else set())
    input_entities, output_entities = _entity_ports(analysis)
    latest, lineage_occurrences, records = {}, defaultdict(int), {}
    for order, call in enumerate(sorted(analysis['calls'], key=lambda item: item['timeIndex'])):
        source = source_by_call.get(call['id'])
        aliases = _operation_aliases(call.get('args'), call.get('response'))
        args = _declared_arguments(call, schema, latest) if schema is not None else call.get('args')
        parameters = _operation_signature_parameters(_operation_value(
            args, resources, latest, source, output_aliases=aliases) or {})
        failure = _recorded_failure(call)
        signature = digest([call['tool'], parameters, source.get('identity') if source else None, failure])
        lineage_ordinal = lineage_occurrences[signature]
        lineage_occurrences[signature] += 1
        shown_args = _declared_arguments(call, schema, latest, display=True) if schema is not None else call.get('args')
        variant = _operation_value(shown_args, resources, latest, source, display=True,
                                   output_aliases=aliases) or {}
        records[call['id']] = {'tool': call['tool'], 'signature': signature, 'failure': failure,
                               'order': order, 'step': call['timeIndex'] + 1,
                               'inputEntityIds': sorted(input_entities.get(call['id'], [])),
                               'outputEntityIds': sorted(output_entities.get(call['id'], [])),
                               'variant': variant, 'variantKey': digest(variant)}
        # Calls folded into one external input expose the same dataset despite local aliases.
        lineage_id = digest(['external-input', source['identity']]) if source else digest([signature, lineage_ordinal])
        if not source and not failure and call['id'] in supporting:
            lineage_id = _projection_lineage(parameters, args) or lineage_id
        outputs = (declared_resources(call, schema, 'outputs') if schema is not None else
                   ((value, path, value) for path, value in output_resources(call)))
        for identity, _, _ in outputs:
            latest[identity] = lineage_id
    return records


def _operation_groups(family, members, entries, records_by_run=None):
    groups = {}
    for run in sorted({member['traceId'] for member in members}):
        records = records_by_run[run] if records_by_run is not None else _operation_records(entries[run])
        family_call_ids = {cid for member in members if member['traceId'] == run for cid in member['callIds']}
        group_occurrences = defaultdict(int)
        for cid in sorted(family_call_ids, key=lambda item: records[item]['order']):
            record = records[cid]
            signature = record['signature']
            occurrence = group_occurrences[signature]
            group_occurrences[signature] += 1
            tool = record['tool']
            group_key = (tool, signature, occurrence)
            group = groups.setdefault(group_key, {
                'id': 'operation:' + digest([family, tool, signature, occurrence])[:20],
                'tool': tool, 'failure': record['failure'],
                'supportTraces': set(), 'members': [], 'parameterVariants': {}})
            group['supportTraces'].add(run)
            group['members'].append({'run': run, 'callId': cid, 'step': record['step'],
                                     'inputEntityIds': record['inputEntityIds'],
                                     'outputEntityIds': record['outputEntityIds']})
            variant = group['parameterVariants'].setdefault(record['variantKey'],
                {'parameters': record['variant'], 'members': []})
            variant['members'].append({'run': run, 'callId': cid})
    result = []
    for group in groups.values():
        group['supportTraces'] = sorted(group['supportTraces'])
        group['members'].sort(key=lambda member: (member['run'], member['step'], member['callId']))
        group['parameterVariants'] = list(group['parameterVariants'].values())
        for variant in group['parameterVariants']:
            variant['members'].sort(key=lambda member: (member['run'], member['callId']))
        result.append(group)
    return sorted(result, key=lambda group: (group['tool'], group['id']))


def align_instances(analysis):
    """Align standalone calls across runs independently of annotation shape/stage.

    Same-run repeats retain their occurrence identity. Source preparation and
    multi-call semantic abstractions keep the groups chosen during instantiation.
    """
    operations = _operation_groups('cross-trace-v1', analysis['instances'], {analysis['traceId']: analysis})
    identities = {member['callId']: operation['id'] for operation in operations for member in operation['members']}
    instances = [dict(instance, familyId='pattern:' + digest([
        analysis['templateVersion'], identities[instance['callIds'][0]]])[:20])
        if len(instance['callIds']) == 1 and not instance.get('source') and instance['display'] != 'omit'
        else instance for instance in analysis['instances']]
    return {**analysis, 'instances': instances}


def build_views(analyses: list, reference: list, cohort_info: dict, focus: str = "", detail: str = "all", tool_reference=()) -> dict:
    families = defaultdict(list)
    score_models = fit_score_models(reference, tool_reference)
    entries = {a["traceId"]: a for a in analyses}
    operation_records = {a['traceId']: _operation_records(a) for a in analyses}
    call_maps = {a["traceId"]: {c["id"]: c for c in a["calls"]} for a in analyses}
    target_data = {a["traceId"]: result_path(a) for a in analyses}
    visible_ids = {m["id"] for a in analyses for m in a["instances"]
                   if detail == "all" or m.get("display", "show") != "omit"
                   or set(m['callIds']).intersection(a.get('resultAnchors', []))
                   or any(a.get('evidenceReview', {}).get('events', {}).get(cid, {}).get('level') == 'key'
                          for cid in m['callIds'])}
    for analysis in analyses:
        targets, ancestors = target_data[analysis["traceId"]]
        review = analysis.get('evidenceReview', {})
        reviewed_events = review.get('events', {})
        for instance in analysis["instances"]:
            if instance["id"] in visible_ids:
                member = dict(instance)
                member["resultTargets"] = sorted(set(analysis.get('targets', [])).intersection(instance["callIds"]))
                member["resultBackbone"] = bool(ancestors.intersection(instance["callIds"]))
                member['resultStatus'] = analysis.get('resultEvidence', {}).get('status', 'missing-final')
                member['resultEvidence'] = [dict(link, claimId=claim['id'], claimText=claim['text'])
                    for claim in analysis.get('resultEvidence', {}).get('claims', []) for link in claim['links']
                    if link['callId'] in instance['callIds']]
                judgments = [reviewed_events[cid] for cid in instance['callIds'] if cid in reviewed_events]
                explicit = [item for item in judgments if item['status'] == 'assessed' and item['level'] != 'unknown']
                if any(item['level'] == 'key' for item in explicit):
                    member['attention'] = 'key'
                elif member.get('attention') != 'key' and len(explicit) == len(instance['callIds']) and explicit:
                    member['attention'] = 'supporting'
                member['evidenceReview'] = [{'callId': cid, **reviewed_events[cid]}
                                            for cid in instance['callIds'] if cid in reviewed_events]
                member["targetEvidence"] = [e for e in analysis.get("targetEvidence", [])
                                             if e.get("callId") in instance["callIds"]]
                families[instance["familyId"]].append(member)
    nodes = []
    for family, members in sorted(families.items()):
        methods = sorted({call_maps[m['traceId']][cid]['tool'] for m in members for cid in m['callIds']})
        importance = assess_importance(family, members, reference, focus, score_models, methods)
        support = sorted({m["traceId"] for m in members})
        instances = []
        variants = []
        for member in members:
            run = member["traceId"]
            calls = [{"id": cid, "tool": call_maps[run][cid]["tool"],
                      "step": call_maps[run][cid]["timeIndex"] + 1} for cid in member["callIds"]]
            run_analysis = entries[run]
            visible_calls = {cid for m in run_analysis["instances"] if m["id"] in visible_ids
                             and m["id"] != member["id"] for cid in m["callIds"]}
            hidden_calls = {cid for m in run_analysis["instances"] if m["id"] not in visible_ids
                            for cid in m["callIds"]}
            allowed_calls = set(member["callIds"]) | hidden_calls
            internal = [dict(edge) for edge in run_analysis.get("flow", [])
                        if edge["source"] in allowed_calls and edge["target"] in allowed_calls
                        and edge["source"] not in visible_calls and edge["target"] not in visible_calls]
            internal_calls = sorted({cid for edge in internal for cid in (edge["source"], edge["target"])}
                                    | set(member["callIds"]))
            instances.append({"id": member["id"], "run": run, "calls": calls, "internalFlow": internal,
                              "internalCalls": internal_calls,
                              "attention": member.get("attention", "supporting"),
                              "resultTargets": member["resultTargets"],
                              "targetEvidence": member["targetEvidence"],
                              "resultBackbone": member["resultBackbone"],
                              "resultEvidence": member['resultEvidence'], "resultStatus": member['resultStatus'],
                              "background": member.get("display", "show") == "omit",
                              **({'source': member['source']} if member.get('source') else {})})
            variants.append({"run": run, "instanceId": member["id"], "parameters": member.get("parameters", {}),
                             "diagnostics": member.get("diagnostics", []),
                             "roleBindings": member.get("roleBindings", {}),
                             "evidence": [{k: v for k, v in record.items() if k != "value"}
                                          for record in member.get("evidence", [])],
                             "targetEvidence": member["targetEvidence"]})
        nodes.append({"id": family, "kind": "JoinedActivity", "label": min(m["label"] for m in members),
                      "semanticRole": members[0].get("templateId"), "supportTraces": support,
                      "attention": "key" if any(m.get("attention") == "key" for m in members) else "supporting",
                      "supportCount": len(support),
                      "methods": methods,
                      "instances": instances, "variants": variants,
                      "operationGroups": _operation_groups(family, members, entries, operation_records),
                      "importance": importance,
                      **({'source': members[0]['source']} if members[0].get('source') else {}),
                      "resultBackbone": any(m["resultBackbone"] for m in members),
                      "scoreSummary": score_summary([entries[r] for r in support])})
        nodes[-1]['evidenceReview'] = [{'run': m['traceId'], **item}
                                       for m in members for item in m.get('evidenceReview', [])]
    kept = {m["id"] for members in families.values() for m in members}
    edge_groups = defaultdict(list)
    for analysis in analyses:
        targets, ancestors = target_data[analysis["traceId"]]
        reviewed_links = {(link['sourceCallId'], link['targetCallId']): link
                          for link in analysis.get('evidenceReview', {}).get('links', [])}
        for edge in instance_edges(analysis, kept):
            edge["witness"]["highlighted"] = bool(not edge['witness']['inferred'] and edge["witness"]["callPath"] and
                                                  all(cid in ancestors for cid in edge["witness"]["callPath"]))
            path = edge['witness']['callPath']
            judgments = [reviewed_links.get((source, target), {}) for source, target in zip(path, path[1:])]
            if any(item.get('relevance') == 'context' for item in judgments):
                edge['witness']['relevance'] = 'context'
            if judgments and all(item.get('relevance') == 'relevant' for item in judgments):
                edge['witness']['highlighted'] = True
                edge['witness']['relevance'] = 'relevant'
                edge['witness']['evidence'] = [item for judgment in judgments for item in judgment.get('evidence', [])]
                edge['witness']['reason'] = ' '.join(dict.fromkeys(item['reason'] for item in judgments))
            edge_groups[(edge["source"], edge["target"])].append(edge["witness"])
    edges = []
    for (source, target), witnesses in sorted(edge_groups.items()):
        support = sorted({w["run"] for w in witnesses})
        edges.append({"id": "edge:" + digest([source, target])[:20], "source": source, "target": target,
                      "supportTraces": support, "supportCount": len(support), "witnesses": witnesses,
                      "inferred": any(w["inferred"] for w in witnesses),
                      "relation": ('semantic_followup' if all(w['inferred'] for w in witnesses)
                                   else 'mixed' if any(w['inferred'] for w in witnesses) else 'recorded'),
                      "scoreSummary": score_summary([entries[r] for r in support])})
    omitted = [{"run": a["traceId"], "id": cid, "tool": call_maps[a["traceId"]][cid]["tool"],
                "step": call_maps[a["traceId"]][cid]["timeIndex"] + 1}
               for a in analyses for m in a["instances"] if m["id"] not in kept for cid in m["callIds"]]
    source_calls = sum(len(a["calls"]) for a in analyses)
    visible_calls = sum(len(m["callIds"]) for a in analyses for m in a["instances"] if m["id"] in kept)
    return {"nodes": nodes, "edges": edges, "omittedCalls": omitted, "scoreSummary": score_summary(analyses),
            "generation": "mechanical", "templateVersion": analyses[0].get("templateVersion") if analyses else None,
            "cohort": cohort_info, "detail": detail,
            "resultEvidence": [a['resultEvidence'] for a in analyses if 'resultEvidence' in a],
            "scoreAttribution": score_models,
            "compression": {"sourceCalls": source_calls, "visibleCalls": visible_calls,
                            "hiddenCalls": source_calls - visible_calls, "visibleNodes": len(nodes),
                            "multiCallGroups": sum(len(m["calls"]) > 1 for node in nodes for m in node["instances"])},
            "alignment": {"mode": "tool-signature", "sharedPatterns": sum(n["supportCount"] > 1 for n in nodes)},
            "warnings": ["Aggregate edges can belong to different executions. Inspect trace and instance witnesses before interpreting a path.",
                         "Outcome statistics describe associations within comparable tasks; they do not establish causal contribution."]}
