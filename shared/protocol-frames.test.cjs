'use strict';
/**
 * protocol-frames.test.cjs — sentinel + bare-JSON tool frames must never
 * reach user-facing result text.
 *
 * Run from repo root: node shared/protocol-frames.test.cjs
 */

const { stripProtocolFrames, stripJsonToolFrames } = require('./protocol-frames.cjs');

let _passed = 0, _failed = 0;
function it(label, fn) {
  try { fn(); _passed++; console.log(`  ✅ ${label}`); }
  catch (e) { _failed++; console.log(`  ❌ ${label}\n     ${e.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m || 'assert failed'); }

it('concatenated {"id":"N",...} tool frames strip to empty (observed leak)', () => {
  const leak = '{"id":"0","text":"Tokyo weather"}{"id":"0","response":"{\\"results\\":[{\\"title\\":\\"Tokyo Weather Forecast\\"}]}"}';
  assert(stripProtocolFrames(leak) === '', 'frames-only answer → empty');
});

it('frames inside prose are removed, prose survives', () => {
  const s = 'Here are the results {"id":"0","text":"tokyo"} plus more.';
  assert(stripProtocolFrames(s).includes('Here are the results') && !s.includes('{"id"') === false
    ? stripProtocolFrames(s) === 'Here are the results  plus more.'
    : false, `got: ${stripProtocolFrames(s)}`);
});

it('nested/escaped JSON inside frames balances correctly', () => {
  const s = 'x {"id":"3","response":"{\\"a\\":{\\"b\\":\\"brace } inside\\"}}"} y';
  const out = stripProtocolFrames(s);
  assert(out === 'x  y' || out === 'x y', `got: ${out}`);
});

it('sentinel chunks strip (ITEMS/SOURCES/ENGINE)', () => {
  const s = 'ok\x00ITEMS\x00[{"title":"a"}]\x00SOURCES\x00[{"url":"u"}]';
  const out = stripProtocolFrames(s);
  assert(out === 'ok', `got: ${out}`);
});

it('normal answers pass through unchanged', () => {
  const s = 'The current local time is 6:04 AM on November 7, 2026 (America/New_York).';
  assert(stripProtocolFrames(s) === s, 'unchanged');
});

it('legitimate JSON without id-digits key survives', () => {
  const s = 'The object {"name":"x","id":"abc"} means a record.';
  assert(stripProtocolFrames(s) === s, `got: ${stripProtocolFrames(s)}`);
});

it('unbalanced {"id":"0",... text is not stripped (truncated frame ≠ markup)', () => {
  const s = 'result {"id":"0","text":"oops never closes';
  assert(stripProtocolFrames(s) === s, 'unbalanced left alone');
});

it('non-strings pass through', () => {
  assert(stripProtocolFrames(null) === null && stripProtocolFrames(undefined) === undefined, 'nullish');
  assert(stripProtocolFrames(42) === 42, 'number');
});

console.log(`\n${_passed} passed, ${_failed} failed`);
process.exit(_failed ? 1 : 0);
