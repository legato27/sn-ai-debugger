# User guide

SN AI Debugger is a Chrome side panel that tells you why an AI Agent run, agentic workflow, tool or Now Assist skill failed, without leaving the instance. You give it a record (or open one); it gathers the configuration and logs around it, runs a set of fixed rules, and shows the most likely root cause with a suggested fix. With an Anthropic API key, Claude can also write up the analysis and answer follow-up questions.

It is built for platform owners, architects and developers who debug AI Agent Studio and Now Assist, ideally on sub-production.

**Contents:** [Before you start](#before-you-start) · [Install](#install) · [Run a trace](#run-a-trace) · [Read the results](#read-the-results) · [Analyse with Claude](#analyse-with-claude) · [Stop AI Agent processing](#stop-ai-agent-processing) · [Playbooks](#playbooks) · [Settings](#settings) · [Export and share](#export-and-share) · [Troubleshooting](#troubleshooting) · [Limits and safe use](#limits-and-safe-use) · [Rules reference](RULES.md)

## What it reads

All through your own logged-in session:

- **The run:** execution plan, execution tasks, agent messages, tool executions, and the Virtual Agent conversation transcript the run belongs to.
- **The configuration:** agent, tool bindings, the script include, flow or action behind each tool, ACLs, and the roles of the user the agent runs as.
- **The logs around the run:** Generative AI log, system log warnings and errors, outbound HTTP calls, flow executions, restricted caller access records, AI Guardian tables.
- **The platform:** versions and active state of the AI store apps.

Three guarantees hold for every trace:

1. **Read-only.** The extension only sends `GET` requests, and only to the Table API and Stats API. It cannot create, change or delete anything itself. Optional stop actions hand you a script that you review and run.
2. **Your access, nothing more.** Requests run inside your ServiceNow tab with your session, so ACLs apply exactly as they do for you.
3. **Nothing leaves your browser by default.** There is no server. Exports are files you choose to copy or download. The one opt-in exception is Claude analysis, which sends a redacted summary to Claude under your own API key.

## Before you start

| What | Why it matters |
| --- | --- |
| Chrome 116+ | The side panel API needs it. Other Chromium browsers with side panel support should work but are untested. |
| Signed in to the instance | The extension borrows your session. It never asks for or stores credentials. |
| Read access to `sn_aia_*`, `sys_generative_ai_log`, `syslog` | Without it, sections come back empty or marked *forbidden*. |
| Read access to `sys_dictionary` and `sys_db_object` | The trace discovers related tables and reference fields from the dictionary. Without it, it falls back to documented names and is less complete. |
| HR admin role, for HR use cases | HR-related Gen AI log rows are visible only to HR administrators. |

An admin on a sub-production instance sees everything, so it gives the fullest trace. Admin can also read records that the agent's run-as identity cannot, so confirm the fix by reproducing as that user.

If you work on someone else's instance, check their security policy before you install an unpacked extension in a browser that holds their session.

## Install

1. Download or clone this repository and keep the folder. Chrome loads the extension from it, so don't delete or move it.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the folder that contains `manifest.json`.
5. Click the puzzle icon in the toolbar and pin **ServiceNow AI Debugger**.

The extension works on `*.service-now.com` and `*.servicenowservices.com` straight away. For a custom domain, open the instance, open the panel and click **Allow this domain**. Chrome asks you to confirm, and the permission covers that one domain only.

To update, replace the folder's contents (or `git pull`) and click the reload icon on the extension's card in `chrome://extensions`.

## Run a trace

The fastest way in is to open the failing record in ServiceNow and click **Use this page**. Click the extension icon on a ServiceNow tab to open the panel; the header shows the instance once it is connected.

1. **Use this page** traces the record open in the current tab. Classic forms, Next Experience URLs and workspace record URLs all work.
2. **Trace** takes whatever you type: a sys_id, a record URL, a plan number or part of a name. Press Enter or click the button.
3. **Recent runs** lists the latest 20 execution plans. Click **Trace** next to the one you want.

| You give it | It collects |
| --- | --- |
| Execution plan sys_id or number | Tasks, messages and tool executions → the agents and workflow involved, with tools, ACLs and run-as roles → the linked Virtual Agent conversation → Gen AI log, system log, outbound HTTP, flows, restricted caller access and AI Guardian rows in the run's time window → AI app versions |
| Execution task, tool execution or message sys_id | Finds the parent plan, then traces it as above |
| AI agent sys_id or name | Agent configuration, tool bindings and what each tool calls, ACLs, run-as roles, workflows that use the agent, recent plans, and description overlap with other active agents |
| Agentic workflow sys_id or name | Team agents with their configuration, triggers, recent plans |
| Tool sys_id or name | The script include, flow or action behind it, the agents it is bound to, recent executions |
| Now Assist skill or prompt sys_id or name | Related prompt and capability records, recent Gen AI log runs of the skill, usage count, system log around the latest run |
| Gen AI log sys_id | The call, its skill and prompt records, logs around it |
| VA conversation sys_id | The transcript, then the latest plan in that conversation |
| Any other text | Name search across agents, workflows, tools, skills and plans; pick a match to trace it |

A typical plan trace makes 60 to 80 read-only calls and finishes in a few seconds.

Tip: start from the **execution plan** whenever you can. It is the entry point that ties config, run and logs together. When a user reports "the agent didn't work", use **Recent runs** or trace the agent and pick its latest plan.

## Read the results

Read the panel top to bottom: the root cause card tells you what to fix first, and everything below is the evidence for it.

| Card | What it shows | How to use it |
| --- | --- | --- |
| Warnings | Things the trace could not do, such as an unreadable table or an ID it couldn't find | Fix access or the input before trusting the findings |
| Matches | Candidates from a name search | Click **Trace** on the right one |
| Traced | Record type, display value, table, instance release and patch, and the UTC log window used | Check it traced what you meant |
| Most likely root cause | The finding closest to the cause, with detail and a fix | Start here. **Also check** lists up to three other likely causes, because a run can fail for more than one reason |
| Findings | Every rule that fired, sorted by severity | Click a severity chip to hide or show that level |
| Conversation timeline | The whole run in time order | See below |
| Claude analysis | Optional written analysis | See [Analyse with Claude](#analyse-with-claude) |
| Stop AI Agent processing | Optional stop scripts | See [Stop AI Agent processing](#stop-ai-agent-processing) |
| Execution plans | Recent plans for an agent, workflow or conversation | Click **Trace** to drill into one run |
| AI app versions | Scope, version and active state of the AI store apps | Compare with the store and your patch level |
| Evidence | One expandable group per table read, with row count and status | Click a record name to open it in a new tab; expand **fields** to see the raw values |

The root cause is ranked by how close a finding usually sits to the cause, not by severity alone. A failed plan is almost always a symptom, so a tool input mismatch or a broken script include outranks it even when the plan failure is marked Critical.

Severity: **Critical** — something in the chain failed or is missing. **High** — a likely cause or a serious risk, such as an access gap, an empty tool result or a supervised tool on an unattended run. **Medium** — degraded behaviour or a design smell, such as loops, slow tools or overlapping agent descriptions. **Info** — context, such as tracing as admin.

Status labels on evidence groups: *forbidden* means your user can't read that table, *missing* means the table isn't on this instance, *error* means the request failed. An empty group with no label had no rows.

### Conversation timeline

The timeline puts the run in order so you can read it the way the user lived it:

| Entry | Colour | What it shows |
| --- | --- | --- |
| User | Blue | What the user typed in Virtual Agent or the assistant panel |
| Virtual Agent | Green | What the user saw back, including cards and buttons |
| Agent message | Grey | Messages inside the execution plan |
| Task | Grey | Each execution task and its state |
| Tool call | Grey | Tool name, input, output, state and duration |
| LLM call | Grey | Skill or source, the model's response and state |
| Error | Red | Error-level system log lines and failed flows during the run |

Click a name to open that record. Long text folds; click it to expand. If the plan has no linked conversation (a triggered run, or a test in AI Agent Studio), the card says so and shows the rest of the run. To start from the conversation instead, paste its sys_id.

## Analyse with Claude

Optional and off until you add your own Anthropic API key.

1. Open settings (gear icon), paste your **Anthropic API key** and pick a **Model**. Claude Opus 5.5 is the default; Sonnet 5.5 is faster, Haiku 5.5 is cheapest, Fable 5.1 is for the hardest cases.
2. Run a trace. A **Claude analysis** card appears under the findings.
3. Click **Analyse with Claude**. The first time, a confirmation shows the payload size, the model, and whether bodies are included. Expand **Preview what is sent** to read the exact JSON. Click **Send**, or tick **Don't ask again** first.
4. The answer streams in with five parts: Root cause (with confidence), Causal chain, Fix, Verify, and Gaps.
5. Ask follow-ups in the box under the answer. The evidence is sent once; follow-ups reuse it.
6. **Stop** cancels a long answer. Token usage shows under the card.

No API key? **Copy prompt for claude.ai** copies the same redacted prompt and opens a new claude.ai chat to paste it into. (Third-party tools can't sign in with a Claude subscription; Anthropic's terms reserve that for its own apps.)

Claude gets the rule engine's findings as a starting point and is told to agree or disagree with them, cite rule IDs and sys_ids for each step, and say what evidence is missing. Treat its answer as a second opinion: check the cited records before changing anything.

| Sent to Claude | Not sent by default |
| --- | --- |
| Plan, tasks and tool executions (state, errors, timings) | Prompt and response text |
| Agents with description, instructions, tools, run-as roles and ACLs | Tool input and output values |
| Gen AI log entries (state, errors, skill, guard flags) | Agent, user and Virtual Agent message text |
| System log lines, failed HTTP calls, flow failures, restricted caller access | Your name and the full role list of your user |
| Timeline order (who, when, state, error), AI app versions, rule findings | Raw records from each table |

Everything sent is redacted (emails, NRIC/FIN, phone and card numbers, tokens) whatever the export setting says. The evidence is wrapped as untrusted data, and Claude is told never to follow instructions inside it, because record text can contain prompt injection. Tick **Send prompt, response and tool input/output bodies** only when the answer needs them; they are still redacted and truncated.

## Stop AI Agent processing

Stop actions give you a ready-made Scripts - Background snippet that cancels a run, cancels stuck runs, or deactivates an agent. **The extension never runs it**: you review it on the instance and click Run yourself. The feature is off until you tick **Offer "stop" scripts** in settings, and running the script needs the admin role.

Try the supported controls first: **Cancel** on the agentic workflow card, **Deactivate** in AI Agent Studio, or the AI Control Tower kill switch. Use a stop script when those aren't reachable or a run is stuck where the UI can't cancel it.

| Action | Offered when you trace | What the script does |
| --- | --- | --- |
| **Stop this run** | An execution plan, task, tool execution or message | Cancels the plan and its open child records (tasks, tool executions and any other `sn_aia` table that references the plan) |
| **Stop stuck runs (n)** | An agent, workflow or conversation | The same for each recent plan still open after the stuck threshold |
| **Deactivate trigger** | A workflow with active triggers | Sets the trigger inactive, like the Kill Switch in enforce mode. Use it for a runaway trigger |
| **Deactivate this agent / workflow** | An agent or workflow | Sets it inactive so the orchestrator stops using it. Plans already running are not cancelled |

To use one:

1. Trace the run, agent or workflow.
2. On the **Stop AI Agent processing** card, click the action. Read the description and the script.
3. Click **Open in Scripts - Background**. A new tab opens on the same instance with the script filled in (also copied to your clipboard).
4. Click **Run script**. The first run is a dry run: it prints every record it would change, with old and new state, and changes nothing.
5. If the output is right, change `DRY_RUN = true` to `DRY_RUN = false` and run it again.
6. Trace the run again to confirm it is cancelled.

Safeguards in every script:

- **Dry run first.** `DRY_RUN = true` is the default.
- **Instance lock.** It aborts if `instance_name` doesn't match the instance it was generated for. On a custom domain, set `EXPECTED_INSTANCE` to the value of the `instance_name` property.
- **No guessed states.** It uses each table's own "cancelled" choice from `sys_choice`. If a table has none, it skips that table and says so; set `CANCEL_STATE` to force a value.
- **Final states left alone.** Records already complete, failed or cancelled are skipped.
- **Cap.** At most 200 records (`MAX_RECORDS`).
- **Audit.** Everything it does is printed and written to the system log with the tag `[SNAI-STOP]`, and records are updated with business rules and auditing on.
- **Flows off by default.** Waiting or running flow contexts from the run window are listed but only cancelled if you set `CANCEL_FLOWS = true`. They are matched by time, so check each one first.

## Playbooks

### The plan is stuck or never finishes

1. Trace the plan (**Recent runs** if you don't have the sys_id).
2. Look for **PLAN-STUCK** and **PLAN-NOTASKS**. No tasks means the orchestrator never handed the work to an agent.
3. With no tasks: check **AGENT-INACTIVE**, **ACL-ROLEGAP** and **DESC-OVERLAP**, then the AI app versions card against the store.
4. With tasks: check **SUPERVISED-UNATTENDED** (a tool waiting for an approval nobody will give) and **FLOW-WAIT** (a subflow waiting).
5. To clear it, use **Stop this run**.

### A tool returns nothing, or the agent says it "couldn't find" data that exists

1. Trace the plan and open the **Tool executions** evidence group or the timeline.
2. **TOOL-INPUT-CASE** means the agent sent `employeeid` where the tool expects `employeeId`, so the tool got an empty value. Align the names.
3. **TOOL-EMPTY** with **SYSLOG-ACL** or **ACL-ROLEGAP** means an access problem. Impersonate the run-as user and run the same query.
4. **RCA-DENIED** means a cross-scope call was blocked. Editing the calling script can invalidate an earlier approval.

### A tool fails with an error

1. **TOOL-ERR** shows the error text. **SYSLOG-TOOL** shows matching script errors from the system log.
2. **TOOL-DEP-BROKEN** or **TOOL-DEP-INACTIVE** means the script include, flow or action behind the tool is missing or off, often because it wasn't captured in the update set.
3. **HTTP-ERR** or **FLOW-ERR** point at a spoke or subflow behind the tool.

### The LLM step fails or returns nothing

1. Trace the plan, the skill, or the Gen AI log record directly.
2. **GENAI-ERR** includes a targeted hint. `resolveModelConfig` or OneExtend errors point at capability routing and plugin versions, which can break after platform hotfixes. Throttling, timeout and context-length errors each get their own hint.
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

### Works for admins but not for users (Brazil and later)

1. Trace the plan, agent or workflow.
2. **AI-ACL-MISSING** lists each agent, workflow, skill, flow or flow action without its own ACL. From Brazil, newly activated instances deny these record types by default (`gen_ai_agent`, `gen_ai_workflow`, `gen_ai_skill`, `flow`, `flow_action`). If the type's wildcard ACL has Security Attribute "Never", only admins get through.
3. Add an "Allow If" ACL for each component (AI Agent Studio security controls), then use **Test access** on the AI asset and Access Analyzer as a non-admin user.
4. ACLs decide who can invoke a component, not what it can do afterwards: also check **ACL-ROLEGAP** and **TOOL-EMPTY** for the run-as user's data access.

### An agent keeps running on the same record, or its trigger switched itself off

1. Trace the agent or the workflow.
2. **RUNAWAY-TRIGGER** means the same objective ran at least `kill_switch.max_fires_per_window` times (default 5) inside the window (default 24 h). Each run consumes assists.
3. **TRIGGER-DISABLED** means a trigger is inactive while `kill_switch.mode` is `enforce`: the Kill Switch probably switched it off and emailed the trigger and agent creators.
4. Fix the trigger condition so the record stops re-matching after the agent updates it. To stop it now, use **Deactivate trigger** on the stop card, deactivate it in AI Agent Studio, or use Deactivate Agent in AI Control Tower. Re-activating a trigger resets the breach cycle.

### The user saw something different from what the agent did

1. Trace the plan, or paste the VA conversation sys_id.
2. Read the **Conversation timeline** top to bottom. Find the first Virtual Agent turn that doesn't match the agent message, tool result or LLM response just before it.
3. **VA-REASK** means the bot asked the same thing three or more times.
4. **VA-FAULT** means a runtime error closed the conversation. Look at the red Error entries just before the last bot message.

## Settings

Open settings with the gear icon. Changes are saved in this browser and apply to the next trace.

| Setting | Default | When to change it |
| --- | --- | --- |
| Log window (± minutes) | 2 | Widen when GENAI-NONE fires or logs look missing; narrow on busy instances |
| Rows per table | 50 | Raise for long runs with many tasks or messages |
| Plan counts as stuck after (minutes) | 5 | Raise for agents that legitimately run long. Also used by Stop stuck runs |
| Redact PII in exports | On | Turn off only for your own sub-production data |
| Include prompt and response bodies in exports | Off | Turn on when the reader needs the actual text; still redacted and truncated |
| Offer "stop" scripts | Off | Turn on to show the Stop AI Agent processing card |
| Anthropic API key | Empty | Paste a key to enable **Analyse with Claude**. Stored in this browser profile only, unencrypted; use a key with a spend limit |
| Model | Claude Opus 5.5 | Sonnet 5.5 for speed, Haiku 5.5 for cost, Fable 5.1 for hard cases |
| Send prompt, response and tool input/output bodies | Off | Turn on when the cause is likely in what the LLM or a tool received or returned |
| Ask me before each send to Claude | On | Turn off once you trust what is being sent |

The log window applies to records with no direct link to the run, such as system log rows, matched on created time in UTC. Records linked by reference are collected in full up to the row limit.

## Export and share

| Button | Produces | Best for |
| --- | --- | --- |
| **Copy report** | Markdown: instance, who traced, root cause and other likely causes, findings, agents and tools, tool executions, conversation timeline (first 60 entries), AI app versions, evidence counts, warnings, and the Claude conversation if any | Incident notes, chat, a support case |
| **Download evidence** | JSON with the full evidence, findings and Claude transcript | Attaching to a ticket, comparing runs |

With redaction on (the default), exports mask email addresses, Singapore NRIC/FIN numbers, phone numbers, card-like digit runs, JWTs, API keys, `password=` / `token=` values, and your full name. Prompt, response, input, output, message and timeline text is replaced with a character count unless **Include prompt and response bodies** is on. sys_ids, timestamps, states and table names are kept.

Redaction is pattern-based: it won't catch a name in free text or an organisation-specific ID format. Read the report before you share it.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| "ServiceNow rejected the session (401)" | Session expired or the page token is stale | Reload the ServiceNow tab, sign in, trace again |
| Buttons are greyed out | The active tab isn't a ServiceNow instance, or a custom domain isn't allowed | Switch to the instance tab; click **Allow this domain** |
| "No sys_id in the current page URL" | The page is a list, home page or canvas | Open the record form, or paste the sys_id |
| "sys_id … was not found in any AI table" | Unknown table, or you can't read it | Paste the record URL instead (it carries the table name), or check access |
| Many evidence groups marked *forbidden* | Your user lacks read access | Trace as an admin on sub-production |
| DICT finding, few related records | `sys_dictionary` isn't readable | Same as above |
| A table you expect never appears | Its name differs on your release | Edit `lib/config.js`, then reload the extension |
| Findings look wrong for a field | Fields are matched by name patterns | Expand **fields** in the evidence group; open an issue with the field name |
| **Analyse with Claude** greyed out | No API key | Add a key, or use **Copy prompt for claude.ai** |
| "Claude API 401 / 404 / 429" | Bad key / model not available to your key / rate limit | Fix the key / pick another model / retry later |
| Stop script prints "Aborted: … generated for …" | Instance name differs (custom domain or wrong instance) | Set `EXPECTED_INSTANCE` to the `instance_name` property, if it is the right instance |
| Stop script skips with "no cancel choice" | The table has no cancelled choice | Set `CANCEL_STATE` to the right value |

To see what the panel is doing, right-click inside it, choose **Inspect**, and watch the Console. Each request also appears in the ServiceNow tab's Network panel as a `GET` to `/api/now/table/`.

## Limits and safe use

- **Not yet validated on a live instance.** Treat findings as leads to confirm. See [table names](ARCHITECTURE.md#table-names).
- **ACL check is role-only.** It finds agentic ACLs by type (`gen_ai_agent`, `gen_ai_workflow`, `gen_ai_skill`, `flow`, `flow_action`) and by name (sys_id, internal name or name). It does not evaluate conditions or scripts; use Test access and Access Analyzer for the final word.
- **Release detection** reads build properties from `sys_properties`; without access, Brazil-specific rules use lower severities and RELEASE-UNKNOWN fires.
- **AI Guardian tables** are discovered by name (`guardrail`, `guardian`).
- **Time-window matching is in UTC**; on a busy instance unrelated errors can appear.
- **Heuristic fields.** State, error, input and output are matched by field-name patterns.
- **Claude analysis** sends redacted instance data to Anthropic under your key. Get the instance owner's agreement first. The key is stored unencrypted in the Chrome profile.
- **Stop scripts** are direct writes, not a documented API; a tool call already in flight may still finish. `sn_fd.FlowAPI.cancel` is only used when you switch it on. Background scripts run with full rights: sub-production first, and follow your change process on production.
- **Confirm every fix** by reproducing as the run-as user, not as admin.
