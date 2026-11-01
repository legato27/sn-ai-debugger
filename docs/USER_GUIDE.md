# ServiceNow AI Debugger — User Guide

2026-10-29 · Joseph · Version 0.5.0

## Overview

ServiceNow AI Debugger is a Chrome side panel that tells you why an AI Agent run, agentic workflow, tool or Now Assist skill failed, in seconds, without leaving the instance. You give it a record (or open one), and it gathers the configuration and logs around it, runs a set of fixed rules, and shows the most likely root cause with a suggested fix. If you add an Anthropic API key, Claude can also write up the analysis and answer follow-up questions.

It is built for platform owners, architects and developers who debug AI Agent Studio and Now Assist on their own or a customer's sub-production instance.

What it reads, all through your own logged-in session:

- **The run:** execution plan, execution tasks, agent messages, tool executions, and the Virtual Agent conversation transcript the run belongs to.
- **The configuration:** agent, tool bindings, the script include, flow or action behind each tool, ACLs, and the roles of the user the agent runs as.
- **The logs around the run:** Generative AI log, system log warnings and errors, outbound HTTP calls, flow executions, restricted caller access records, AI Guardian tables.
- **The platform:** versions and active state of the AI store apps.

Three guarantees hold for every trace:

1. **Read-only.** The extension only sends GET requests, and only to the Table API and Stats API. It cannot create, change or delete anything itself. Optional stop actions hand you a script that you review and run on the instance.
2. **Your access, nothing more.** Requests run inside your ServiceNow tab with your session, so ACLs apply exactly as they do for you.
3. **Nothing leaves your browser by default.** There is no server. Exports are files you choose to copy or download. The one opt-in exception is Claude analysis, which sends a redacted summary to Claude under your own API key.

The only thing that touches the instance is the GET call from your own tab; collecting evidence, ranking causes and redacting exports all happen inside the browser. Claude analysis, if you turn it on, is a separate step after this.

## Before you start

You need Chrome 116 or later, a signed-in session on the instance, and read access to the AI tables you want to trace. Start on sub-production.

| What | Why it matters |
| --- | --- |
| Chrome 116+ | The side panel API needs it. Edge and other Chromium browsers with side panel support should work but are untested. |
| Signed in to the instance | The extension borrows your session. It never asks for or stores credentials. |
| Read access to `sn_aia_*`, `sys_generative_ai_log`, `syslog` | Without it, sections come back empty or marked *forbidden*. |
| Read access to `sys_dictionary` and `sys_db_object` | The trace discovers related tables and reference fields from the dictionary. Without it, it falls back to documented names and is less complete. |
| HR admin role, for HR use cases | HR-related Gen AI log rows are visible only to HR administrators. |

An admin on a sub-production instance sees everything, so it gives the fullest trace. Admin can also read records that the agent's run-as identity cannot, so confirm the fix by reproducing as that user.

On customer instances, check the customer's security policy before you install an unpacked extension in a browser that holds their session.

## Install

Installing takes about a minute and is done once per browser profile.

1. Unzip `sn-ai-debugger.zip` into a folder you will keep. Chrome loads the extension from that folder, so don't delete or move it.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the unzipped folder (the one that contains `manifest.json`).
5. Click the puzzle icon in the toolbar and pin **ServiceNow AI Debugger**.

The extension works on `*.service-now.com` and `*.servicenowservices.com` straight away. For a custom domain, such as `servicedesk.example.com`, open the instance, open the panel and click **Allow this domain**. Chrome asks you to confirm, and the permission covers that one domain only.

To update, replace the folder's contents with the new version and click the reload icon on the extension's card in `chrome://extensions`.

## Run a trace

The fastest way in is to open the failing record in ServiceNow and click **Use this page**. Click the extension icon on a ServiceNow tab to open the panel; the header shows the instance once it is connected.

There are three ways to start:

1. **Use this page** traces the record open in the current tab. Classic forms, Next Experience URLs and workspace record URLs all work.
2. **Trace** takes whatever you type in the box: a sys_id, a record URL, a plan number or part of a name. Press Enter or click the button.
3. **Recent runs** lists the latest 20 execution plans. Click **Trace** next to the one you want.

What each input traces:

| You give it | It collects |
| --- | --- |
| Execution plan sys_id or number | Tasks, messages and tool executions → the agents and workflow involved, with tools, ACLs and run-as roles → Gen AI log, system log, outbound HTTP, flows, restricted caller access and AI Guardian rows in the run's time window → AI app versions |
| Execution task, tool execution or message sys_id | Finds the parent plan, then traces it as above |
| AI agent sys_id or name | Agent configuration, tool bindings and what each tool calls, ACLs, run-as roles, workflows that use the agent, recent plans, and description overlap with other active agents |
| Agentic workflow sys_id or name | Team agents with their configuration, triggers, recent plans |
| Tool sys_id or name | The script include, flow or action behind it, the agents it is bound to, recent executions |
| Now Assist skill or prompt sys_id or name | Related prompt and capability records, recent Gen AI log runs of the skill, usage count, system log around the latest run |
| Gen AI log sys_id | The call, its skill and prompt records, logs around it |
| VA conversation sys_id | The plans in that conversation; traces the latest |
| Any other text | Name search across agents, workflows, tools, skills and plans; pick a match to trace it |

A typical plan trace makes 60 to 80 read-only calls and finishes in a few seconds. The progress line under the buttons shows what it is doing and the call count when done.

Tip: start from the **execution plan** whenever you can. It is the only entry point that ties config, run and logs together. When a user reports "the agent didn't work", use **Recent runs** or trace the agent and pick its latest plan.

## Read the results

Read the panel top to bottom: the root cause card tells you what to fix first, and everything below is the evidence for it.

| Card | What it shows | How to use it |
| --- | --- | --- |
| Warnings | Things the trace could not do, such as an unreadable table or an ID it couldn't find | Fix access or the input before trusting the findings |
| Matches | Candidates from a name search | Click **Trace** on the right one |
| Traced | Record type, display value, table, and the UTC log window used | Check it traced what you meant |
| Most likely root cause | The finding closest to the cause, with detail and a fix | Start here. **Also check** lists up to three other likely causes, because a run can fail for more than one reason |
| Findings | Every rule that fired, sorted by severity | Click a severity chip to hide or show that level |
| Execution plans | Recent plans for an agent, workflow or conversation | Click **Trace** to drill into one run |
| AI app versions | Scope, version and active state of the AI store apps | Compare with the store and your patch level |
| Evidence | One expandable group per table read, with row count and status | Click a record name to open it in a new tab; expand **fields** to see the raw values |

The **Conversation timeline** card puts the whole run in time order, so you can read it the way the user lived it:

| Entry | Colour | What it shows |
| --- | --- | --- |
| User | Blue | What the user typed in Virtual Agent or the assistant panel |
| Virtual Agent | Green | What the user saw back, including cards and buttons |
| Agent message | Grey | Messages inside the execution plan (user request, orchestrator and agent replies) |
| Task | Grey | Each execution task and its state |
| Tool call | Grey | Tool name, input, output, state and duration |
| LLM call | Grey | Skill or source, the model's response and state |
| Error | Red | Error-level system log lines and failed flows during the run |

Click a name to open that record in a new tab. Long text folds; click it to expand. If the plan has no linked conversation (a triggered run, or a test in AI Agent Studio), the card says so and shows the rest of the run. To start from the conversation instead, paste its sys_id: the trace reads the transcript and then the latest plan in it.

The root cause is ranked by how close a finding usually sits to the cause, not by severity alone. A failed plan is almost always a symptom, so a tool input mismatch or a broken script include outranks it even when the plan failure is marked Critical.

Severity means:

- **Critical:** something in the chain failed or is missing.
- **High:** a likely cause or a serious risk, such as an access gap, an empty tool result or a supervised tool on an unattended run.
- **Medium:** degraded behaviour or a design smell, such as loops, slow tools or overlapping agent descriptions.
- **Info:** context, such as tracing as admin.

Status labels on evidence groups: *forbidden* means your user can't read that table, *missing* means the table isn't on this instance, *error* means the request failed. An empty group with no label simply had no rows.

## Analyse with Claude

Claude analysis turns the trace into a written root cause, causal chain, fix and verification steps, and lets you ask follow-up questions about the same run. It is optional and off until you add your own Anthropic API key.

1. Open settings (gear icon), paste your **Anthropic API key** and pick a **Model**. Claude Opus 5.5 is the default; Sonnet 5.5 is faster, Haiku 5.5 is cheapest, Fable 5.1 is for the hardest cases.
2. Run a trace. A **Claude analysis** card appears under the findings.
3. Click **Analyse with Claude**. The first time, a confirmation shows the payload size, the model, and whether bodies are included. Expand **Preview what is sent** to read the exact JSON. Click **Send**, or tick **Don't ask again** first.
4. The answer streams in with five parts: Root cause (with confidence), Causal chain, Fix, Verify, and Gaps.
5. Type a follow-up in the box under the answer and press Enter, for example "Which ACL change is the smallest safe fix?" The evidence is sent once; follow-ups reuse it.
6. Click **Stop** to cancel a long answer. Token usage shows under the card.

No API key? Click **Copy prompt for claude.ai**. It copies the same redacted prompt and opens a new claude.ai chat for you to paste it into.

Claude gets the rule engine's findings as a starting point and is told to agree or disagree with them, cite rule IDs and sys_ids for each step, and say what evidence is missing. Treat its answer as a second opinion: check the cited records before changing anything.

| Sent to Claude | Not sent by default |
| --- | --- |
| Plan, tasks and tool executions (state, errors, timings) | Prompt and response text |
| Agents with description, instructions, tools, run-as roles and ACLs | Tool input and output values |
| Gen AI log entries (state, errors, skill, guard flags) | Agent and user message text |
| System log lines, failed HTTP calls, flow failures, restricted caller access | Your name and the full role list of your user |
| AI app versions and the rule findings | Raw records from each table |

Everything sent is redacted (emails, NRIC/FIN, phone and card numbers, tokens) whatever the export setting says. The evidence is wrapped as untrusted data, and Claude is told never to follow instructions inside it, because record text on an instance can contain prompt injection. Tick **Send prompt, response and tool input/output bodies** only when the answer needs them; they are still redacted and cut to about 1,200 characters each.

## Stop AI Agent processing

Stop actions give you a ready-made Scripts - Background snippet that cancels a run, cancels stuck runs, or deactivates an agent. The extension never runs it: you review it on the instance and click Run yourself. The feature is off until you tick **Offer "stop" scripts** in settings, and running the script needs the admin role.

Try the supported controls first: **Cancel** on the agentic workflow card, **Deactivate** in AI Agent Studio, or the AI Control Tower kill switch. Use a stop script when those aren't reachable or a run is stuck where the UI can't cancel it.

| Action | Offered when you trace | What the script does |
| --- | --- | --- |
| **Stop this run** | An execution plan, task, tool execution or message | Cancels the plan and its open child records (tasks, tool executions and any other `sn_aia` table that references the plan) |
| **Stop stuck runs (n)** | An agent, workflow or conversation | The same for each recent plan still open after the stuck threshold in settings. The count shows how many qualify |
| **Deactivate this agent / workflow** | An agent or workflow | Sets it inactive so the orchestrator stops using it. Plans already running are not cancelled |

To use one:

1. Trace the run, agent or workflow.
2. On the **Stop AI Agent processing** card, click the action. Read the description and the script.
3. Click **Open in Scripts - Background**. A new tab opens on the same instance with the script filled in (it is also copied to your clipboard).
4. Click **Run script**. The first run is a dry run: it prints every record it would change, with old and new state, and changes nothing.
5. If the output is right, change `DRY_RUN = true` to `DRY_RUN = false` at the top of the script and run it again.
6. Trace the run again to confirm it is cancelled.

Safeguards built into every script:

- **Dry run first.** `DRY_RUN = true` is the default.
- **Instance lock.** The script aborts if the instance name doesn't match the one it was generated for, so a script pasted into the wrong instance does nothing. On a custom domain, set `EXPECTED_INSTANCE` to the value of the `instance_name` property.
- **No guessed states.** It uses each table's own "cancelled" choice. If a table has none, it skips that table and says so; set `CANCEL_STATE` to force a value.
- **Final states left alone.** Records already complete, failed or cancelled are skipped.
- **Cap.** It changes at most 200 records (`MAX_RECORDS`).
- **Audit.** Everything it does is printed and written to the system log with the tag `[SNAI-STOP]`, and records are updated with business rules and auditing on.
- **Flows off by default.** Waiting or running flow contexts from the run window are listed in the script, but only cancelled if you set `CANCEL_FLOWS = true`. They are matched by time, so check each one belongs to the run first.

## Brazil release support

Version 0.5.0 reads the instance release and patch and checks the Brazil changes that most often break AI agents. The release shows on the **Traced** card.

| Brazil change | What the extension checks | Rule |
| --- | --- | --- |
| Deny-by-default access for `gen_ai_agent`, `gen_ai_workflow`, `gen_ai_skill`, `Flow` and `flow_action` on newly activated instances | Whether each agent, workflow, skill, and each flow or flow action behind a tool has its own ACL, and whether the type's wildcard ACL has Security Attribute "Never" | AI-ACL-MISSING |
| Kill Switch for runaway triggers (`kill_switch.mode`: off, warn_only, enforce) | The same objective running 5+ times in 24 h, triggers left inactive in enforce mode, and protection switched off | RUNAWAY-TRIGGER, TRIGGER-DISABLED, KILLSWITCH-OFF |
| Agent2Agent flow actions no longer add the Bearer prefix | A hint on HTTP 401 failures | HTTP-ERR |
| New tables: `sys_generative_ai_prompt_config`, `sn_aia_property`, `sn_aia_external_agent_configuration` | Collected when they reference the traced record | — |
| Now Assist renamed ServiceNow Otto | Skills are labelled "AI skill (Now Assist / ServiceNow Otto)" | — |

The stop card adds **Deactivate trigger** for workflows, which does what the Kill Switch does in enforce mode. If the release can't be read (no access to `sys_properties`), RELEASE-UNKNOWN fires and the ACL findings drop to Medium.

## Playbooks

Each playbook names the symptom, where to start, and which findings to look for.

### The plan is stuck or never finishes

1. Trace the plan (**Recent runs** if you don't have the sys_id).
2. Look for **PLAN-STUCK** and **PLAN-NOTASKS**. No tasks means the orchestrator never handed the work to an agent.
3. With no tasks: check **AGENT-INACTIVE**, **ACL-ROLEGAP** and **DESC-OVERLAP**, then the AI app versions card against the store.
4. With tasks: check **SUPERVISED-UNATTENDED** (a tool waiting for an approval nobody will give) and **FLOW-WAIT** (a subflow waiting).

### A tool returns nothing, or the agent says it "couldn't find" data that exists

1. Trace the plan and open the **Tool executions** evidence group.
2. **TOOL-INPUT-CASE** means the agent sent `employeeid` where the tool expects `employeeId`, so the tool got an empty value. Align the names.
3. **TOOL-EMPTY** with **SYSLOG-ACL** or **ACL-ROLEGAP** means an access problem. Impersonate the run-as user and run the same query.
4. **RCA-DENIED** means a cross-scope call was blocked. Editing the calling script can invalidate an earlier approval.

### A tool fails with an error

1. **TOOL-ERR** shows the error text. **SYSLOG-TOOL** shows matching script errors from the system log.
2. **TOOL-DEP-BROKEN** or **TOOL-DEP-INACTIVE** means the script include, flow or action behind the tool is missing or off, often because it wasn't captured in the update set.
3. **HTTP-ERR** or **FLOW-ERR** point at a spoke or subflow behind the tool.

### The LLM step fails or returns nothing

1. Trace the plan, the skill, or the Gen AI log record directly.
2. **GENAI-ERR** includes a targeted hint. `resolveModelConfig` or OneExtend errors point at capability routing and plugin versions, which have broken after platform hotfixes before. Throttling, timeout and context-length errors each get their own hint.
3. **GENAI-EMPTY** or **GUARD** suggest AI Guardian blocked the response or the grounding fields were empty.
4. **GENAI-NONE** means no log rows were found. Widen the log window, or re-run as a user who can read HR log entries.

### The orchestrator picks the wrong agent, or none

1. Trace the agent or the workflow.
2. **DESC-OVERLAP** flags sibling agents whose descriptions are too similar to tell apart.
3. **INSTR-UNBOUND** flags tools named in the instructions that aren't bound, and **NO-TOOLS** flags an agent with nothing to call.

### It works in AI Agent Studio but fails in Virtual Agent or on a trigger

1. Check the **ADMIN** finding: Studio tests as you, and you may be admin.
2. Trace the agent and read its run-as user and roles. **RUNAS-ADMIN** and **ACL-ROLEGAP** apply here.
3. On triggered runs, **SUPERVISED-UNATTENDED** is the usual culprit.
4. Reproduce as the run-as user before closing the incident.

### The user saw something different from what the agent did

1. Trace the plan, or paste the VA conversation sys_id.
2. Read the **Conversation timeline** top to bottom. Find the first Virtual Agent turn that doesn't match the agent message, tool result or LLM response just before it.
3. **VA-REASK** means the bot asked the same thing three or more times: the topic or agent isn't using the answer the user already gave.
4. **VA-FAULT** means a runtime error closed the conversation. Look at the red Error entries just before the last bot message.

## Settings

Open settings with the gear icon in the panel header. Changes save in this browser and apply to the next trace.

| Setting | Default | Range | When to change it |
| --- | --- | --- | --- |
| Log window (± minutes) | 2 | 0–60 | Widen it when GENAI-NONE fires or logs look missing; narrow it on busy instances where unrelated errors crowd the system log |
| Rows per table | 50 | 5–500 | Raise it for long runs with many tasks or messages |
| Plan counts as stuck after (minutes) | 5 | 1–1440 | Raise it for agents that legitimately run long |
| Redact PII in exports | On | — | Turn off only for your own sub-production data |
| Include prompt and response bodies in exports | Off | — | Turn on when the reader needs the actual prompt; bodies are cut to 1,500 characters and still redacted |

The log window applies to records that have no direct link to the run, such as system log rows. It is matched on created time in UTC. Records linked by reference, such as tasks and tool executions, are always collected in full up to the row limit.

The Claude settings sit under **Claude analysis (optional)** in the same panel.

| Setting | Default | When to change it |
| --- | --- | --- |
| Anthropic API key | Empty | Paste a key to turn on **Analyse with Claude**. It is stored in this browser profile only, unencrypted; use a key from a workspace with a spend limit |
| Model | Claude Opus 5.5 | Sonnet 5.5 for speed, Haiku 5.5 for cost, Fable 5.1 when Opus can't settle a hard case |
| Send prompt, response and tool input/output bodies | Off | Turn on when the cause is likely in what the LLM or a tool actually received or returned |
| Ask me before each send to Claude | On | Turn off once you trust what is being sent; **Don't ask again** on the confirmation does the same |

Under **Stop actions (optional)**, tick **Offer "stop" scripts for runs, stuck runs and agents** to show the Stop AI Agent processing card. It is off by default. The stuck threshold above also decides which runs count as stuck.

## Export and share

Two buttons at the bottom of the panel turn a trace into something you can paste into an incident, a HI case or a chat with Claude.

| Button | Produces | Best for |
| --- | --- | --- |
| **Copy report** | Markdown on the clipboard: instance, who traced, root cause and other likely causes, findings table, agents and tools, tool executions, AI app versions, evidence counts, warnings | Incident notes, Teams or Slack, a HI case, asking Claude for a second opinion |
| **Download evidence** | A JSON file with the full evidence and the findings | Attaching to a ticket, comparing two runs, deeper analysis |

With redaction on (the default), exports mask:

- email addresses
- Singapore NRIC and FIN numbers
- phone numbers and card-like digit runs
- JWTs, API keys and `password=` / `token=` style values
- your full name

Prompt, response, input, output and message bodies are replaced with a character count unless **Include prompt and response bodies** is on. sys_ids, timestamps, states and table names are kept so the report stays traceable.

Redaction is pattern-based, so it will not catch a name written in free text or a customer-specific ID format. Read the report before you send it outside your team.

If you asked Claude about the trace, both exports also carry the conversation: the report adds a **Claude analysis** section with each answer and follow-up question, and the JSON file adds the model and transcript. The evidence block sent to Claude is not repeated in either.

The report also includes the first 60 timeline entries with time, event, who, and state or error. The text column stays empty ("chars omitted") unless **Include prompt and response bodies** is on, because transcripts usually hold personal data.

## Rules reference

The extension ships with 40 rules. The rule ID shows under each finding, so you can look it up here.

| Rule ID | Severity | Fires when | First fix |
| --- | --- | --- | --- |
| TOOL-DEP-BROKEN | Critical | A tool points to a script include, flow or action that is missing or unreadable | Restore or re-point it; check the update set |
| TOOL-MISSING | Critical | An agent's tool binding points to a tool that can't be read | Re-bind or restore the tool |
| TOOL-ERR | Critical | A tool execution failed or logged an error | Run the script or subflow with the same input and fix it |
| TASK-FAIL | Critical | An execution task failed | Open its tool executions |
| PLAN-FAIL | Critical | The plan ended failed or cancelled | Usually a symptom; fix the first failing step |
| GENAI-ERR | Critical | An LLM call failed (hints for resolveModelConfig, throttling, timeout, context length, guardrail) | Follow the hint |
| TOOL-INPUT-CASE | High | An input name differs from the tool's declared input only by case | Align names in the tool and the instructions |
| TOOL-EMPTY | High | A tool succeeded but returned an empty result | Impersonate the run-as user; check ACLs; use GlideRecordSecure |
| ACL-ROLEGAP | High | The run-as user (or you) has none of the roles on the agent's ACL | Grant the minimum role or correct the ACL |
| SYSLOG-ACL | High | Access-denied messages in the system log during the run | Grant the access, or approve the cross-scope call |
| SYSLOG-TOOL | High | System log errors name the agent's tools or scripts | Fix the script error |
| RCA-DENIED | High | A restricted caller access record is denied or pending | Approve it if intended, or move the code |
| SUPERVISED-UNATTENDED | High | A supervised tool on a triggered or background run | Make it autonomous or use an approval flow |
| PLAN-STUCK | High | Plan in a non-final state past the stuck threshold | Check tasks, flows and plugin versions |
| PLAN-NOTASKS | High | No execution tasks were created | Check agent active flag, ACL and description |
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
| TOOL-INPUT-MISSING | Medium | A declared tool input was not sent | Say in the instructions where the value comes from |
| INSTR-UNBOUND | Medium | Instructions name tools that aren't bound | Bind them or change the instructions |
| NO-TOOLS | Medium | The agent has no tools | Bind the tools the instructions rely on |
| DESC-OVERLAP | Medium | Two agents' descriptions overlap by 55% or more | Rewrite both to name distinct goals and triggers |
| LOOP-TOOL | Medium | Same tool called 4+ times with the same input | Add a completion condition and retry cap |
| LOOP-MSG | Medium | Same message 3+ times | Pre-fill from context; add a completion condition |
| TOOL-SLOW | Medium | A tool took more than 30 seconds | Progress message, async, or a narrower query |
| FLOW-WAIT | Medium | A subflow is waiting | Return an interim result or notify on completion |
| SYSLOG-AI | Medium | AI framework errors in the system log | Read them against the plan timeline |
| GENAI-NONE | Medium | No Gen AI log rows were found | Widen the window or use an HR admin |
| ADMIN | Info | You are tracing as admin | Reproduce as the run-as user |
| DICT | Info | The data dictionary is not readable | Trace with a user who can read it |

Conversation rules (added in 0.3.0):

| Rule ID | Severity | Fires when | First fix |
| --- | --- | --- | --- |
| VA-FAULT | High | The Virtual Agent conversation ended in a faulted or error state | Read the timeline around the last bot message and the system log at that time |
| VA-REASK | Medium | Virtual Agent sent the same message 3+ times | Make the topic or agent read the answer it has; add a fallback after two tries |
| VA-NOLINK | Info | No conversation is linked to the plan | Trace the conversation sys_id directly if the run came from Virtual Agent |

## Troubleshooting the extension

Most problems come from the session or from access, not from the extension.

| Symptom | Cause | Fix |
| --- | --- | --- |
| "ServiceNow rejected the session (401)" | The session expired or the page token is stale | Reload the ServiceNow tab, sign in, trace again |
| Buttons are greyed out | The active tab isn't a ServiceNow instance, or a custom domain isn't allowed | Switch to the instance tab; click **Allow this domain** if shown |
| "No sys_id in the current page URL" | The open page is a list, a home page or a Studio canvas without a record ID in the URL | Open the record form, or paste the sys_id |
| "sys_id … was not found in any AI table" | The record is in a table the extension doesn't know, or you can't read it | Paste the record URL instead (it carries the table name), or check access |
| Many evidence groups marked *forbidden* | Your user lacks read access | Trace as an admin on sub-production |
| DICT finding, few related records | `sys_dictionary` isn't readable | Same as above; the trace falls back to documented names |
| A table you expect is never shown | Its name differs on your release | Edit the table list in `lib/config.js`, then reload the extension |
| Findings look wrong for a field | Field names are matched by pattern (state, error, input, output) | Expand **fields** in the evidence group to see the raw values; report the field name |
| Panel doesn't open | The extension was disabled or its folder moved | Re-enable it in `chrome://extensions`, or load it again |

Claude analysis problems:

| Symptom | Cause | Fix |
| --- | --- | --- |
| **Analyse with Claude** is greyed out | No API key in settings | Add the key, or use **Copy prompt for claude.ai** |
| "Claude API 401 … Check the API key" | The key is wrong, revoked, or from another workspace | Paste a valid key |
| "Claude API 404 … model ID may not be available" | Your key can't use the chosen model | Pick another model in settings |
| "Claude API 429" or 5xx | Rate limit or the API is busy | Wait a moment and click **Analyse with Claude** again |
| "The answer hit the length limit" | The reply ran past 4,000 tokens | Ask "continue" as a follow-up |
| The answer ignores something you can see in Evidence | That field is a body left out by default, or it was truncated | Turn on **Send prompt, response and tool input/output bodies** and trace again |

To see what the panel is doing, right-click inside it, choose **Inspect**, and watch the Console. Each request also appears in the ServiceNow tab's Network panel as a GET to `/api/now/table/`.

## Limits and safe use

This is version 0.5.0. It has been tested against a mock instance, not yet against a live AI Agent Studio instance, so treat its findings as leads to confirm.

- **Table names.** These are documented by ServiceNow (Australia): `sn_aia_execution_plan`, `sn_aia_execution_task`, `sn_aia_message`, `sn_aia_agent`, `sn_aia_agent_tool_m2m`, `sn_aia_team_member`, `sn_aia_trigger_configuration`, `sys_generative_ai_config`, `sys_generative_ai_log`, `sys_gen_ai_usage_log`, `sys_one_extend_capability`. These are best guesses, checked on each trace and skipped if absent: `sn_aia_usecase`, `sn_aia_tool`, `sn_aia_tools_execution`, `sn_nowassist_skill_config`, `sys_cs_conversation` (and its message table, usually sys_cs_message), `sys_outbound_http_log`, `sys_flow_context`, `sys_restricted_caller_access`.
- **ACL check is role-only.** It does not evaluate ACL conditions or scripts.
- **ACL lookup is by name.** It finds ACLs whose name contains the agent's sys_id or internal name; ACLs configured another way won't show.
- **AI Guardian tables** are found by name (`guardrail`, `guardian`). If detections live elsewhere on your release, they won't appear.
- **Time window matching is in UTC.** Logs that have no direct link to the run are matched by time, so on a busy instance unrelated errors can appear.
- **Heuristic fields.** State, error, input and output are matched by field-name patterns; check the raw fields when a finding looks wrong.

Claude analysis has its own limits:

- **Tested against a mock** of the Messages API, not yet against the live API from Chrome.
- **A second opinion, not a verdict.** Claude only sees the compact summary, so check every cited record before you change the instance.
- **Data leaves the browser.** Even redacted, instance data goes to Anthropic under your key. Get the customer's agreement before you use it on their data, and keep bodies off unless you need them.
- **Key storage.** The API key sits unencrypted in this Chrome profile. Anyone with access to the profile can read it.

Stop actions have their own limits:

- **Tested against an in-memory mock** of the Glide APIs, not yet on a live instance. Always do the dry run first.
- **Direct write.** Setting a plan's state is not a documented API. The AI Agent runtime may still finish work it already started, such as a tool call in flight.
- **Flow cancel is unverified.** `sn_fd.FlowAPI.cancel` is used only when you switch it on.
- **Background scripts run with full rights.** Treat them like any other admin change: sub-production first, and follow your change process on production.

Safe use:

1. Prefer sub-production. The tool is read-only, but production data still flows into your browser.
2. Check the customer's policy before using it on their instance.
3. Keep redaction on for anything you share, and read the report before sending it.
4. Confirm every fix by reproducing as the run-as user, not as admin.
