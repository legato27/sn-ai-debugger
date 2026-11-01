# Rules reference

The rule ID shows under each finding in the panel. Rules live in [`lib/rules.js`](../lib/rules.js); each is a pure function of the evidence model, so it can be tested without an instance.

**Root-cause ranking.** Findings are sorted by severity, but the "Most likely root cause" is chosen by how close a rule usually sits to the cause (for example, `TOOL-INPUT-CASE` before `TOOL-ERR` before `PLAN-FAIL`). Up to three other close candidates appear under "Also check".

| Rule ID | Severity | Fires when | First fix |
| --- | --- | --- | --- |
| TOOL-DEP-BROKEN | Critical | A tool points to a script include, flow or action that is missing or unreadable | Restore or re-point it; check the update set |
| TOOL-MISSING | Critical | An agent's tool binding points to a tool that can't be read | Re-bind or restore the tool |
| TOOL-ERR | Critical | A tool execution failed or logged an error | Run the script or subflow with the same input and fix it |
| TASK-FAIL | Critical | An execution task failed | Open its tool executions |
| PLAN-FAIL | Critical | The plan ended failed or cancelled | Usually a symptom; fix the first failing step |
| GENAI-ERR | Critical | An LLM call failed (hints for resolveModelConfig/OneExtend, throttling, timeout, context length, guardrail) | Follow the hint |
| TOOL-INPUT-CASE | High | An input name differs from the tool's declared input only by case | Align names in the tool and the instructions |
| TOOL-EMPTY | High | A tool succeeded but returned an empty result | Impersonate the run-as user; check ACLs; use GlideRecordSecure |
| ACL-ROLEGAP | High | The run-as user (or you) has none of the roles on the agent's ACL | Grant the minimum role or correct the ACL |
| SYSLOG-ACL | High | Access-denied messages in the system log during the run | Grant the access, or approve the cross-scope call |
| SYSLOG-TOOL | High | System log errors name the agent's tools or scripts | Fix the script error |
| RCA-DENIED | High | A restricted caller access record is denied or pending | Approve it if intended, or move the code |
| SUPERVISED-UNATTENDED | High | A supervised tool on a triggered or background run | Make it autonomous or use an approval flow |
| PLAN-STUCK | High | Plan in a non-final state past the stuck threshold | Check tasks, flows and plugin versions |
| PLAN-NOTASKS | High | No execution tasks were created | Check the agent's active flag, ACL and description |
| GENAI-EMPTY | High | LLM returned a blank response with no error | Check AI Guardian and grounding fields |
| GUARD | High | AI Guardian flagged or blocked a call | Review the input and the guardrail mode |
| HTTP-ERR | High | Outbound HTTP calls failed during the run | Check credentials, endpoint, MID Server |
| FLOW-ERR | High | A flow or subflow failed during the run | Open the flow execution details |
| AGENT-INACTIVE | High | The agent is inactive | Activate it or remove it from the workflow |
| TOOL-INACTIVE | High | A bound tool or its binding is inactive | Activate it |
| TOOL-DEP-INACTIVE | High | A tool's script, flow or action is inactive | Activate it |
| SKILL-INACTIVE | High | The skill is inactive | Activate it in AI Admin Hub |
| PLUGIN-INACTIVE | High | An AI store app is inactive | Activate it or confirm it isn't needed |
| RUNAS-ADMIN | High | The agent runs as an admin identity | Use a least-privilege AI user |
| AI-ACL-MISSING | High (Medium if the release can't be read and no deny wildcard) | An agent, workflow, skill, flow or flow action has no ACL of its own (`gen_ai_agent`, `gen_ai_workflow`, `gen_ai_skill`, `flow`, `flow_action`). From Brazil, newly activated instances deny these by default; the detail says when the type's wildcard ACL has Security Attribute "Never" | Add an "Allow If" ACL for the component; confirm with Test access and Access Analyzer as a non-admin |
| TRIGGER-DISABLED | High | A trigger is inactive while `kill_switch.mode` is `enforce` | Fix the trigger condition, then re-activate it (resets the breach cycle) |
| RUNAWAY-TRIGGER | High | The same objective ran at least `kill_switch.max_fires_per_window` times (default 5) within `kill_switch.window_size` (default 1440 min) | Fix the trigger condition; deactivate the trigger or the agent to stop it now |
| VA-FAULT | High | The Virtual Agent conversation ended in a faulted or error state | Read the timeline around the last bot message and the system log at that time |
| TOOL-INPUT-MISSING | Medium | A declared tool input was not sent | Say in the instructions where the value comes from |
| INSTR-UNBOUND | Medium | Instructions name tools that aren't bound | Bind them or change the instructions |
| NO-TOOLS | Medium | The agent has no tools | Bind the tools the instructions rely on |
| DESC-OVERLAP | Medium | Two agents' descriptions overlap by 55% or more | Rewrite both to name distinct goals and triggers |
| LOOP-TOOL | Medium | Same tool called 4+ times with the same input | Add a completion condition and retry cap |
| LOOP-MSG | Medium | Same agent message 3+ times | Pre-fill from context; add a completion condition |
| VA-REASK | Medium | Virtual Agent sent the same message 3+ times | Make the topic or agent use the answer it has; add a fallback after two tries |
| TOOL-SLOW | Medium | A tool took more than 30 seconds | Progress message, async, or a narrower query |
| FLOW-WAIT | Medium | A subflow is waiting | Return an interim result or notify on completion |
| SYSLOG-AI | Medium | AI framework errors in the system log | Read them against the plan timeline |
| GENAI-NONE | Medium | No Gen AI log rows were found | Widen the window or use an HR admin |
| KILLSWITCH-OFF | Low | `kill_switch.mode` is `off` | Set it to `warn_only` (default) or `enforce` |
| ADMIN | Info | You are tracing as admin | Reproduce as the run-as user |
| DICT | Info | The data dictionary is not readable | Trace with a user who can read it |
| RELEASE-UNKNOWN | Info | The instance release could not be read from `sys_properties` | Trace with a user that can read it; release-specific rules use conservative severities |
| VA-NOLINK | Info | No Virtual Agent conversation is linked to the plan | Trace the conversation sys_id directly |

## Adding a rule

1. Add a block to `runRules()` in `lib/rules.js` that reads from `ev.norm` (normalised plan, tasks, messages, toolExecs, genaiLogs, syslog, http, flows, rca, agents, tools, skills, conversation, vaMessages) and calls `add(id, severity, category, title, detail, fix, evidence)`.
2. If it is a likely cause rather than a symptom, give it a low number in `CAUSAL_RANK`.
3. Add fixture data to `test/mock-instance.mjs` and an assertion to `test/collect-and-rules.test.mjs`, then run `npm test`.
