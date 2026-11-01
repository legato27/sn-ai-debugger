# SN AI Debugger

A Chrome side panel that finds out why a ServiceNow AI Agent run, agentic workflow, tool or Now Assist skill failed. You give it a record (or open one); it reads the configuration and logs around it through your own logged-in session, runs 45 deterministic rules, and shows the most likely root cause with a suggested fix.

![Side panel showing the most likely root cause and findings](docs/images/panel-root-cause.png)

> Independent open-source project. Not affiliated with, endorsed by, or supported by ServiceNow or Anthropic. "ServiceNow", "Now Assist" and "Claude" are trademarks of their owners.

## What it does

- **Traces a run end to end.** From an execution plan it collects the tasks, agent messages, tool executions (input and output), the agents and workflow involved, their tools and what each tool calls, ACLs and the run-as user's roles, then the Generative AI log, system log, outbound HTTP calls, flows, restricted caller access and AI Guardian rows in the run's time window, plus AI app versions.
- **Starts from anything.** A plan, task, tool execution, agent, workflow, tool, skill, prompt, Gen AI log entry, Virtual Agent conversation, a record URL, a name, or the record open in the current tab.
- **Ranks root causes.** 45 rules (tool input casing mismatches, empty tool results, ACL role gaps, broken script includes, supervised tools on unattended runs, LLM errors, stuck plans, overlapping agent descriptions, re-ask loops and more). A failed plan is treated as a symptom: the rule closest to the cause wins.
- **Release-aware (Brazil ready).** Reads the instance release and patch, checks the deny-by-default ACLs Brazil introduced for agents, workflows, skills, flows and flow actions, and spots runaway triggers and Kill Switch disables.
- **Shows the conversation as the user lived it.** One timeline merges the Virtual Agent transcript, agent messages, tasks, tool calls, LLM calls and errors.
- **Optional Claude analysis.** With your own Anthropic API key, sends a redacted summary to Claude for a written root cause, causal chain, fix and verification steps, with follow-up questions.
- **Optional stop scripts.** Generates a Scripts - Background snippet to cancel a run, cancel stuck runs or deactivate an agent. Dry run by default and locked to the instance it was made for. The extension fills it in; you click Run.
- **Exports.** A Markdown report and a JSON evidence file, redacted by default.

| Conversation timeline | Claude analysis | Stop actions |
| --- | --- | --- |
| ![Timeline](docs/images/timeline.png) | ![Claude analysis](docs/images/claude-analysis.png) | ![Stop actions](docs/images/stop-actions.png) |

## Install

1. Download this repository (Code → Download ZIP) and unzip it, or `git clone` it. Keep the folder: Chrome loads the extension from it.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the folder that contains `manifest.json`.
4. Pin **ServiceNow AI Debugger**, open your instance, and click the icon to open the side panel.

Works on `*.service-now.com` and `*.servicenowservices.com`. For a custom domain, click **Allow this domain** in the panel. Chrome 116 or later.

## Quick start

1. Open a failed execution plan (or an agent, tool or skill) in ServiceNow.
2. Click **Use this page**. Or paste a sys_id, URL or name and click **Trace**, or pick from **Recent runs**.
3. Read **Most likely root cause** first, then **Also check**, the findings and the timeline.
4. Use **Copy report** to paste the result into an incident or a support case.

Full instructions: [User guide](docs/USER_GUIDE.md) · [Rules reference](docs/RULES.md) · [Architecture](docs/ARCHITECTURE.md)

## How it works

```mermaid
flowchart LR
  P[Side panel] -->|ID or page| T[Your ServiceNow tab<br/>session + token]
  T -->|GET only| A[Table and Stats API<br/>under your ACLs]
  A -->|JSON rows| E[Evidence<br/>config, run, logs]
  E --> R[Rules engine<br/>runs in the browser]
  R --> F[Root cause and findings]
  F -.->|optional, redacted, your key| C[Claude]
  F -.->|optional| S[Stop script<br/>you run it]
```

- Every request runs inside your ServiceNow tab as a same-origin `GET` with your session and the page token. The client only allows `/api/now/table/*` and `/api/now/stats/*`.
- Related tables and reference fields are discovered from `sys_dictionary` at run time, so field-name differences between releases don't break the trace.
- There is no server. Nothing leaves the browser unless you turn on Claude analysis.

## Privacy and safety

- **Read-only by construction.** The extension cannot create, change or delete records. Stop actions only fill in a script that you review and run.
- **Your access, nothing more.** ACLs apply exactly as they do for you. Tracing as admin can hide problems the agent's run-as user would hit; the panel warns you.
- **Redaction.** Exports and anything sent to Claude mask emails, Singapore NRIC/FIN, phone and card numbers, and tokens. Prompt, response, message and tool input/output text is left out unless you switch it on.
- **Prompt-injection aware.** Evidence sent to Claude is wrapped as untrusted data and Claude is told never to follow instructions inside it.
- **No customer data in this repo.** Tests run against a mock instance with fictional records.

See [SECURITY.md](SECURITY.md) for details and how to report a problem.

## Status

Version 0.5.0. Tested against a mock ServiceNow instance, a mock Messages API and an in-memory Glide runtime (35 Node tests plus a Chromium end-to-end run). **Not yet validated on a live AI Agent Studio instance**: several table names are best guesses that the extension probes at run time (see [Architecture](docs/ARCHITECTURE.md#table-names)). Issues and pull requests with real-instance findings are welcome.

## Development

```bash
npm test          # 35 Node tests: collectors, rules, redaction, timeline, Claude client, stop scripts
```

End-to-end test (loads the extension in Chromium against a local mock instance; needs Playwright):

```bash
mkdir -p test/.tls && openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout test/.tls/key.pem -out test/.tls/cert.pem -days 2 \
  -subj "/CN=mock.service-now.com" -addext "subjectAltName=DNS:mock.service-now.com"
node test/e2e.mjs
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE) © 2026 Joseph Tey

Built with AI assistance (Claude).
