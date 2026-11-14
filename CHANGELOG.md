# Changelog

## Unreleased (skill debugging quick wins)

- **Recent failures** replaces Recent runs: failed or stuck execution plans plus failed or user-rejected Gen AI log calls (skills included) from the last 7 days, newest first, each with its reason. With nothing failed, it lists the latest runs.
- **Evidence links**: every finding and the root cause show chips that open the records they were raised from; the Markdown report lists the root cause's records.
- **Skill table from the dictionary**: the skill table is read from the Generative AI log's skill reference field, so skill traces follow the instance's release; `sn_nowassist_skill_config` is now only the fallback.
- New rules: **SKILL-PLACEHOLDER** (template variables left in the final prompt), **SKILL-TRUNCATED** (answer hit the prompt config's max tokens or stopped for length), **SKILL-EMPTY-GROUNDING** (a labelled grounding field arrived empty or as a no-data value such as `null` or `[]`), **SKILL-QUICKMODE** (`com.glide.oneapi.fdih.async.quick.mode` hides skill flow execution details). Skill rules report once per skill with a count.
- Gen AI log calls now carry error code, model, token counts, output metadata and feedback; GENAI-ERR shows the error code and model, the timeline shows the model, and Claude receives them.
- Fixes: RELEASE-UNKNOWN no longer appears on list views; name searches report their API call count; the skill's AI-ACL-MISSING finding links to the skill.
### From a read-only check against a live instance (Australia patch 7)

- **Fix: dictionary references.** `sys_dictionary.internal_type` and `.reference` come back as `{ link, value }`, so no reference field was recognised on a real instance: no child → plan links, no tool dependencies, no skill → Gen AI log links. The schema reader now asks for plain values and unwraps either shape; the mock now answers like a real instance, so the old code fails 14 tests.
- **Fix: user name.** Next Experience pages expose only the user ID; the name is read from `sys_user`.
- **Terminated runs are failures.** `terminated` counts as failed and the plan's `state_reason` is read. New rule **PLAN-SECURITY** for runs stopped by an access check (Security Violation). `awaiting_input` no longer counts as stuck. GENAI-NONE stays quiet after a failed access check.
- **Agents and teams.** Agents are found through tasks' `target_document_table`/`_id` pairs, and workflow traces follow `workflow → team → team member`.
- **Less noise from the time window.** Flows count only when they are behind the run's tools; the rest are one Info line (**FLOW-NEARBY**). Access-denied and AI log lines count only when the run's own users wrote them. Gen AI log rows link through the conversation when there is no direct link.
- **Recent failures** queries failing and stuck plans on the server (state values from the Stats API), includes Gen AI `failed` status, shows error codes, explains "Success" messages on error rows, names runs by workflow or agent, and merges repeats with a count. On the live instance: 100 raw failures → 8 lines, 12 s → 4 s.
- **Token limits** follow `prompt_config_id` → prompt config → `sys_generative_ai_config.max_tokens`.
- **Speed.** Table probes are primary-key lookups, lists skip the row count, window queries fetch only the columns used: the `syslog` probe went from 8 s to well under a second, a plan trace from 19 s to 14 s.
- **Prompts stored as JSON.** The Gen AI log keeps the final prompt as a messages array with escaped newlines; the grounding checks unwrap it first.
- **SKILL-EMPTY-GROUNDING tuned on real prompts.** A blank label counts as empty only before the end of the prompt or a no-data field, not before a filled field (a section header) or another blank label (an output template). On 240 real skill calls the looser rule flagged 75, this one 1.
- **Trace a business record.** "Use this page" on an incident, HR case or evidence record lists the Otto activity on it (skill calls by `metadata_document`, the wrapper's nested calls, agent runs by `related_task_record`) and runs the skill rules over those calls. Workspace sub-record URLs trace the record on screen, not its parent, and a bare sys_id of a business record resolves through the Gen AI log. The timeline shows each call's action (`WWNA: Default` / `WWNA: Refine`).
- **Only the run's own errors.** Log lines count when they name a record of the run or come from its users' sessions (`sys_created_by`, `context_map._user`; agents' run-as users included, `system` excluded). They are queried directly, so the 200-row window sample cannot hide them. The timeline shows only those, repeats merged (×N); everything else goes to a collapsed **Background** card, the report and the Claude payload as grouped counts. On a live Gen AI log trace: timeline 61 → 4 events, 112 background errors grouped.
- **SYSLOG-RUN** replaces SYSLOG-AI: any error from the run, whatever its source (including Group Action Framework, `sn-gaf`), not only AI-named ones.
- **New rules SKILL-NO-INPUT and SKILL-NO-ANSWER** for calls that succeed but answer nothing: a request for missing input, or an acknowledgement or refusal. They show the run's own errors in the 10 s before the call (with a hint for `FDIH` flow-tool errors) and how many of the skill's last 20 calls gave the same reply. A reply the skill gives on every call is Medium ("never an answer"). Checked on 400 real replies: the only hits were the cases they target.
- **Gen AI log traces** include only the calls made with the traced one (same user ±5 s, or same record), not every LLM call in the window. Nested calls use ±5 s instead of ±15 s.
- **Background groups** join a short first line ("JavaScript evaluation error on:") with the next, so the group names the script.
- **Fix:** redaction no longer turns `KB0012345` or `INC0010001` into `[PHONE]`.
- 53 rules; 60 tests.

### Faster log extraction and navigation

Ideas from SN Utils' log viewer, record shortcuts and context menu, built for one run instead of the whole instance. No SN Utils code is used; its current source is closed.

- **Run logs card.** Every system log line from the run at every level (Error, Warning, Info, Debug), oldest first, with level filters, a text filter on message, source or user, **Copy** (plain text, redacted when redaction is on) and **Open in System Log** (the platform list with the same filter, all levels). The report adds the first 80 lines; Claude gets up to 30 info and debug lines next to the warnings and errors. On a live skill call: 37 lines, the same 37 the System Log list shows, against 4 timeline events before.
- **Jump bar.** One chip per result card in the sticky header, with counts; the chip of the card in view is highlighted.
- **Right-click and shortcuts.** "Trace this page", "Trace the linked record" and "Trace "<selection>"" on ServiceNow pages; Alt+Shift+T traces the current page, Alt+Shift+D opens the panel. New permission: `contextMenus`.
- **Flow executions open in Flow Designer's execution view** (Workflow Studio on newer releases) instead of the `sys_flow_context` form.
- **Fix: Fatal log lines** (level 3) were not read. They now count as errors in the timeline, the rules and Background.
- **Fix: async skill work belongs to the run.** Lines written as the caller (`sys_created_by`) but running as `system` (GenAI preprocess, request validators, the Flow Designer callback) now link to the run.
- The run's warnings and errors, its info and debug lines and the window sample are fetched in parallel.
- 70 tests.

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
