'use strict';

// Plan-lane control phrases — shared so they're unit-testable (main.js can't
// be imported outside Electron). These are the DETERMINISTIC BACKSTOP layer:
// typed text + pipeline voice finals + realtime transcript checks run them
// through _matchPlanCheckAction, which self-gates on live state — a false
// positive with no active lane/pending card/live run is a no-op.
//
// Talk Mode's PRIMARY path is semantic instead: the realtime model calls
// thinkdrop_control with an enum command — no text parsing at all.

// Lane exit — "stop planning" / "exit plan mode". Targets the planning LANE,
// not the plan artifact: bare "cancel the plan"/"stop the plan" keep cancel
// semantics. Fully anchored so "plan a party"/"run the plan" fall through.
const PLANNING_EXIT_RE = /^(?:\/)?\s*(?:(?:stop|exit|leave|end|quit|close|disable|finish|drop|cancel|get\s+out\s+of)\s+(?:the\s+|this\s+|that\s+|all\s+)?planning(?:\s+mode)?|(?:exit|leave|quit|end|close|stop|disable|cancel|get\s+out\s+of)\s+(?:the\s+|this\s+)?plan\s+mode|(?:turn|switch)\s+off\s+plan(?:ning)?(?:\s+mode)?|plan(?:ning)?\s+mode\s+off|planning\s+off|done\s+(?:with\s+)?planning|no\s+more\s+planning)\s*[.!?]*$/i;

// Mid-sentence exit — "why don't you get out of plan mode", "can you exit
// plan mode please". Unanchored but noun-locked: the verb must sit directly
// before a literal "plan mode"/"planning mode", so "stop planning the
// wedding" and "talk about exiting plan mode" (no `exit\b`) don't hit.
// Whatever this misses, the thinkdrop_control tool path covers semantically.
const PLANNING_EXIT_INLINE_RE = /\b(?:exit|leave|quit|get\s+out\s+of|step\s+out\s+of|hop\s+out\s+of|stop|end|close|disable)\s+(?:the\s+|this\s+|that\s+|my\s+)?plan(?:ning)?\s+mode\b|\bstop\s+planning\s*(?:now|please|it|this|that|for\s+now)?\s*[.!?]*$/i;

// Negation veto — only when the negation binds an EXIT verb. "don't exit"
// vetoes; "why don't you just get out" doesn't ('you' isn't an exit verb —
// rhetorical "why don't you X" means DO X). "keep planning"/"stay in plan
// mode" veto outright.
const PLANNING_EXIT_NEG_RE = /(?:don'?t|do\s+not|never)\s+(?:(?:just|really|actually|please)\s+)*(?:exit|leave|quit|stop|end|close|disable|cancel|drop|finish|get\s+out|step\s+out)\b|\bkeep\b|\bstay\s+in\b/i;

// Run-confirm — "do it" / "run it" / "yes go" when a plan has tasks. Same
// backstop role as the exit phrases: main.js intercepts typed/voice text, and
// planning.cjs applies it inside the planning node so an LLM that paraphrases
// ("starting the plan check…") instead of emitting <plan_run/> can't silently
// swallow the user's execution request.
const PLAN_CONFIRM_RE = /^(yes|yeah|yep|yup|sure|ok|okay|approve|approved|confirm|confirmed|go ahead|do it|looks good|sounds good|perfect|please do|go for it|absolutely|definitely|of course|(?:lets|let's) (?:do it|go|run it))$/i;
const PLAN_RUN_RE = /^(?:(?:just|please|ok|okay|so|now|then|yeah|yes|alright|sure|lets|let's) )*(send|run|start|go|do|execute|ship|launch|proceed|continue|kick off|fire)(?: (it|this|that|the plan|the email|the task|the thing|the whole thing|everything|all|them|that thing))?(?: (?:out|off|ahead|now|through|on)){0,2}$/i;

// Negation/stop veto — "don't run it", "wait", "hold off", "cancel that"
// must never count as a confirm.
const PLAN_RUN_NEG_RE = /\b(?:don'?t|do\s+not|stop|wait|hold\s+(?:on|off)|cancel|never|not\s+yet)\b/i;

/**
 * Bare confirm/run phrase check for a planning lane with tasks.
 * @param {string} text - raw user text (typed or transcript)
 * @returns {boolean}
 */
function isPlanRunConfirm(text) {
  const t = String(text || '').toLowerCase().replace(/[.!?,;:'"]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 60 || PLAN_RUN_NEG_RE.test(t)) return false;
  return (t.length <= 45 && PLAN_RUN_RE.test(t)) || (t.length <= 30 && PLAN_CONFIRM_RE.test(t));
}

module.exports = { PLANNING_EXIT_RE, PLANNING_EXIT_INLINE_RE, PLANNING_EXIT_NEG_RE, PLAN_CONFIRM_RE, PLAN_RUN_RE, PLAN_RUN_NEG_RE, isPlanRunConfirm };
