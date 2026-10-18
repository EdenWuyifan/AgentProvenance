import sys
from pathlib import Path
from hashlib import sha256
import unittest

sys.path.insert(0, str(Path(__file__).parents[1] / "agent_provenance_backend"))

from importance import assess_importance
from score_attribution import fit_score_models


def cohort(size=30):
    return [{"traceId": f"t{i}", "taskId": "task", "scoreMetric": "quality",
             "score": 10 + (5 if i % 2 else 0) + ((i // 2) % 5) * 0.01,
             "instances": ([{"familyId": "signal"}] if i % 2 else [])}
            for i in range(size)]


class ScoreAttributionTests(unittest.TestCase):
    def test_additive_local_values_reconstruct_centered_prediction(self):
        model = fit_score_models(cohort())["cohorts"][0]
        self.assertEqual(model["status"], "available")
        family = model["families"]["signal"]
        contributions = list(family["perTrace"].values())
        self.assertAlmostEqual(sum(contributions), 0, places=5)
        self.assertGreater(family["perTrace"]["t1"], 0)
        self.assertLess(family["perTrace"]["t0"], 0)
        self.assertAlmostEqual(family["perTrace"]["t1"] - family["perTrace"]["t0"],
                               family["coefficient"], places=5)

    def test_ten_runs_allow_exploratory_attribution_without_promotion(self):
        entries = cohort(10)
        model = fit_score_models(entries)["cohorts"][0]
        self.assertEqual(model["status"], "exploratory")
        self.assertTrue(model["families"])
        importance = assess_importance("signal", [{"traceId": "t1", "attention": "supporting"}], entries)
        self.assertTrue(importance["outcome"]["contributions"])
        self.assertEqual(importance['outcome']['status'], 'exploratory')
        self.assertEqual(importance['decision'], 'collapse')

    def test_binary_success_metric_can_pass_with_enough_support(self):
        entries = cohort()
        for i, entry in enumerate(entries):
            entry["score"] = int(i % 2 == 1)
        model = fit_score_models(entries)["cohorts"][0]
        self.assertEqual(model["status"], "available")
        self.assertEqual(model["gates"]["minimumDistinctScores"], 2)
        self.assertEqual(model["families"]["signal"]["distinctScoresPresent"], 1)

    def test_nonpredictive_estimate_is_exploratory_with_diagnostics(self):
        entries = cohort()
        for i, entry in enumerate(entries):
            entry["score"] = int(sha256(str(i).encode()).hexdigest(), 16) % 1000
        model = fit_score_models(entries)["cohorts"][0]
        self.assertEqual(model["status"], "exploratory")
        self.assertTrue(model['concerns'])

    def test_trace_selection_changes_report_only(self):
        entries = cohort()
        first = fit_score_models(entries)
        selected = [{"traceId": "t1", "attention": "supporting"}]
        importance = assess_importance("signal", selected, entries)
        self.assertEqual(len(importance["outcome"]["contributions"]), 1)
        self.assertEqual(importance["outcome"]["contributions"][0]["traceId"], "t1")
        self.assertIs(fit_score_models(entries), first)

    def test_cache_is_invariant_to_order_and_irrelevant_reference_fields(self):
        entries = cohort()
        first = fit_score_models(entries)
        reordered = [dict(entry, unusedCallPayload={"large": [1, 2, 3]})
                     for entry in reversed(entries)]
        self.assertIs(fit_score_models(reordered), first)

    def test_cohort_reports_all_families_but_does_not_attribute_constant_pattern(self):
        entries = cohort()
        for entry in entries:
            entry["instances"].append({"familyId": "constant"})
        model = fit_score_models(entries)["cohorts"][0]
        self.assertIn("constant", model["familyIds"])
        self.assertEqual(model["status"], "available")
        self.assertNotIn("constant", model["families"])
        self.assertAlmostEqual(model["predictedScores"]["t1"] - model["baseline"],
                               sum(f["perTrace"]["t1"] for f in model["families"].values()), places=5)

    def test_top_predictive_supporting_pattern_is_prominent(self):
        entries = cohort()
        members = [{"traceId": "t1", "attention": "supporting"}]
        importance = assess_importance("signal", members, entries)
        self.assertEqual(importance["decision"], "expand")
        self.assertEqual(importance["tier"], "key")
        self.assertIn("predictive-focus", {facet["id"] for facet in importance["facets"]})

    def test_constant_pattern_has_no_predictive_focus(self):
        entries = cohort()
        for entry in entries:
            entry["instances"].append({"familyId": "constant"})
        members = [{"traceId": "t1", "attention": "supporting"}]
        importance = assess_importance("constant", members, entries)
        self.assertEqual(importance["decision"], "collapse")
        self.assertNotIn("predictive-focus", {facet["id"] for facet in importance["facets"]})


def tools_cohort():
    return [{'traceId': f'{task}:{i}', 'taskId': task, 'scoreMetric': 'score',
             'score': base + scale * (int(i % 2) + (i % 3) * .01),
             'tools': ['always', task] + (['signal'] if i % 2 else [])}
            for task, base, scale in [('a', 0, 1), ('b', 100, 10), ('c', 10, 2)]
            for i in range(10)]


def test_global_tools_use_within_task_variation_and_reconstruct_predictions():
    model = fit_score_models([], tools_cohort())['toolModels'][0]
    assert model['taskCount'] == 3 and model['sampleCount'] == 30
    assert model['status'] == 'available'
    assert set(model['tools']) == {'signal'}  # Task identity and mandatory tools carry no within-task information.
    feature = model['tools']['signal']
    assert feature['importance'] > 0 and feature['meanWhenPresent'] > 0
    assert feature['perTrace']['a:1'] > 0 > feature['perTrace']['a:0']
    for run, prediction in model['predictedScores'].items():
        assert abs(prediction - sum(tool['perTrace'][run] for tool in model['tools'].values())) < 1e-5
    assert sum(feature['perTrace'].values()) == 0


def test_task_specific_positive_score_rescaling_does_not_change_global_values():
    reference = tools_cohort()
    before = fit_score_models([], reference)['toolModels'][0]['tools']['signal']
    changed = [dict(e, score=e['score'] * (7 if e['taskId'] == 'a' else 2) + 123) for e in reference]
    after = fit_score_models([], changed)['toolModels'][0]['tools']['signal']
    assert before['importance'] == after['importance']
    assert before['perTrace'] == after['perTrace']


def test_replicating_one_task_does_not_increase_its_global_weight():
    reference = tools_cohort()
    before = fit_score_models([], reference)['toolModels'][0]['tools']['signal']
    duplicate = reference + [dict(e, traceId=e['traceId'] + ':copy') for e in reference if e['taskId'] == 'a']
    after = fit_score_models([], duplicate)['toolModels'][0]['tools']['signal']
    assert before['importance'] == after['importance']


def test_zero_variance_tasks_and_unknown_scores_are_not_given_artificial_values():
    reference = tools_cohort() + [
        {'traceId': f'constant:{i}', 'taskId': 'constant', 'score': 0.1, 'tools': ['unique']}
        for i in range(20)] + [{'traceId': 'missing', 'taskId': 'missing', 'score': None, 'tools': ['unknown']}]
    model = fit_score_models([], reference)['toolModels'][0]
    assert model['sampleCount'] == 30 and model['excludedExecutions'] == 20
    assert 'unique' not in model['tools'] and 'unknown' not in model['toolNames']


def test_global_tool_scores_attach_to_stage_without_double_counting_repeated_tools():
    entries = cohort(10)
    models = fit_score_models(entries, tools_cohort())
    importance = assess_importance('signal', [{'traceId': 'a:1', 'attention': 'supporting'}], entries,
                                   score_models=models, tool_names=['signal'])
    assert len(importance['outcome']['globalTools']) == 1
    assert importance['outcome']['globalTools'][0]['contributions'] == [
        {'traceId': 'a:1', 'value': models['toolModels'][0]['tools']['signal']['perTrace']['a:1']}]


def test_selected_task_does_not_borrow_identifiability_from_another_task():
    first = cohort()
    second = [dict(e, traceId='other:' + e['traceId'], taskId='other',
                   instances=[{'familyId': 'signal'}] + ([{'familyId': 'other_signal'}] if i % 2 else []))
              for i, e in enumerate(cohort())]
    importance = assess_importance('signal', [{'traceId': 'other:t1', 'attention': 'supporting'}], first + second)
    assert importance['outcome']['status'] == 'not_identifiable'
    assert importance['outcome']['contributions'] is None
    assert {cohort['taskId'] for cohort in importance['outcome']['cohorts']} == {'other'}


if __name__ == "__main__":
    unittest.main()
