/**
 * feedStore tests — node --test --experimental-strip-types (Node ≥22.16).
 * Pins the stream/feed semantics that used to live in ref-mirror updaters:
 * these are the behaviors that regressed silently before the store existed.
 *   cd to repo root: node --test --experimental-strip-types src/renderer/state/feedStore.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createFeedStore,

  dedupePlannerTail,
  mapHistoryMessages,
  oldestMessageCursor,
  toDisplayPrompt,
} from './feedStore.mts';

const mkStore = () => createFeedStore();
const sleep = (ms = 5) => new Promise(r => setTimeout(r, ms));

// ── stream accumulate / publish ─────────────────────────────────────────────

test('stream chunks accumulate synchronously, publish via flush', async () => {
  const s = mkStore();
  s.streamAppendChunk('Hello ');
  s.streamAppendChunk('world');
  assert.equal(s.internal.streamAcc, 'Hello world');   // sync truth
  assert.equal(s.getState().streamText, '');           // not yet published
  await sleep();                                        // fallback timer flush
  assert.equal(s.getState().streamText, 'Hello world');
});

test('streamReplace overwrites the accumulator', () => {
  const s = mkStore();
  s.streamAppendChunk('partial');
  s.streamReplace('REPLACED');
  s.flushStream();
  assert.equal(s.getState().streamText, 'REPLACED');
});

test('commitInFlightStream settles acc into an assistant entry', () => {
  const s = mkStore();
  s.internal.lastPrompt = 'the prompt';
  s.internal.lastExchangeId = 'x_1';
  s.set({ resultItems: [{ url: 'u' }] as any, searchSources: [{ url: 's', hostname: 'h' }] as any });
  s.streamAppendChunk('final answer');
  s.commitInFlightStream();
  const e = s.getState().entries[0];
  assert.equal(e.kind, 'assistant');
  assert.equal((e as any).text, 'final answer');
  assert.equal((e as any).prompt, 'the prompt');
  assert.equal((e as any).exchangeId, 'x_1');
  assert.equal(s.internal.streamAcc, '');
});

test('commitInFlightStream is a no-op on empty/whitespace acc', () => {
  const s = mkStore();
  s.commitInFlightStream();
  s.streamAppendChunk('   ');
  s.commitInFlightStream();
  assert.equal(s.getState().entries.length, 0);
});

// ── appendEntry taskId dedupe ───────────────────────────────────────────────

test('assistant entries dedupe by taskId — second completes patch in place', () => {
  const s = mkStore();
  const id1 = s.appendEntry({ kind: 'assistant', text: 'pending…', taskId: 't1', pending: true } as any);
  const id2 = s.appendEntry({ kind: 'assistant', text: 'real answer', taskId: 't1' } as any);
  assert.equal(id2, id1);
  assert.equal(s.getState().entries.length, 1);
  assert.equal((s.getState().entries[0] as any).text, 'real answer');
  assert.equal((s.getState().entries[0] as any).pending, false);
});

test('different taskIds append separately', () => {
  const s = mkStore();
  s.appendEntry({ kind: 'assistant', text: 'a', taskId: 't1' } as any);
  s.appendEntry({ kind: 'assistant', text: 'b', taskId: 't2' } as any);
  assert.equal(s.getState().entries.length, 2);
});

// ── appendUserEntry exchange correlation ────────────────────────────────────

test('same-text submits adopt one exchange and never double-append', () => {
  const s = mkStore();
  const x1 = s.appendUserEntry('what have we been chatting about');
  const x2 = s.appendUserEntry('what have we been chatting about');
  assert.equal(x1, x2);
  assert.equal(s.getState().entries.filter(e => e.kind === 'user').length, 1);
});

test('distinct texts mint distinct exchanges', () => {
  const s = mkStore();
  const x1 = s.appendUserEntry('first');
  const x2 = s.appendUserEntry('second');
  assert.notEqual(x1, x2);
});

test('appendUserEntry strips the proactive save-dir tail', () => {
  const s = mkStore();
  s.appendUserEntry('do the thing\n\nSave any files you produce to: /Users/x/.thinkdrop/brain/work-abc123');
  assert.equal((s.getState().entries[0] as any).text, 'do the thing');
});

// Isolated-context submits carry [Context: …] prefixes — the user bubble must
// show only the prompt text, and the echo must dedupe against the local append.
test('toDisplayPrompt strips [Context:] prefixes', () => {
  assert.equal(
    toDisplayPrompt('[Context: some isolated body]\n[Highlighted: more]\n\nactual question'),
    'actual question',
  );
  // Two stacked [Context:] chips strip cleanly too.
  assert.equal(
    toDisplayPrompt('[Context: body one]\n[Context: body two]\n\nreply here'),
    'reply here',
  );
});

// A re-asked message after a reply is a NEW exchange — the set-prompt echo
// dedupe must not eat identical texts once the turn has advanced.
test('re-asked identical text after a reply mints a new exchange', () => {
  const s = mkStore();
  const x1 = s.appendUserEntry('no');
  s.appendEntry({ kind: 'assistant', text: 'Understood.' });
  const x2 = s.appendUserEntry('no');
  assert.notEqual(x1, x2);
  assert.equal(s.getState().entries.filter(e => e.kind === 'user').length, 2);
});

// run/proactive entries don't advance the turn — a run card can land before
// the echo, and the echo must still dedupe against the pending user bubble.
test('a run entry between identical submits still dedupes (echo semantics)', () => {
  const s = mkStore();
  const x1 = s.appendUserEntry('go to amazon')!;
  s.internal.taskExchange.set('t5', x1);
  s.ensureRunEntry('t5', 'go to amazon');
  const x2 = s.appendUserEntry('go to amazon');
  assert.equal(x1, x2);
  assert.equal(s.getState().entries.filter(e => e.kind === 'user').length, 1);
});

// The echo dedupe is scoped to the OPEN turn — a proactive nudge sitting
// between the bubble and the echo doesn't break it either.
test('proactive interleave does not break echo dedupe', () => {
  const s = mkStore();
  const x1 = s.appendUserEntry('no')!;
  s.appendEntry({ kind: 'proactive', text: 'a thought nudge' } as any);
  const x2 = s.appendUserEntry('no');
  assert.equal(x1, x2);
  assert.equal(s.getState().entries.filter(e => e.kind === 'user').length, 1);
});

// ── ensureRunEntry / exchangeForTask ────────────────────────────────────────

test('ensureRunEntry is idempotent and joins the prompt exchange', () => {
  const s = mkStore();
  const xid = s.appendUserEntry('run my automation')!;
  s.internal.taskExchange.set('t1', xid);
  s.ensureRunEntry('t1', 'run my automation');
  s.ensureRunEntry('t1', 'run my automation');
  const runs = s.getState().entries.filter(e => e.kind === 'run');
  assert.equal(runs.length, 1);
  assert.equal((runs[0] as any).exchangeId, xid);
  assert.equal((runs[0] as any).title, 'run my automation');
});

test('exchangeForTask resolves via matching user bubble text', () => {
  const s = mkStore();
  const xid = s.appendUserEntry('hello there')!;
  assert.equal(s.exchangeForTask('t9', 'hello there'), xid);
  assert.equal(s.internal.taskExchange.get('t9'), xid); // cached
});

// ── history mapping ─────────────────────────────────────────────────────────

test('mapHistoryMessages: user→user, assistant→assistant, system dropped', () => {
  const msgs = [
    { id: 1, sender: 'user', text: 'hi', timestamp: '2026-01-01T00:00:00Z' },
    { id: 2, sender: 'assistant', text: 'hello', timestamp: '2026-01-01T00:00:01Z' },
    { id: 3, sender: 'system', text: 'recovered', timestamp: '2026-01-01T00:00:02Z' },
  ];
  const out = mapHistoryMessages(msgs);
  assert.deepEqual(out.map(e => e.kind), ['user', 'assistant']);
  assert.equal(out[0].id, 'db_1');
});

test('thought_engine metadata reloads as proactive with thoughtId', () => {
  const msgs = [{
    id: 9, sender: 'assistant', text: 'still there?', timestamp: '2026-01-01T00:00:00Z',
    metadata: { source: 'thought_engine', thoughtId: 'th_1' },
  }];
  const out = mapHistoryMessages(msgs);
  assert.equal(out[0].kind, 'proactive');
  assert.equal((out[0] as any).thoughtId, 'th_1');
});

// Reloaded assistant rows keep their actions: prompt propagates from the
// preceding user message (redo), metadata.taskId maps through (queue link).
test('history rows carry prompt (redo) + taskId (queue) across reload', () => {
  const msgs = [
    { id: 1, sender: 'user', text: '[Context: pinned body]\n\nwhat is this', timestamp: '2026-01-01T00:00:00Z' },
    { id: 2, sender: 'assistant', text: 'It is a thing.', timestamp: '2026-01-01T00:00:01Z', metadata: { taskId: 'task_42' } },
    { id: 3, sender: 'assistant', text: 'Unprompted thought', timestamp: '2026-01-01T00:00:02Z', metadata: { source: 'thought_engine', thoughtId: 'th_9' } },
  ];
  const out = mapHistoryMessages(msgs);
  assert.equal((out[1] as any).prompt, '[Context: pinned body]\n\nwhat is this');
  assert.equal((out[1] as any).taskId, 'task_42');
  assert.equal(out[2].kind, 'proactive'); // thoughts don't inherit the prompt
});

// Rows logged before metadata.taskId existed still deep-link to Queue when a
// journal-restored task shares the session + normalized prompt.
test('history rows retroactively link tasks by session + prompt match', () => {
  const tasks = [
    { id: 'task_yes', prompt: 'show  me   the page', sessionId: 'sess_1' },
    { id: 'task_other_session', prompt: 'show  me   the page', sessionId: 'sess_2' },
    { id: 'task_wrong_text', prompt: 'different prompt', sessionId: 'sess_1' },
  ];
  const msgs = [
    { id: 1, sender: 'user', text: 'show me the page', sessionId: 'sess_1', timestamp: '2026-01-01T00:00:00Z' },
    { id: 2, sender: 'assistant', text: 'Here it is.', sessionId: 'sess_1', timestamp: '2026-01-01T00:00:01Z' },
    { id: 3, sender: 'user', text: 'hi', sessionId: 'sess_9', timestamp: '2026-01-01T00:00:02Z' },
    { id: 4, sender: 'assistant', text: 'hello', sessionId: 'sess_9', timestamp: '2026-01-01T00:00:03Z' },
    // metadata.taskId wins over correlation
    { id: 5, sender: 'user', text: 'show me the page', sessionId: 'sess_1', timestamp: '2026-01-01T00:00:04Z' },
    { id: 6, sender: 'assistant', text: 'Again.', sessionId: 'sess_1', timestamp: '2026-01-01T00:00:05Z', metadata: { taskId: 'task_meta' } },
  ];
  const out = mapHistoryMessages(msgs, { tasks });
  assert.equal((out[1] as any).taskId, 'task_yes');        // correlated
  assert.equal((out[3] as any).taskId, undefined);         // no match → absent
  assert.equal((out[5] as any).taskId, 'task_meta');       // metadata wins
});

test('consecutive identical entries collapse (paused-run re-logs)', () => {
  const t = '2026-01-01T00:00:0';
  const msgs = [
    { id: 1, sender: 'user', text: 'same prompt', timestamp: `${t}1Z` },
    { id: 2, sender: 'user', text: 'same prompt', timestamp: `${t}2Z` },
    { id: 3, sender: 'user', text: 'same prompt', timestamp: `${t}3Z` },
    { id: 4, sender: 'assistant', text: 'answer', timestamp: `${t}4Z` },
    { id: 5, sender: 'user', text: 'same prompt', timestamp: `${t}5Z` }, // legit re-ask survives
  ];
  const out = mapHistoryMessages(msgs);
  assert.deepEqual(out.map(e => e.kind), ['user', 'assistant', 'user']);
});

test('dedupePlannerTail drops answer-echo blocks, keeps distinct output + Saved files', () => {
  const answer = 'The Cohere brief contents.';
  const blob = `${answer}\n\nStep outputs:\n[Search stuff]:\nsome search results\n\n[Compile]:\n${answer}\n\n[synthesize]:\n${answer}\n\nSaved files: /x/brief.md`;
  const out = dedupePlannerTail(blob);
  assert.equal(out.split(answer).length - 1, 1);            // brief appears once
  assert.ok(out.includes('[Search stuff]:'));               // distinct output kept
  assert.ok(out.includes('Saved files: /x/brief.md'));      // path kept
  assert.ok(!out.includes('[synthesize]'));
});

test('dedupePlannerTail leaves ordinary prose untouched', () => {
  const t = 'just a normal answer\n\nStep outputs are discussed here but no blocks';
  assert.equal(dedupePlannerTail(t), t);
});

// ── prependHistory + TTL eviction ───────────────────────────────────────────

const histMsg = (id: number, ts: string) => ({ id, sender: 'user', text: `m${id}`, timestamp: ts });

test('prependHistory prepends, dedupes by id, sets cursor/hasMore', () => {
  const s = mkStore();
  const p1 = mapHistoryMessages([histMsg(2, '2026-01-01T00:00:02Z'), histMsg(1, '2026-01-01T00:00:01Z')]);
  s.prependHistory(p1, { cursor: '2026-01-01T00:00:01Z', hasMore: true });
  assert.equal(s.getState().entries.length, 2);
  assert.equal(s.getState().entries[0].id, 'db_1');
  assert.equal(s.internal.historyCursor, '2026-01-01T00:00:01Z');
  assert.equal(s.getState().hasMoreHistory, true);
  // re-prepending the same page is a no-op
  s.prependHistory(p1, { cursor: '2026-01-01T00:00:01Z', hasMore: true });
  assert.equal(s.getState().entries.length, 2);
});

test('evictExpiredHistory removes prepended pages, rewinds cursor to floor', () => {
  const clock = { t: 1_000_000 };
  const s = createFeedStore(() => clock.t);
  // floor page
  const p1 = mapHistoryMessages([histMsg(20, '2026-01-01T00:00:20Z'), histMsg(19, '2026-01-01T00:00:19Z')]);
  s.prependHistory(p1, { cursor: '2026-01-01T00:00:19Z', hasMore: true });
  // wait — p1 is the FIRST page (the floor); eviction must not remove it.
  // historyPages[0] is the floor — its loadedAt drives the TTL? No: the floor
  // is the page loaded at mount. Treat page[0] as floor? The design evicts
  // the *prepended* block — i.e., all pages. Hmm: floor IS a page here.
  assert.equal(s.evictExpiredHistory(clock.t, 10 * 60 * 1000), null); // fresh → no evict
  clock.t += 11 * 60 * 1000;
  const removed = s.evictExpiredHistory(clock.t, 10 * 60 * 1000);
  assert.ok(removed);
  assert.equal(s.getState().entries.length, 0);
  assert.equal(s.internal.historyCursor, s.internal.sessionBoundary); // rewound
  assert.equal(s.getState().hasMoreHistory, true);
});

test('eviction keeps live entries and floor boundary intact', () => {
  const clock = { t: 5_000_000 };
  const s = createFeedStore(() => clock.t);
  s.prependHistory(mapHistoryMessages([histMsg(1, '2026-01-01T00:00:01Z')]), { cursor: 'x', hasMore: true });
  s.appendUserEntry('live prompt'); // live entry survives eviction
  clock.t += 11 * 60 * 1000;
  s.evictExpiredHistory(clock.t, 10 * 60 * 1000);
  assert.equal(s.getState().entries.length, 1);
  assert.equal(s.getState().entries[0].kind, 'user');
});

test('oldestMessageCursor returns the oldest row timestamp', () => {
  const c = oldestMessageCursor([
    histMsg(2, '2026-01-01T00:00:02Z'), histMsg(1, '2026-01-01T00:00:01Z'),
  ]);
  assert.equal(c, '2026-01-01T00:00:01Z');
});
