'use strict';
/**
 * text-patterns.test.cjs — per-pattern positive/negative coverage for the
 * canonical shared/text-patterns.cjs catalog.
 *
 * Run from repo root: node shared/text-patterns.test.cjs
 */

const P = require('./text-patterns.cjs');
const { hasRelativeTimePhrase } = require('../stategraph-module/src/utils/parseDateRange.js');

let _passed = 0, _failed = 0;
const _failures = [];
function it(label, fn) {
  try { fn(); _passed++; console.log(`  ✅ ${label}`); }
  catch (e) { _failed++; _failures.push(label); console.log(`  ❌ ${label}\n     ${e.message}`); }
}
function section(l) { console.log(`\n${'─'.repeat(72)}\n  ${l}\n${'─'.repeat(72)}`); }
function hits(re, s) { return re.test(s); }
function assert(c, m) { if (!c) throw new Error(m || 'assert failed'); }

// ── CONVERSATION_RECALL_RE (tolerant canonical) ──────────────────────────────
section('CONVERSATION_RECALL_RE');

const RECALL_POS = [
  "We've been chatt about what lately?",
  "We've been talkin about what?",
  'did we talk about Jesus?',
  'what did we discuss earlier?',
  'what did I just ask?',
  'what was my last question',
  'summarize our conversation',
  'remind me what we said',
  'no conversation with you at all?',
  'pull up our previous conversation',
  'the messages we chatted about',
];
const RECALL_NEG = [
  "let's chat about the weather",
  'what is the capital of France',
  'show me pics of baby clothes',
  'open Spotify',
];
for (const s of RECALL_POS) it(`recall+: "${s}"`, () => assert(hits(P.CONVERSATION_RECALL_RE, s), 'no match'));
for (const s of RECALL_NEG) it(`recall-: "${s}"`, () => assert(!hits(P.CONVERSATION_RECALL_RE, s), 'false positive'));

// ── CONVERSATION_RECALL_META_RE (narrow meta-question gate) ──────────────────
section('CONVERSATION_RECALL_META_RE');

it('meta+: "what did I just ask"', () => assert(hits(P.CONVERSATION_RECALL_META_RE, 'what did I just ask')));
it('meta+: "did we talk about X"', () => assert(hits(P.CONVERSATION_RECALL_META_RE, 'did we talk about anything important')));
it('meta-: episodic "what was I doing yesterday" stays OUT', () => assert(!hits(P.CONVERSATION_RECALL_META_RE, 'what was I doing yesterday')));

// ── Affirmation / offer ──────────────────────────────────────────────────────
section('BARE_AFFIRM_RE / OFFER_RE / BARE_FOLLOWUPS');

for (const s of ['yes', 'yeah', 'sure', 'ok', 'okay', 'yes you can', 'go ahead', 'do it', 'sounds good', 'of course'])
  it(`affirm+: "${s}"`, () => assert(hits(P.BARE_AFFIRM_RE, s), 'no match'));
for (const s of ['yes but actually no', 'tell me yes or no', 'yesterday', 'yes you can do that later too'])
  it(`affirm-: "${s}"`, () => assert(!hits(P.BARE_AFFIRM_RE, s), 'false positive'));

const OFFER_POS = [
  'Would you like me to search for specific styles?',
  'Want me to open it?',
  'I can help you find baby clothes online.',
  'Shall I proceed?',
  'Let me know if you\'d like more detail',
];
const OFFER_NEG = ['The capital of France is Paris.', 'Here is your file.', 'I deleted 12 items.'];
for (const s of OFFER_POS) it(`offer+: "${s}"`, () => assert(hits(P.OFFER_RE, s), 'no match'));
for (const s of OFFER_NEG) it(`offer-: "${s}"`, () => assert(!hits(P.OFFER_RE, s), 'false positive'));

it('BARE_FOLLOWUPS: ok/why/huh present', () => {
  assert(P.BARE_FOLLOWUPS.has('ok') && P.BARE_FOLLOWUPS.has('why') && P.BARE_FOLLOWUPS.has('huh'));
});
it('BARE_FOLLOWUPS: "yes" is NOT a follow-up (affirmations are consent-checked first)', () => {
  assert(!P.BARE_FOLLOWUPS.has('yes'));
});

// ── File-write intent ────────────────────────────────────────────────────────
section('isFileWriteGoal / FILE_WRITE_VERB_RE / FILE_NOUN_RE');

const WRITE_POS = [
  'Write the Three.js snow effect code to ~/Desktop/three.md',
  'Save the results to /tmp/output.txt',
  'Create a file called notes.md on the desktop',
  'export the report as /Users/x/report.pdf',
];
const WRITE_NEG = [
  'list the files on my desktop',
  'what is the weather',
  'open the file in the editor',   // read intent — verb "open" not a write verb
];
for (const s of WRITE_POS) it(`write+: "${s}"`, () => assert(P.isFileWriteGoal(s), 'no match'));
for (const s of WRITE_NEG) it(`write-: "${s}"`, () => assert(!P.isFileWriteGoal(s), 'false positive'));

// ── Episodic / image / file-ref ──────────────────────────────────────────────
section('EPISODIC_RE / IMAGE_REQUEST_RES / FILE_REF_RE / REFERENTIAL_RE');

it('episodic+: "what was I watching on Netflix"', () => assert(hits(P.EPISODIC_RE, 'what was I watching on Netflix')));
it('episodic+: "yesterday"', () => assert(hits(P.EPISODIC_RE, 'what did I do yesterday')));
it('episodic-: "schedule for tomorrow"', () => assert(!hits(P.EPISODIC_RE, 'schedule a meeting tomorrow')));

const IMG_POS = ['show me pics of baby clothes', 'find photos of waterfalls', 'show me a picture of a corgi', 'what does a capybara look like'];
const IMG_NEG = ['show me the data', 'picture this scenario', 'describe the image on my screen'];
for (const s of IMG_POS) it(`img+: "${s}"`, () => assert(P.IMAGE_REQUEST_RES.some(r => r.test(s)), 'no match'));
for (const s of IMG_NEG) it(`img-: "${s}"`, () => assert(!P.IMAGE_REQUEST_RES.some(r => r.test(s)), 'false positive'));

it('file-ref+: "update this file"', () => assert(hits(P.FILE_REF_RE, 'update this file please')));
it('file-ref+: "fix that handler.js"', () => assert(hits(P.FILE_REF_RE, 'fix that handler.js')));
it('file-ref-: "what is the plan"', () => assert(!hits(P.FILE_REF_RE, 'what is the plan')));
it('referential+: "email me those"', () => assert(hits(P.REFERENTIAL_RE, 'email me those addresses')));
it('referential-: "hello there"', () => assert(!hits(P.REFERENTIAL_RE, 'hello world')));

// ── Named-app / action-verb ──────────────────────────────────────────────────
section('NAMED_APP_RE / ACTION_VERB_RE');

it('named-app+: YouTube', () => assert(hits(P.NAMED_APP_RE, 'open youtube')));
it('named-app-: random noun', () => assert(!hits(P.NAMED_APP_RE, 'make a sandwich')));
it('action+: open/post/create', () => {
  assert(hits(P.ACTION_VERB_RE, 'open slack') && hits(P.ACTION_VERB_RE, 'post a tweet') && hits(P.ACTION_VERB_RE, 'create a page'));
});
it('action-: lookup verbs excluded (search/find)', () => assert(!hits(P.ACTION_VERB_RE, 'search for kittens')));

// ── stripUnresolvedTokens ────────────────────────────────────────────────────
section('stripUnresolvedTokens');

it('strips LAST_SUCCESSFUL / CONTRACT refs', () => {
  const out = P.stripUnresolvedTokens('Confirm the file at {{LAST_SUCCESSFUL.outputs.filePaths[0]}} please');
  assert(!out.includes('{{'), `leftover token: ${out}`);
  assert(out.includes('Confirm the file at'), 'prompt text preserved');
});
it('strips multiple token types', () => {
  const out = P.stripUnresolvedTokens('a {{PREV_OUTPUT}} b {{CONTRACT[0].outputs.stdout}} c {{synthesisAnswer}}');
  assert(!/\{\{/.test(out), `leftover: ${out}`);
});
it('leaves non-token braces alone', () => {
  const out = P.stripUnresolvedTokens('answer {{randomThing}} stays');
  assert(out.includes('{{randomThing}}'), 'generic {{x}} should not be stripped here');
});
it('non-string input passes through', () => {
  assert(P.stripUnresolvedTokens(null) === null && P.stripUnresolvedTokens(5) === 5);
});

// ── Retrieval gates ──────────────────────────────────────────────────────────
section('Retrieval-mode gates');

it('profile+: "what\'s my name"', () => assert(hits(P.PROFILE_QUERY_PATTERN, "what's my name")));
it('alltime+: "first memory ever"', () => assert(hits(P.ALL_TIME_QUERY_PATTERN, 'what is the first memory you have')));
it('convrecall+: "did I send messages about X"', () => assert(hits(P.CONV_RECALL_QUERY_RE, 'did I send messages about the trip')));
it('legacy+: "conversation about X"', () => assert(hits(P.LEGACY_RECALL_RE, 'the conversation about budget')));

// ── hasRelativeTimePhrase (parseDateRange) ───────────────────────────────────
section('hasRelativeTimePhrase (parseDateRange)');

it('relative+: "last couple days"', () => assert(hasRelativeTimePhrase('what did we chat about the last couple days')));
it('relative+: "3 weeks ago"', () => assert(hasRelativeTimePhrase('messages from 3 weeks ago')));
it('relative+: "yesterday"', () => assert(hasRelativeTimePhrase('what did I do yesterday')));
it('relative-: "on January 5th"', () => assert(!hasRelativeTimePhrase('what happened on January 5th')));

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(72)}`);
console.log(`  ${_passed} passed, ${_failed} failed`);
if (_failures.length) _failures.forEach(f => console.log(`   - ${f}`));
console.log('═'.repeat(72));
process.exit(_failed ? 1 : 0);
