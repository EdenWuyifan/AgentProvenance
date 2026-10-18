import sys
import json
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "experiments"))
from benchmark_abstraction import quality, recheck_report


def family(name, members):
    instances = []
    variants = []
    for index, (tools, params, diagnostics) in enumerate(members):
        instance_id = f"{name}-{index}"
        instances.append({"id": instance_id, "run": "run",
                          "calls": [{"id": f"call-{index}-{n}", "tool": tool, "step": index * 10 + n + 1}
                                    for n, tool in enumerate(tools)]})
        variants.append({"run": "run", "instanceId": instance_id,
                         "parameters": params, "diagnostics": diagnostics})
    return {"id": name, "label": name, "instances": instances, "variants": variants}


def graph(*nodes):
    return {"nodes": list(nodes)}


def test_quality_accepts_separate_methods_populations_and_failure_family():
    data = graph(
        family("gsea", [(["gsea_pipe"], {}, [])]),
        family("ora", [(["ora_pipe"], {}, [])]),
        family("literature", [(["enrich_rumma"], {}, [])]),
        family("up", [(["csv_filter"], {"conditions": [{"column": "log2FC", "op": ">", "value": 1}]}, [])]),
        family("down", [(["csv_filter"], {"conditions": [{"column": "log2FC", "op": "<", "value": -1}]}, [])]),
        family("selection", [(["csv_filter", "csv_join"], {}, [])]),
        family("validation", [(["validate_result"], {}, [])]),
        family("failure", [(["query"], {}, [{"label": "Recorded tool failure"}])]),
    )
    checks = quality(data, "run")
    assert checks["analyticalMethodsSeparate"] is True
    assert checks["oppositeDirectionsSeparate"] is True
    assert checks["selectionJoinNonfusion"] is True
    assert checks["recordedFailureVisible"] is True
    assert checks["recordedFailureIsolated"] is True


def test_quality_rejects_method_direction_and_failure_family_fusion():
    data = graph(
        family("fused-methods", [(["ora_pipe", "gsea_pipe", "enrich_rumma"], {}, [])]),
        family("fused-directions", [
            (["csv_filter"], {"conditions": [{"column": "L2FC", "op": ">", "value": 1}]}, []),
            (["csv_filter"], {"conditions": [{"column": "L2FC", "op": "<", "value": -1}]}, []),
        ]),
        family("broad", [(["csv_filter", "csv_join", "validate_result"], {}, [])]),
        family("failure-with-healthy-work", [
            (["sets_info_rumm"], {}, [{"label": "Recorded tool failure"}]),
            (["query_string_rumma"], {}, []),
        ]),
    )
    checks = quality(data, "run")
    assert checks["analyticalMethodsSeparate"] is False
    assert checks["oppositeDirectionsSeparate"] is False
    assert checks["selectionJoinNonfusion"] is False
    assert checks["recordedFailureVisible"] is True
    assert checks["recordedFailureIsolated"] is False


def test_quality_detects_hidden_failure_and_marks_absence_as_not_applicable():
    checks = quality(graph(), "run", [{"id": "failed", "status": "error", "response": None}])
    assert checks["recordedFailuresPreserved"] is False
    assert checks["recordedFailureVisible"] is None
    assert quality(graph(), "run", [])["recordedFailuresPreserved"] is True


def test_saved_report_recheck_uses_joint_graph_and_preserves_timings(tmp_path):
    bad = graph(
        family("pathway", [(["ora_pipe", "gsea_pipe", "enrich_rumma"], {}, [])]),
        family("directions", [
            (["csv_filter"], {"conditions": [{"column": "log2FC", "op": ">", "value": 1}]}, []),
            (["csv_filter"], {"conditions": [{"column": "log2FC", "op": "<", "value": -1}]}, []),
        ]),
        family("failure", [
            (["sets_info_rumm"], {}, [{"label": "Recorded tool failure"}]),
            (["query_string_rumma"], {}, []),
        ]),
    )
    report_path = tmp_path / "iteration.json"
    report_path.write_text(json.dumps({"status": "completed", "coldPerTrace": [
        {"traceId": "o4_mini:1215:5.1", "cold": {"groups": [{"familyId": "old-family", "runs": [
            {"traceId": "o4_mini:1215:5.1", "steps": [5, 6, 7], "tools": ["csv_filter", "csv_filter", "csv_join"]}]}]},
         "coldSeconds": 1.25}], "coldBatch": {"backendWallSeconds": 2.5}}))
    report_path.with_suffix(".graph.json").write_text(json.dumps(bad))

    updated = recheck_report(report_path)
    checks = updated["coldPerTrace"][0]["qualityChecks"]
    assert checks["hasMultiCallStage"] is True
    # The single-trace cold projection must not inherit joint-graph conflicts.
    assert checks["analyticalMethodsSeparate"] is True
    assert checks["oppositeDirectionsSeparate"] is True
    assert checks["recordedFailureIsolated"] is True
    assert updated["coldPerTrace"][0]["coldSeconds"] == 1.25
    assert updated["coldBatch"]["backendWallSeconds"] == 2.5
    assert updated["qualityRecheck"]["sourceGraph"] == "iteration.graph.json"
    assert updated["coldBatch"]["qualityChecks"]["analyticalMethodsSeparate"] is False
    assert updated["coldBatch"]["qualityChecks"]["oppositeDirectionsSeparate"] is False
    assert updated["coldBatch"]["qualityChecks"]["recordedFailureIsolated"] is False
