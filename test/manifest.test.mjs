import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const keysOf = cmd => Object.values(cmd.suggested_key || {});
const allKeys = Object.values(manifest.commands).flatMap(keysOf);

// Chrome never gives an extension a key that is one of its own shortcuts on that platform
// (CommandService::CanAutoAssign → IsChromeAccelerator). Alt+Shift keys taken on Windows and Linux,
// from chrome/browser/ui/accelerator_table.cc: focus toolbar (T), duplicate tab (D), focus
// bookmarks (B), feedback (I), inactive popup (A), reading mode (R), split tab (N) and the tab
// group keys (C, P, W, X, Z). Alt+Shift+T and Alt+Shift+D were shipped by mistake and never worked
// there.
const CHROME_ALT_SHIFT = new Set([...'ABCDINPRTWXZ'].map(k => `Alt+Shift+${k}`));

test('suggested shortcuts avoid Chrome\'s own keys on every desktop platform', () => {
  assert.ok(allKeys.length >= 2);
  for (const k of allKeys) assert.ok(!CHROME_ALT_SHIFT.has(k), `${k} is a Chrome shortcut on Windows/Linux`);
  assert.equal(new Set(allKeys).size, allKeys.length, 'each command has its own key');
  // Chrome's format: Ctrl or Alt (Command/MacCtrl on a Mac), optional Shift, then one key.
  for (const k of allKeys) assert.match(k, /^(Ctrl|Alt|Command|MacCtrl)\+(Shift\+)?[A-Z0-9]$/);
});

test('the docs name the same shortcuts as the manifest', () => {
  for (const f of ['README.md', 'docs/USER_GUIDE.md', 'docs/ARCHITECTURE.md']) {
    for (const [k] of read(f).matchAll(/\bAlt\+Shift\+[A-Z0-9]\b/g)) assert.ok(allKeys.includes(k), `${f} mentions ${k}`);
  }
});
