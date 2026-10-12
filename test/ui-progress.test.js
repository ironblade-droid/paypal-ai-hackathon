import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/dispute.html', import.meta.url), 'utf8');

test('AI run shows a live progress message with elapsed seconds and clears it', () => {
  assert.match(html, /AI is reading the dispute through PayPal's toolkit… this can take up to a minute/);
  assert.match(html, /s elapsed/);
  assert.match(html, /setInterval\(tick, 1000\)/);
  assert.match(html, /finally \{ clearInterval\(timer\); prog\.remove\(\); \}/);
  assert.match(html, /btn\.disabled = true/);
});

test('a pending proposal without a live code can still be dismissed from the UI', () => {
  const line = html.split('\n').find(l => l.includes('No live approval code'));
  assert.ok(line && line.includes('data-dismiss'), 'dismiss button present when no live code');
});
