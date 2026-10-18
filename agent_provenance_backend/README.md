# AgentProvenance backend

FastAPI service for recorded provenance and pattern-abstraction-v3 execution
overviews. Source calls and dependencies remain inspectable; semantic stages
are a reusable view over that recorded graph.

## Run

```sh
../.venv/bin/uvicorn app:app --host 127.0.0.1 --port 8008
```

Run it from this directory. Dependencies are in `requirements.txt`. Gateway
settings come from the shell and, for unset variables,
`../agent_provenance_react/.env`:

```dotenv
PORTKEY_API_KEY=...
PORTKEY_BASE_URL=https://your-gateway/v1/
PORTKEY_SEMANTIC_MODEL=@vertexai/gemini-3.8-flash
```

The semantic model annotates operation types that are not in the annotation
cache, in batches of at most 64 new types. A request can therefore complete without a model call when its types
are already known. There is no per-call description model, pairwise alignment
model, or Structural Lite dependency inference in the normal graph path.
New selected traces also receive cached semantic-follow-up assessments and
source-cited final-claim assessments. Final evidence retrieval and factual
extraction are local: no structural-model request is needed for these steps.
Result requests contain only selected final excerpts (at most 600 characters)
and retrieved output excerpts (at most 420 characters), not scores or gold
answers. Requests are bounded by 32 claims and 42,000 serialized characters,
with at most two result requests in flight. Cost scales with new evidence
batches, not all pairs of calls or all combinations of tools. Fully cached
selections need no model requests. The annotation/follow-up pipeline and result
assessment run concurrently; source graphs and score attribution are local.
The gateway timeout is 90,000 milliseconds. Annotation uses low reasoning
effort and an 8,192-token output budget, with automatic retries disabled.
Request metrics include failures and truncation; malformed output is reported
instead of silently triggering additional paid requests.

## Copilot graph tools

`POST /api/provenance-agent` runs `@vertexai/gemini-3.8-flash` through the
configured gateway. AI locate is integrated here; `/api/graph-focus` is removed.
The model initially sees a validated bounded graph catalog and current controls,
with opaque graph IDs and run aliases. Catalog limits are 120 nodes, 240 edges,
24,000 serialized characters; question length is 1,000 characters. Source scores,
raw tables, resource URLs and complete source trace IDs stay local.

Copilot tools support local search, highlighting, isolation, all frontend filters,
importance axis, expansion, framing, reset, targeted evidence reads and local
score-association rankings. `rank_score_associations` returns global cross-task
tool estimates separately from local pattern attributions. `meanWhenPresent` is
the mean signed Shapley contribution among runs containing that tool, in within-task
standardized score units; it is not the average outcome score. `importance` is the
mean absolute Shapley magnitude. Missing estimates remain unavailable, and model
interpretation must distinguish association from causal effects. No score fitting
or per-node LLM inference occurs inside these graph actions.

Targeted evidence uses final fragments of at most 600 characters and output
excerpts of at most 420. Witnesses retain opaque run/instance aliases so the model
can check path continuity across joined graphs without seeing source identifiers.
The `graph_focus.py` catalog validator remains shared; its standalone inference
function is retained only for historical benchmark reproduction.

NDJSON events include `graph_action`, tool activity, text, `final`, errors and
`telemetry` (`modelRequests`, `toolCalls`, `elapsedSeconds`). Actions translate
opaque IDs back to actual IDs locally, carry the exact view scope, and update
backend view state before subsequent tools run. Scope is never passed to the
model. The frontend rejects stale actions and scopes chat history to the current
graph. Provider IDs separate streamed Gemini function calls even when indices
repeat or are absent, and Google thought signatures are preserved. Invalid JSON
returns a tool error rather than executing an empty action.

Defaults: low reasoning, 8,192 output tokens, six model rounds and 24 local tool
calls per explicit question. Local search/filtering is free of model calls.
Batch independent actions and use the catalog directly for locating already
assessed content; fetch detailed source evidence only for verification questions.

## Pattern abstraction

1. `provenance.py` normalizes each input call and builds a mechanical Activity
   and output Entity pair. It retains source arguments and responses, explicit
   parent-call references, returned-resource references, and recorded failures.
   It does not connect calls merely because they are adjacent or share tokens.
2. `semantics.py` derives operation types from tool names and argument shapes,
   with recorded neighboring tool names as context. Bounded batches annotate new
   types into semantic stages, refinements to absorb, or background work to
   hide. Annotations are cached by prompt version, prompt, model settings, and focus.
   Repeated calls of one type reuse the same annotation. Original values are
   not replaced by model output. The same batch marks each stage's semantic
   attention as `key` or `supporting`; no per-call importance request is needed.
   Generic code, SQL, and command arguments use
   short syntax sketches (methods, SQL clauses, program names), masking literal
   values and locations. This distinguishes common operations without sending
   full code. It is not a general program-understanding algorithm.
3. `instantiate()` applies those type rules to each trace. It forms stage
   groups while preserving branches, joins, multiple inputs, outputs, and
   separate occurrences. Explicit target calls and final-output artifact
   references identify result paths. The caller's focus guides semantic
   annotation; it does not assert importance. Failed calls are kept separate
   from healthy occurrences, even when their operation type is identical.
   Independent consumed external inputs are protected from omission and from
   merging with another source. Routine reads attach to their source, so two
   independently loaded files remain two visible roots even if both use the
   same loading tool. Source basenames align matching inputs across traces;
   duplicate occurrences in one trace remain distinct.
4. `abstraction.py` projects each run independently, then joins matching stage
   keys. Connections retain per-run call-path witnesses. Overview omits
   background groups; All includes them. Neither mode discards source calls.
   Each family also exposes `operationGroups` for its expanded view. These align
   comparable calls by tool, recorded input lineage, and substantive parameters.
   Output aliases, projection options and threshold magnitudes can remain as
   parameter variants; opposite directions, different named subjects, methods,
   inputs, failures and repeated same-run occurrences stay separate. Alignment
   groups calls for comparison; it does not assert their outputs are identical.
   Before projection, `reasoning_links.py` gathers a bounded set of short
   subjects shared by earlier results/inputs and later inputs. One model batch
   selects plausible semantic follow-ups, returning only candidate IDs and
   rationales. The server supplies the matching source-field/path/quote
   citations. Field-name overlaps and already recorded paths are excluded.
   These inferred activity links are drawn separately from recorded entity
   handoffs, and cannot turn a hypothesis into a recorded result ancestor.
5. `result_evidence.py` segments actual final answers, retrieves candidate
   output excerpts with a local chunked BM25 inverted index, and asks the semantic
   model to distinguish support, contradiction and contextual relevance.
   The model must select supplied excerpt IDs; the server supplies exact
   source quotes, final-answer offsets and output JSON pointers. Requests use
   an explicit structured-output JSON schema. Multiple calls may form a joint
   evidence bundle; every member retains its own citation and shared bundle ID.
   Known input-source labels help distinguish incompatible measurements.
   This validates
   citations, not the truth of the model's interpretation. At most 24 retrieved
   claims per execution are assessed, examining at most 200,000 output
   characters per call. All final fragments are searched locally. Each retains
   unverified retrieved candidates even when it is outside the assessment
   budget; a candidate does not become a supporting link or result anchor.
   Source chunks are 420 characters with 80-character overlap and retain exact
   quotes and source positions. Coverage separates retrieval and assessment;
   missing or unmatched evidence is not proof of irrelevance. Supported and
   contradicted output calls anchor result paths through recorded dependencies
   only. Inferred claim links remain distinct from recorded resource references.
   Relevant calls are protected from overview omission. Reference-only traces
   do not incur final-evidence or follow-up model calls.
6. `importance.py` replaces numeric Attention bands with three separate
   dimensions: semantic role, result evidence, and predictive score attribution.
   Direct evidence, semantic key stages and recorded failures are prominent;
   supporting ancestors remain compact. Source branches and per-run witnesses
   remain intact. `score_attribution.py` fits a centered ridge model to binary
   semantic-family presence within a fixed task-and-metric reference cohort.
   Its exact marginal-background Shapley value is
   `coefficient * (presence - reference prevalence)`; contributions sum to
   prediction minus the reference mean. There are no LLM or replay requests.
   Score variation and at least two present and absent observations identify
   fitted local patterns. Ten executions can produce numerical estimates.
   Fewer than 20 executions, nonpositive held-out gain or coefficient-sign
   stability below 70% over 100 bootstrap samples mark the model exploratory;
   these diagnostics no longer suppress its values. Only estimates that pass
   these empirical checks may promote a supporting stage. Features are
   support-ranked and capped at `min(32, sampleCount // 2)`; constant, rare and
   dropped patterns remain unattributed.
   The predictor does not use final-answer correctness, gold answers, or an
   execution's score as input features. Correlations can redistribute credit;
   values explain the predictor, not the causal effect of removing a call.
7. Outcome (O) also includes global tool relevance from **all loaded reference
   summaries**, including traces without cached semantic analyses. No annotation
   or evidence requests are needed to score them. Each execution contributes a
   tool-name set and numeric task/metric score; repeated calls are not extra
   observations. Within each task, `z = (score - mean) / populationStd`, and
   `x = toolPresent - taskToolPrevalence`. A shared ridge model uses equal total
   weight per task. Exact local contributions are `beta * x`, with the same
   task-specific background. Global relevance is the task-balanced mean of
   `abs(contribution)`; averaging signed values across all runs would cancel.
   Signed contributions and the average when used are reported separately.
   Constant-score tasks and tools without within-task variation are not
   identifiable. The diagnostic five-fold test recomputes score normalization
   and tool prevalence from training rows only. It measures new-run prediction
   within observed tasks, not transfer to unseen tasks. The UI reports task
   coverage and presence/absence counts. Local pattern values use original score
   units; global tool values use task-score standard deviations. They are
   shown together in O without adding incompatible units or repeatedly counting
   a tool once per call. Global values are outcome context and do not override
   semantic role or result evidence. Tool names are exact names in the loaded
   source; no model guesses aliases across tool ecosystems.

The frontend shows key stages as cards and supporting clusters as small points.
Hover previews their calls without changing the graph layout or requesting a
model; clicking Expand opens aligned operations. Output values remain in the
inspector, with no output indicators or output cards on the canvas. Joined
families use the same attention rule and retain each trace's occurrence ports.
Distinct supporting trace counts control left-card-border and edge thickness;
repeated calls in the same run do not count as additional support. The card's
other three borders remain thin. Expanded operations show their family's
semantic role and expose run-scoped final evidence in the inspector. Quotes
are folded by default; the canvas contains no arbitrary Attention numbers.
`compression` reports source, visible, and
hidden call counts, visible stages, and multi-call groups. `modelMetrics`
reports actual annotation, follow-up and result requests, elapsed time, and prompt tokens for the
current comparison. `resultInterpretation` reports evidence batches and cache
reuse; `resultEvidence` contains per-run claims, citations and coverage;
`scoreAttribution` explains cohort sufficiency and any fitted predictor.
A cache hit does not claim fresh model cost.

## API

- `GET /health` reports service and framework versions.
- `GET /api/pattern-policy` reports the prompt and framework versions.
- `POST /api/prov-graph` accepts `{traceId, toolCalls, taskId?,
  taskDescription?, finalOutput?, targetCallIds?}` and returns the mechanical
  `dag`, cached `analysis`, and a cache status. `analysis.analysisKey` can be
  sent as a lightweight reference to a previously analyzed trace.
- `POST /api/joined-provenance-graph` accepts selected `graphs`, optional
  `referenceCohort`, `detail` (`overview` or `all`), and `focus`. Each selected
  graph carries its own `targetCallIds` along with trace, task, score, and raw
  call data. Reference entries use `{traceId, analysisKey, taskId, score,
  scoreMetric, tools}`. Matching cached analyses supply semantic-pattern
  features; tool-name summaries from all entries supply global tool features
  locally. The response includes
  per-trace witnesses, outcome summaries, `compression`, `modelMetrics`, and
  explicit cache coverage counts.
- `POST /api/validate-path` checks a requested stage path against compatible
  per-trace witnesses.
- `POST /api/tool-sets` groups exact tool names for display.
- `POST /api/provenance-agent` serves the evidence-backed streaming assistant.

Malformed input returns 422. Invalid model output returns 502. The Next.js
`/api/provenance-dag` proxy forwards to backend `/api/prov-graph`.

## Cache and evidence limits

Cache files live under `agent_provenance_react/.cache/pattern-framework/`.
Per-trace analyses are keyed by normalized source calls, task description,
final output, and `pattern-abstraction-v3`. Semantic annotations are keyed by
prompt version, model, and focus. Selection-specific targets, scores, and
visible detail are applied when projecting the cached analysis. Follow-up
assessments are cached per source analysis and semantic policy under
`reasoning-links/`; their exact compact request cards are in `reasoning-prompts/`.
Their cache key uses calls and template policy, so changing the final answer
alone does not invalidate thought links. Final-claim assessments are cached
under `result-evidence/` by model/prompt, final answer, source arguments,
recorded parents and outputs;
bounded requests are inspectable locally under `result-prompts/`. Score model
memoization uses canonical task, metric, score and family-presence data only.

Recorded parents are direct trace evidence; resource references show a
possible data handoff and may be ambiguous when resources lack versions or
write semantics. Model-assigned stage labels are interpretations, not source
facts. Outcome statistics use only supplied or cached reference traces with
matching task and metric. Missing traces remain unknown, median ties are left
out of high/low contrasts. Frequency contrasts are descriptive; predictive
attributions are explicitly identified and do not establish causality.
If a trace has no explicit final artifact reference, its last call is not
automatically treated as the result. Select a result in the UI to highlight
its recorded ancestor paths. Copied values without resource or parent links
can leave disconnected stages. Inferred follow-up links explain supported
subject continuity without relabeling it as a recorded handoff. They are
model interpretations, not evidence of the agent's actual internal reasoning.

## Explicit multi-agent workflows

`POST /api/import-workflows` accepts native `workflow-events-v1` records or the
supported raw chemistry runs. It stores full runs locally and returns a small
manifest. `GET /api/workflow-corpora` lists saved corpora;
`GET /api/workflow-corpora/{corpusId}` opens a manifest. Existing graph endpoints
accept its `workflowRef` and load only the selected runs. Set `laneBy` to `agent`
or `role` when requesting or validating a joined view.

Native records declare `participants`, `events`, `eventLinks`, and optional
numeric, source-anchored `outcomes`. Other domains may use their own activity
types. Ordinary calls carrying `agentId` or `role` also receive participant lanes;
explicit `parentCallIds` retain their dependencies. The core does not infer
dependencies from coincident numbers or chronological order. Rounds are stored
zero-based; the UI and Copilot tools expose one-based round numbers.

The chemistry adapter bundles selection, candidate rationale, context evidence,
and offline evaluation in an `experiment`. Publication and each recipient's
reception remain separate activities. Candidates and prompt exposures are nested
evidence, and outcomes annotate the experiment that produced them. A terminal
outcome can separately record `observedThroughRound`; it does not relocate the
source experiment to the end of the run.

`workflowInsights` is computed locally: communication gaps at the recorded round
precision, source/transport payload mismatches, matched-context exposure coverage,
terminal outcomes, bounded witness paths, and recurring explicit evidence-use →
work → publication motifs. Motifs are skill candidates, with prerequisites,
procedure, source examples, and limitations. Delivery, exposure, predictive score
association, and demonstrated causal benefit remain distinct. Final-result
backbones use system/terminal anchors rather than every participant improvement.

Workflow model fits are reused for unchanged reference cohorts. The outcome score
is task/metric specific; constant or insufficient data stays unavailable, while
weak fits remain exploratory. Corpus import and local workflow insights require
zero new LLM requests. The first semantic workflow view uses cached, bounded Gemini
3.8 Flash calls after local BM25 retrieval from source-anchored final results.
Only retrieved occurrences are assessed from actual arguments, output and recorded
relationships; unvisited occurrences remain explicitly unreviewed. Each selected
run has at most two retrieval rounds, with 48 occurrence cards and
24,000 prompt characters per round. Independent participant outcomes and earlier
result milestones supplement the final result as review targets. Direct inputs
are ranked using the selected action's rationale and balanced across target and
relation, so similar local experiments cannot crowd out relevant peer messages.
The model may request further local searches
and expand key predecessors; unchanged rounds reuse their cache. Neither event type nor tool name
sets importance. Subsequent joins reuse unchanged context assessments. Malformed
model output fails validation. The sparse response explicitly defaults omitted
activities to `unknown`; omission in a later round does not erase an earlier
explicit judgment. The model must explicitly revise it. Unreviewed activities
remain distinct from reviewed but uncertain activities in source assessments.
Each evidence card reserves space for the activity's own structured arguments,
textual rationale and real output before adding retrieved historical context.
Selection uses source structure and query relevance, without tool-specific field
names or event-category importance rules. All snippets retain actual source paths.

`workflowAssessment` includes per-event `key` / `supporting` / `unknown` decisions,
source citations, relevance of explicit evidence-use links, and joint input groups.
Source evidence is sent under opaque references with its actual source path.
Explicit parents and semantic retrieval candidates remain distinguishable. Retrieval
limits are reported as partial coverage, without deleting unreviewed parents or
silently judging them unimportant. The source graph keeps
every activity and aligns equivalent observed parameters across runs. Routine
parallel siblings in the same lane and round can share a compact point only when
they have identical downstream ports; original occurrences and link witnesses
remain individually inspectable. Publication → reception → consuming activity retains literal endpoints;
no maximum-parent pruning or time-window grouping is applied. Pinned canvas
positions survive selection changes; new automatic slots reflow without overlap.
Isolated workflow filters use a separate compact layout over the retained rounds;
the complete canvas retains its manual positions and viewport.
The default overview retains all activities and connections. Result anchors,
key activities and reviewed evidence chains use readable cards; other context
uses compact dots. Literal transport into reviewed evidence is highlighted
without changing the model's semantic importance judgment of its sender.
Locate result frames the run-scoped reviewed chain locally, without a model
request. Known node dimensions and handles let the canvas mount only the visible
area while preserving offscreen history. The header separates review rounds,
cache reuse and new model requests. Terminal results retain their original round;
an initial-round result is not attributed to later communication. Per-run coverage,
remaining frontier and stop reasons distinguish a completed backward path from a
bounded or incomplete review. Relevant links between supporting activities remain
in the overview so they do not break a key result path.
Gemini Copilot retrieves bounded assessments and joint contexts on demand.

`experiments/iterate_provenance.py` checks real Discovera and Suzuki selections,
call and dependency coverage, abstraction, cache reuse and timings. It is
cache-only by default; `--live` explicitly enables new gateway requests.
`experiments/verify_context_projection.mjs` checks the actual canvas projection,
expansion, routing and viewport geometry against saved graphs. The measured
iteration comparison is in `experiments/results/provenance-iteration-comparison.json`.

## Verification

Run from the repository root:

```sh
.venv/bin/python -m pytest
cd agent_provenance_react
npm run lint
npx tsc --noEmit
npm run build
```

Backend tests mock semantic model responses and check source evidence,
multi-call grouping, cache reuse, cohort missingness, and witness validity.

For a measured comparison on the real 5.1 run and two other cached baseline
traces, run `experiments/benchmark_abstraction.py --output <report.json>` with
the repository Python environment. It makes real gateway requests using compact
operation-type cards, measures independent cold runs, a cold batch, cold
incremental selection and warm reuse, and records multi-call quality checks.
Its rule caches are isolated and removed afterward. Policies and exact prompts
are saved beside the report for review, without replacing application rules.
`experiments/results/abstraction-before.json` contains historical model request
durations, not old end-to-end wall times. See
[the iteration results](../experiments/README.md) for three measured prompt
iterations, the five-trace batch, production cache checks, and limitations.
