package governance

# Agent authority rules.
#
# The rules here are fixed. What changes is data.governance.config, which the
# control plane uploads whenever an operator deploys new YAML. That split is the
# whole point: policy changes are data pushes, so nothing restarts and no
# in-flight authorisation is dropped.
#
# Spend caps are deliberately NOT enforced here. A cap needs a read-check-write
# against a shared counter to be correct under concurrency, and OPA has no
# transactional state. Caps live in the Redis reserve script instead. OPA answers
# "is this agent allowed to do this kind of thing at all", which is a pure
# function of the request and the policy.

import rego.v1

default decision := {
	"allow": false,
	"reason": "no rule matched; denying by default",
	"rule": "default_deny",
}

agent := data.governance.config.agents[input.agent_id]

# ---------------------------------------------------------------- denials

decision := {"allow": false, "reason": reason, "rule": "unregistered_agent"} if {
	not data.governance.config.agents[input.agent_id]
	reason := sprintf("No policy is registered for `%v`. Unregistered agents are denied.", [input.agent_id])
}

decision := {"allow": false, "reason": "Amount must be positive.", "rule": "amount_positive"} if {
	agent
	input.amount <= 0
}

decision := {"allow": false, "reason": reason, "rule": "known_action"} if {
	agent
	input.amount > 0
	not input.action in {"approve_refund", "approve_claim", "escalate"}
	reason := sprintf("Unknown action `%v`.", [input.action])
}

decision := {"allow": false, "reason": reason, "rule": "action_scope"} if {
	agent
	input.amount > 0
	input.action in {"approve_refund", "approve_claim", "escalate"}
	count(agent.allowed_actions) > 0
	not input.action in agent.allowed_actions
	reason := sprintf("`%v` agents may not perform `%v`.", [agent.type, input.action])
}

decision := {"allow": false, "reason": reason, "rule": "category_scope"} if {
	agent
	input.amount > 0
	action_permitted
	not category_permitted
	reason := sprintf(
		"Category `%v` is outside this agent's scope (%v).",
		[input.category, concat(", ", agent.allowed_categories)],
	)
}

decision := {"allow": false, "reason": reason, "rule": "single_transaction_cap"} if {
	agent
	input.amount > 0
	action_permitted
	category_permitted
	input.amount > agent.max_single_transaction
	reason := sprintf(
		"$%.2f exceeds the per-transaction limit of $%.2f.",
		[input.amount / 100, agent.max_single_transaction / 100],
	)
}

decision := {"allow": false, "reason": reason, "rule": "dual_control"} if {
	agent
	input.amount > 0
	action_permitted
	category_permitted
	input.amount <= agent.max_single_transaction
	threshold := agent.requires_dual_control_above
	is_number(threshold)
	input.amount > threshold
	reason := sprintf(
		"$%.2f is above the dual-control threshold of $%.2f and needs a human approver.",
		[input.amount / 100, threshold / 100],
	)
}

# ---------------------------------------------------------------- permit

decision := {"allow": true, "reason": "policy check passed", "rule": "permit"} if {
	agent
	input.amount > 0
	action_permitted
	category_permitted
	input.amount <= agent.max_single_transaction
	not dual_control_required
}

# ---------------------------------------------------------------- helpers

action_permitted if {
	input.action in {"approve_refund", "approve_claim", "escalate"}
	count(agent.allowed_actions) == 0
}

action_permitted if {
	input.action in agent.allowed_actions
}

category_permitted if {
	"all" in agent.allowed_categories
}

category_permitted if {
	input.category in agent.allowed_categories
}

dual_control_required if {
	threshold := agent.requires_dual_control_above
	is_number(threshold)
	input.amount > threshold
}
