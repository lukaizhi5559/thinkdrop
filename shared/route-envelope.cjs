'use strict';

/**
 * route-envelope.cjs — shared predicates over the RouteDecision envelope
 * produced by comms-graph's classifyTask (route-decision.cjs) and carried
 * through the handoff into the stategraph (state._taskClassification).
 *
 * ONE contract for both ends of the wire: comms-graph's dispatch layer and
 * the Electron stategraph must agree on what the envelope means.
 */

/**
 * nonSkillEnvelope — true when the envelope names a lane that the stategraph's
 * own pipeline must route (memory_retrieve, web_search, general_knowledge,
 * screen intents, thought-reply, clarify/decline resolutions) rather than a
 * compiled _skillPlan. The _skillPlan fast-path bypasses every node/guard that
 * consumes these fields — a compiled plan must not preempt them.
 *
 * (observed: envelope {isActivityQuery:true, suggestedIntent:'memory_retrieve'}
 * still got shell.run steps compiled at dispatch — decompose skipped entirely
 * via the structural fast-path → browser-history shell query → "None found"
 * on an answerable recall question, task_fb887853)
 *
 * `command_automate` or a null/absent suggestedIntent keeps the skill lane.
 *
 * @param {object|null|undefined} rd  routeDecision / _taskClassification
 * @returns {boolean}
 */
function nonSkillEnvelope(rd) {
  return !!(rd && typeof rd === 'object' && (
    (rd.suggestedIntent && rd.suggestedIntent !== 'command_automate')
    || rd.isActivityQuery || rd.isConversationRecall
    || rd.isScreenOutput || rd.isThoughtReply
    || rd.needsFreshScreen || rd.isScreenFollowUp
    || rd.isAppUiInspection || rd.isSpatialAnalysis || rd.isImageAnalysis
    || rd.resolution === 'declined_ack' || rd.resolution === 'needs_clarification'
  ));
}

/**
 * skillEnvelope — true only when the envelope AFFIRMATIVELY describes
 * executable work (a task-shaped taskType or an explicit command_automate
 * suggestion), and no non-skill flag contradicts it. The compile-hoist and
 * the _skillPlan fast-path consume this: an abstaining envelope
 * (taskType=query + suggestedIntent=null) is not evidence of a task —
 * observed: "list details about the videos what they said" compiled to
 * mdfind shell.run when the abstain was treated as compile-eligible.
 */
const { ACTION_TASK_TYPES } = require(
  require('path').resolve(__dirname, '../stategraph-module/src/utils/routeTable.js')
);
function skillEnvelope(rd) {
  if (!rd || typeof rd !== 'object' || nonSkillEnvelope(rd)) return false;
  return ACTION_TASK_TYPES.has(rd.taskType) || rd.suggestedIntent === 'command_automate';
}

module.exports = { nonSkillEnvelope, skillEnvelope };
