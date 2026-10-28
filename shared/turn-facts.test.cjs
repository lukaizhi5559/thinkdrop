'use strict';
/* Unit test for turn-facts.computeTurnFacts — run: node shared/turn-facts.test.cjs */

const assert = require('assert');
const { computeTurnFacts } = require('./turn-facts.cjs');

// ── Blob isolation — the reported bugs ──────────────────────────────────────
// A [Highlighted:] blob quoting plan-adjacent text must not produce facts.
let f = computeTurnFacts({
  rawText: '[Highlighted: My current plan narrows the blast radius]\n\nwhat does lexical in layman terms mean in this context',
});
assert(f.userText === 'what does lexical in layman terms mean in this context', `userText: ${f.userText}`);
assert(f.planRef === null || !/my current/i.test(f.planRef.token), `planRef leaked: ${JSON.stringify(f.planRef)}`);
assert(f.isQuestion, 'vocab question should read as a question');
assert(!f.exitish && !f.cancelish, 'no control verdicts on a vocab question');
assert(f.hasSelectionContext, 'highlighted blob counts as selection context');

// Quoted exit phrase inside a selection must NOT register exitish.
f = computeTurnFacts({
  rawText: '[Highlighted: get out of plan mode now]\n\nwhat does this mean',
});
assert(!f.exitish, `quoted exit phrase must not be exitish: ${f.userText}`);

// Typed control phrases still work.
f = computeTurnFacts({ rawText: 'stop planning' });
assert(f.exitish, 'typed exit is exitish');
f = computeTurnFacts({ rawText: 'get out of plan mode' });
assert(f.exitish && !f.exitishInline, 'anchored exit registers');
f = computeTurnFacts({ rawText: 'can you exit plan mode please' });
assert(f.exitish && f.exitishInline, 'mid-sentence exit registers as inline');
f = computeTurnFacts({ rawText: 'sounds good do it' });
assert(f.confirmish, 'confirm phrase is confirmish');
f = computeTurnFacts({ rawText: 'cancel the plan' });
assert(f.cancelish, 'cancel registers');
assert(!f.isQuestion, 'cancel is not a question');

// Attachments become facts — File/Folder chips don't count as selection content.
f = computeTurnFacts({
  rawText: '[File: /tmp/a.rtf]\n[Folder: /tmp/songs]\n\nupdate the verses',
});
assert(f.attachments.length === 2 && f.attachments[0].kind === 'file', `attachments: ${JSON.stringify(f.attachments)}`);
assert(!f.hasSelectionContext, 'file/folder chips alone are not selection context');
assert(f.userText === 'update the verses', `userText: ${f.userText}`);

// planRef on clean user text — "the nylas plan" extracts the referent.
f = computeTurnFacts({ rawText: 'continue the nylas plan' });
assert(f.planRef && /nylas/i.test(f.planRef.token) && f.planRef.meaningful, `planRef: ${JSON.stringify(f.planRef)}`);
// Bare "the plan" with a long prefix captures the phrase — the findPlans
// score floor is what stops it binding a random plan.
f = computeTurnFacts({ rawText: 'what happened with the plan' });
assert(f.planRef && f.planRef.meaningful, 'prefix phrase is meaningful');
assert(f.planRef.informational, 'what-question is informational');
f = computeTurnFacts({ rawText: 'the plan' });
assert(f.planRef && !f.planRef.meaningful, 'bare "the plan" is not meaningful');

// logMention only on userText.
f = computeTurnFacts({ rawText: '[Highlighted: check the logs]\n\nwhat does warn mean' });
assert(!f.logMention, 'quoted log mention must not trigger');

console.log('turn-facts.test.cjs: all assertions passed');
