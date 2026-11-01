# Changelog

## 0.5.0 — 2026-10-31 (Brazil update)

- **Release detection**: reads the instance family and patch from build properties; shown in the panel, report and Claude payload.
- **Brazil deny-by-default ACLs**: collects all ACLs of types `gen_ai_agent`, `gen_ai_workflow`, `gen_ai_skill`, `flow`, `flow_action`; new rule AI-ACL-MISSING checks each agent, workflow, skill and the flows/flow actions behind tools, and recognises a wildcard ACL with Security Attribute "Never".
- **Kill Switch awareness**: reads `kill_switch.*` properties; new rules RUNAWAY-TRIGGER, TRIGGER-DISABLED, KILLSWITCH-OFF; new stop action **Deactivate trigger**.
- HTTP 401 hint for Agent2Agent calls (the Bearer prefix now belongs in the API Key credential).
- Tables from the Brazil upgrade notes: `sys_generative_ai_prompt_config`, `sn_aia_property`, `sn_aia_external_agent_configuration`; MCP store apps added to the version check.
- Skills labelled "AI skill (Now Assist / ServiceNow Otto)" to match the renaming.
- New rule RELEASE-UNKNOWN. 45 rules in total; 35 tests.

## 0.4.0 — 2026-10-31

- Opt-in **stop actions**: Scripts - Background snippets to stop a run, stop stuck runs, or deactivate an agent or workflow. Dry run by default, instance lock, cancel state from `sys_choice`, 200-record cap, `[SNAI-STOP]` audit log, flow cancel opt-in. The extension fills `sys.scripts.do` but never submits.
- Tests run the generated scripts against an in-memory Glide runtime.

## 0.3.0 — 2026-10-30

- **Conversation timeline**: Virtual Agent transcript, agent messages, tasks, tool calls, LLM calls and errors in one ordered view, with links to each record.
- Plan traces find the linked VA conversation; tracing a conversation sys_id pulls its transcript and latest plan.
- New rules: VA-FAULT, VA-REASK, VA-NOLINK.
- Timeline included in the report and (order, states, errors) in the Claude payload.

## 0.2.0 — 2026-10-29

- Optional **Claude analysis** with your Anthropic API key: streaming answer (root cause, causal chain, fix, verify, gaps), follow-up questions, consent with payload preview, always-on redaction, prompt-injection wrapping.
- **Copy prompt for claude.ai** for use without an API key.
- Exports include the Claude conversation.

## 0.1.0 — 2026-10-29

- First version: side panel, read-only trace by plan, task, tool execution, agent, workflow, tool, skill, prompt, Gen AI log or name; dictionary-driven discovery; 37 rules with root-cause ranking; redacted Markdown and JSON exports.
