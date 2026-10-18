import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent_provenance_backend"))
import abstraction
import importance


def instance(run, identifier, family, calls, display="show", template="analyze"):
    return {"id": identifier, "familyId": family, "traceId": run, "callIds": calls,
            "label": family, "intent": "inspect", "templateId": template, "display": display,
            "defaultDisplay": "summarize", "parameters": {}, "diagnostics": [],
            "evidence": [], "roleBindings": {}}


def analysis(run, calls, groups, flow, targets=None):
    return {"traceId": run, "calls": [{"id": c, "tool": c, "timeIndex": i} for i, c in enumerate(calls)],
            "instances": groups, "flow": flow, "targets": targets or [], "score": None,
            "scoreMetric": "score", "taskId": None, "templateVersion": "v1"}


def edge(source, target):
    return {"source": source, "target": target, "inferred": False}


def test_overview_hides_omitted_groups_and_keeps_branch_witnesses():
    run = "r"
    groups = [instance(run, "start", "start", ["s"]),
              instance(run, "hidden", "hidden", ["h"], "omit"),
              instance(run, "left", "left", ["l"]), instance(run, "right", "right", ["q"])]
    data = analysis(run, ["s", "h", "l", "q"], groups,
                    [edge("s", "h"), edge("h", "l"), edge("h", "q")])
    overview = abstraction.build_views([data], [], {}, detail="overview")
    assert {node["id"] for node in overview["nodes"]} == {"start", "left", "right"}
    assert {(edge["source"], edge["target"]) for edge in overview["edges"]} == {
        ("start", "left"), ("start", "right")}
    assert {tuple(w["callPath"]) for e in overview["edges"] for w in e["witnesses"]} == {
        ("s", "h", "l"), ("s", "h", "q")}
    assert [call["id"] for call in overview["omittedCalls"]] == ["h"]
    all_view = abstraction.build_views([data], [], {}, detail="all")
    hidden_node = next(node for node in all_view["nodes"] if node["id"] == "hidden")
    assert hidden_node["instances"][0]["background"] is True
    assert all_view["compression"] == {"sourceCalls": 4, "visibleCalls": 4, "hiddenCalls": 0,
                                        "visibleNodes": 4, "multiCallGroups": 0}


def test_multi_call_group_ports_require_internal_reachability():
    run = "r"
    # Group B has two input and two output ports. b1 cannot internally reach b2.
    groups = [instance(run, "a", "A", ["a"]), instance(run, "b", "B", ["b1", "b2"]),
              instance(run, "c", "C", ["c"])]
    data = analysis(run, ["a", "b1", "b2", "c"], groups,
                    [edge("a", "b1"), edge("b2", "c")])
    graph = abstraction.build_views([data], [], {}, detail="all")
    assert abstraction.compatible_path(graph, ["A", "B", "C"], run) == []

    data["flow"].append(edge("b1", "b2"))
    graph = abstraction.build_views([data], [], {}, detail="all")
    chains = abstraction.compatible_path(graph, ["A", "B", "C"], run)
    assert len(chains) == 1
    assert chains[0][0]["callPath"] == ["a", "b1"]
    assert chains[0][1]["callPath"] == ["b2", "c"]
    assert chains[0][1]["internalPath"] == ["b1", "b2"]


def test_late_entry_port_uses_internal_path_to_connect_group_exit():
    run = "late"
    groups = [instance(run, "a", "A", ["a"]), instance(run, "b", "B", ["b1", "b2"]),
              instance(run, "c", "C", ["c"])]
    data = analysis(run, ["a", "b1", "b2", "c"], groups,
                    [edge("a", "b2"), edge("b1", "b2"), edge("b2", "c")])
    graph = abstraction.build_views([data], [], {}, detail="all")
    chains = abstraction.compatible_path(graph, ["A", "B", "C"], run)
    assert len(chains) == 1
    assert chains[0][0]["callPath"] == ["a", "b2"]
    assert chains[0][1]["callPath"] == ["b2", "c"]
    assert chains[0][1]["internalPath"] == ["b2"]


def test_hidden_bridge_is_internal_but_projection_stops_at_other_visible_groups():
    run = "bridge"
    groups = [instance(run, "a", "A", ["a"]), instance(run, "b", "B", ["b1", "b2"]),
              instance(run, "h", "hidden", ["h"], "omit"), instance(run, "c", "C", ["c"]),
              instance(run, "x", "X", ["x"]), instance(run, "y", "Y", ["y"])]
    calls = ["a", "b1", "h", "b2", "c", "x", "y"]
    flow = [edge("a", "b1"), edge("b1", "h"), edge("h", "b2"), edge("b2", "c"),
            edge("x", "b1"), edge("b1", "y")]
    data = analysis(run, calls, groups, flow)
    graph = abstraction.build_views([data], [], {}, detail="overview")
    chains = abstraction.compatible_path(graph, ["A", "B", "C"], run)
    assert len(chains) == 1
    assert chains[0][1]["internalPath"] == ["b1", "h", "b2"]
    # X->Y cannot become a shortcut through B's visible calls.
    xy = [e for e in graph["edges"] if (e["source"], e["target"]) == ("X", "Y")]
    assert xy == []


def test_no_phantom_paths_across_repeated_occurrences_or_runs():
    data = analysis("r", ["a", "b1", "b2", "c"], [
        instance("r", "a", "A", ["a"]), instance("r", "b1", "B", ["b1"]),
        instance("r", "b2", "B", ["b2"]), instance("r", "c", "C", ["c"])],
        [edge("a", "b1"), edge("b2", "c")])
    graph = abstraction.build_views([data], [], {}, detail="all")
    assert abstraction.compatible_path(graph, ["A", "B", "C"], "r") == []
    other = analysis("s", ["d", "e"], [instance("s", "d", "A", ["d"]),
                                          instance("s", "e", "B", ["e"])], [edge("d", "e")])
    merged = abstraction.build_views([data, other], [], {}, detail="all")
    assert abstraction.compatible_path(merged, ["A", "B", "C"], "s") == []


def test_hidden_branching_keeps_one_witness_per_boundary_port_pair():
    # There are exponentially many hidden routes, but they have the same
    # entry and exit ports. Keep one shortest witness; retain the full source DAG.
    hidden = [f'h{layer}-{side}' for layer in range(18) for side in range(2)]
    flow = [edge('a', hidden[0]), edge('a', hidden[1])]
    for layer in range(17):
        flow.extend(edge(f'h{layer}-{left}', f'h{layer + 1}-{right}')
                    for left in range(2) for right in range(2))
    flow.extend([edge(hidden[-2], 'b'), edge(hidden[-1], 'b')])
    data = analysis('r', ['a', *hidden, 'b'], [
        instance('r', 'a', 'A', ['a']), instance('r', 'hidden', 'H', hidden, 'omit'),
        instance('r', 'b', 'B', ['b'])], flow)
    graph = abstraction.build_views([data], [], {}, detail='overview')
    assert len(graph['edges']) == 1 and len(graph['edges'][0]['witnesses']) == 1
    witness = graph['edges'][0]['witnesses'][0]
    assert witness['callPath'][0] == 'a' and witness['callPath'][-1] == 'b'
    assert len(witness['callPath']) == 20


def test_only_explicit_target_ancestry_is_highlighted():
    data = analysis("r", ["source", "middle", "final", "unrelated"], [
        instance("r", "s", "S", ["source"], "omit"), instance("r", "m", "M", ["middle"]),
        instance("r", "f", "F", ["final"], "omit"), instance("r", "u", "U", ["unrelated"])],
        [edge("source", "middle"), edge("middle", "final")], targets=["final"])
    graph = abstraction.build_views([data], [], {}, detail="overview")
    nodes = {node["id"]: node for node in graph["nodes"]}
    assert nodes["M"]["resultBackbone"] is True
    assert nodes["U"]["resultBackbone"] is False
    assert "S" not in nodes and "F" not in nodes
    assert graph["nodes"] and all(node["importance"]["tier"] in {"failure", "result", "key", "context"}
                                   for node in graph["nodes"])
    all_view = abstraction.build_views([data], [], {}, detail="all")
    highlighted = [w for edge_data in all_view["edges"] for w in edge_data["witnesses"] if w["highlighted"]]
    assert highlighted and all(all(call_id in {"source", "middle", "final"} for call_id in w["callPath"])
                               for w in highlighted)
    no_target = analysis("x", ["last"], [instance("x", "i", "last", ["last"])], [])
    no_anchor_graph = abstraction.build_views([no_target], [], {}, detail="all")
    assert no_anchor_graph["nodes"][0]["importance"]["facets"] == []
    assert no_anchor_graph["nodes"][0]["importance"]["tier"] == "context"


def test_unknown_or_weak_score_cohorts_do_not_claim_contrasts():
    member = instance("selected", "i", "F", ["call"])
    unknown = [{"taskId": None, "score": 100, "instances": []}]
    result = importance.assess_importance("F", [member], unknown)
    assert result["outcome"] == {'status': 'unavailable', 'contributions': None, 'cohorts': [], 'globalTools': []}
    assert result["tier"] == "context"
    small = [{"traceId": str(score), "taskId": "t", "scoreMetric": "m", "score": score,
              "instances": [{"familyId": "F"}] if score >= 3 else []} for score in [1, 4]]
    result = importance.assess_importance("F", [member], small)
    assert result["tier"] == "context"
    assert not any(f["id"] == "outcome" for f in result["facets"])


def test_score_contrast_does_not_promote_supporting_source_alone():
    reference = [
        {"traceId": f"run-{score}", "taskId": "task", "scoreMetric": "metric", "score": score,
         "instances": ([{"familyId": "source"}, {"familyId": "key"}]
                       if score in {3, 4} else [])}
        for score in (1, 2, 3, 4)
    ]
    source = importance.assess_importance("source", [{
        "traceId": "run-3", "attention": "supporting", "source": {"label": "input.csv"},
        "resultBackbone": True, "resultTargets": [], "diagnostics": [],
    }], reference)
    assert source["outcomeStatistics"][0]["scoreLift"] == 1.0
    assert source["decision"] == "collapse" and source["tier"] == "context"
    assert source['outcome']['status'] == 'exploratory'
    assert source['outcome']['contributions']

    key = importance.assess_importance("key", [{
        "traceId": "run-3", "attention": "key", "resultTargets": [], "resultBackbone": False,
        "diagnostics": [],
    }], reference)
    assert key["decision"] == "expand" and key["tier"] == "key"
    assert key['semantic']['level'] == 'key' and source['semantic']['level'] == 'supporting'
    assert 'score' not in key and 'score' not in source
    assert key['outcome']['status'] == 'exploratory'


def test_attention_dimensions_never_fabricate_scores_from_display_rules():
    base = {'traceId': 'run', 'attention': 'supporting', 'resultBackbone': False,
            'resultTargets': [], 'diagnostics': []}
    cases = [({}, 'collapse'), ({'resultBackbone': True}, 'collapse'),
             ({'attention': 'key'}, 'expand'),
             ({'attention': 'key', 'resultBackbone': True}, 'expand'),
             ({'diagnostics': [{'recorded': True}]}, 'expand'),
             ({'resultTargets': ['call']}, 'expand')]
    for changes, decision in cases:
        member = {**base, **changes}
        result = importance.assess_importance('family', [member], [])
        assert 'score' not in result and 'scoreBreakdown' not in result
        assert result['decision'] == decision
        assert result['outcome']['contributions'] is None
        repeated = [{**member, 'traceId': f'run-{index}'} for index in range(4)]
        assert importance.assess_importance('family', repeated, [])['semantic'] == result['semantic']


def test_inferred_shortcut_does_not_replace_a_recorded_hidden_route():
    groups = [instance('r', 'a', 'A', ['a']), instance('r', 'hidden', 'H', ['h1', 'h2', 'q'], 'omit'),
              instance('r', 'b', 'B', ['b'])]
    flow = [edge('a', 'h1'), edge('h1', 'h2'), edge('h2', 'b'),
            {'source': 'a', 'target': 'q', 'inferred': True, 'reason': 'Inferred subject follow-up', 'evidence': []},
            edge('q', 'b')]
    data = analysis('r', ['a', 'h1', 'h2', 'q', 'b'], groups, flow, targets=['b'])
    graph = abstraction.build_views([data], [], {}, detail='overview')
    witnesses = graph['edges'][0]['witnesses']
    assert any(w['callPath'] == ['a', 'h1', 'h2', 'b'] and not w['inferred'] and w['highlighted'] for w in witnesses)
    assert any(w['callPath'] == ['a', 'q', 'b'] and w['inferred'] and not w['highlighted'] for w in witnesses)
