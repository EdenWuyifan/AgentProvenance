"""Shared skill-induction requirements, independent of tools and trace format."""

GENERATOR_VERSION = 'awm-derivation-v1'

DERIVATION_PROMPT = '''Additional requirements for every summary workflow:
Explain how the workflow's inputs and task rules produce the values used by later steps.
Use these concise sections: Purpose; Inputs; Rule; Steps; Check; Evidence; Unknowns.
In Rule, describe the actual matching, combination, calculation or selection operation in
reusable variables. Preserve scope, negation, ordering and eligibility conditions. Do not
replace the central computation with <updated_content>, <selected_items>, or a reminder
to inspect, combine or validate. Explain how that value is formed from its operands.
Keep prerequisite branches before their consumer. Steps can include a computation that
explains a recorded argument, but must not claim an unobserved tool was executed.
Separate a requirement stated in the source task from an observed implementation and
an inferred explanation. Graph annotations are hypotheses; check them against the supplied
observations and consumer arguments. Shared observation refs copy the earlier payload;
they never establish that two occurrences have the same entity identity.
In Check, give a concrete predicate over inputs and the produced result; an API success
acknowledgement alone does not establish task correctness. Check prerequisites before use.
In Evidence, cite source example numbers and recorded step IDs, or the source Query/context
for a task requirement. State missing inputs or unresolved derivations under Unknowns.
Abstract source-specific accounts, resource IDs and outcome values into variables. Do not
copy an old result as the answer for a future run. Do not invent a rule or hidden operand
to make a workflow appear complete. A complete multi-input procedure is more useful than
several overlapping API checklists. Respect the existing workflow and output limits.
'''
