# Contributing

Issues and pull requests are welcome, especially findings from real instances: table or field names that differ from what `lib/config.js` expects, rules that misfire, or failure patterns worth a new rule.

## Ground rules

- **Never include customer or personal data** in issues, fixtures, screenshots or logs. Use fictional records like the ones in `test/mock-instance.mjs`. Redact sys_ids if they could identify an organisation.
- **Keep the extension read-only.** Instance access must stay `GET`-only through `lib/sn-client.js`. Anything that changes an instance belongs in a script the user reviews and runs, like `lib/actions.js`.
- **No new runtime dependencies or build step** without discussion.

## Development

```bash
npm test        # Node 20+; no install needed
```

For the end-to-end test you need Playwright with Chromium; see the README.

When you add or change a rule, add fixture data and an assertion (see `docs/RULES.md`, "Adding a rule"). When you change a stop script, extend `test/actions.test.mjs` so the script is executed, not just generated.
