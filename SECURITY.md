# Security

## What the extension can and cannot do

- **Reads only.** All instance access goes through `lib/sn-client.js`, which issues `GET` requests only and rejects any path outside `/api/now/table/*` and `/api/now/stats/*`. Requests run in your ServiceNow tab with your session, so the instance's ACLs decide what is returned.
- **No credentials.** It never asks for, stores or transmits ServiceNow credentials. It reuses the page's session token (`g_ck`) in memory.
- **No server.** There is no backend. Evidence stays in the panel unless you export it or turn on Claude analysis.
- **Claude analysis (opt-in).** Sends a redacted, compacted summary to `api.anthropic.com` with your API key, after a confirmation that shows exactly what is sent. The key is stored in `chrome.storage.local` (unencrypted, this profile only). Evidence is wrapped as untrusted data and the model is instructed not to follow instructions found in it.
- **Stop scripts (opt-in).** The extension generates a background script and fills it into `sys.scripts.do`. It never submits it. Scripts default to dry run, are locked to one instance name, cap the number of records changed, and log to the system log with `[SNAI-STOP]`.
- **Rendering.** All instance data and model output is HTML-escaped before display; the Markdown renderer escapes first, then formats.

## Data in this repository

The repository contains no customer, employer or personal instance data. Tests use a mock instance with fictional records (`test/mock-instance.mjs`, `test/actions.test.mjs`). The throwaway TLS certificate for the end-to-end test is generated locally and ignored by git.

## Using it responsibly

- Prefer sub-production instances.
- Get the instance owner's agreement before tracing their instance, and before sending any of their data to Claude.
- Keep redaction on for anything you share, and read exports before sending them: redaction is pattern-based.
- Treat stop scripts like any admin change.

## Reporting a vulnerability

Please open a [private security advisory](../../security/advisories/new) on this repository rather than a public issue. Include the version, steps to reproduce and impact. I'll aim to respond within a week.
