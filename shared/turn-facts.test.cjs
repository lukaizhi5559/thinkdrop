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
// Bare "the plan" carries NO referent — recall binds by name only now, and
// there is no name to resolve. The old catch-all used to fabricate a token.
f = computeTurnFacts({ rawText: 'what happened with the plan' });
assert(f.planRef === null, `bare "the plan" must not produce a referent: ${JSON.stringify(f.planRef)}`);
f = computeTurnFacts({ rawText: 'the plan' });
assert(f.planRef === null, 'bare "the plan" → null');
f = computeTurnFacts({ rawText: 'we have a plan' });
assert(f.planRef === null, '"we have a plan" is not a referent');
// Definite referents still extract — the +descriptor and X-before-plan forms.
f = computeTurnFacts({ rawText: 'the plan for lunch' });
assert(f.planRef && f.planRef.token === 'lunch' && f.planRef.meaningful, `planRef: ${JSON.stringify(f.planRef)}`);
f = computeTurnFacts({ rawText: 'a career plan would help' });
assert(f.planRef && /career/i.test(f.planRef.token), `planRef: ${JSON.stringify(f.planRef)}`);
// "a plan for X" is an indefinite draft request, never a referent — the
// existence-question surface is planAsk below, not a bindable name.
f = computeTurnFacts({ rawText: 'a plan for lunch sounds good' });
assert(f.planRef === null, 'indefinite "a plan for X" → null');
f = computeTurnFacts({ rawText: 'do we have a plan for the picnic' });
assert(f.planRef === null, 'indefinite existence ask is not a referent');
// A clause before "plan" is not a name — >4 content words rejects it even
// though the regex still matches ("the idea I brought up forgot that plan").
f = computeTurnFacts({ rawText: "I don't want that plan I want to discuss the idea I brought up forgot that plan" });
assert(f.planRef && !f.planRef.meaningful, `clause-length referent rejected: ${JSON.stringify(f.planRef)}`);

// planTimeScope — plan word + past-facing time phrase.
f = computeTurnFacts({ rawText: 'what plans did I do last week' });
assert(/last\s+week/i.test(f.planTimeScope || ''), `planTimeScope: ${f.planTimeScope}`);
f = computeTurnFacts({ rawText: 'show me the plans from march 14' });
assert(f.planTimeScope, `planTimeScope: ${f.planTimeScope}`);
f = computeTurnFacts({ rawText: 'what plans did I do on tuesday' });
assert(/tuesday/i.test(f.planTimeScope || ''), `planTimeScope: ${f.planTimeScope}`);
f = computeTurnFacts({ rawText: 'make a plan for tomorrow' });
assert(!f.planTimeScope, 'tomorrow is forward-facing — no recall scope');
f = computeTurnFacts({ rawText: 'last week was rough' });
assert(!f.planTimeScope, 'time phrase without "plan" is not a scope');

// planAsk — plan-existence phrasing (informational only, never binds).
f = computeTurnFacts({ rawText: 'do we have a plan for the picnic' });
assert(f.planAsk, 'existence ask registers');
f = computeTurnFacts({ rawText: 'i thought we had a plan for the move' });
assert(f.planAsk, '"i thought we had" registers');
f = computeTurnFacts({ rawText: 'what plans do I have' });
assert(f.planAsk, '"what plans" registers');
f = computeTurnFacts({ rawText: 'build a plan for the launch' });
assert(!f.planAsk, 'imperative draft request is not an existence ask');

// logMention only on userText.
f = computeTurnFacts({ rawText: '[Highlighted: check the logs]\n\nwhat does warn mean' });
assert(!f.logMention, 'quoted log mention must not trigger');

console.log('turn-facts.test.cjs: all assertions passed');
