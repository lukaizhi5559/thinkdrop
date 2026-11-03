'use strict';

/**
 * rule-guard.cjs — command-prescription guard for learned context rules.
 *
 * Rules may carry FACTS ("site requires OAuth", "this page needs login") but
 * never concrete commands or skill routing — a stored "use browser.act /
 * waitForStableText" becomes a durable prescription that injects itself into
 * unrelated later runs (observed: a job-application-form rule poisoned a
 * session-less task with a browser.act step that could never run).
 *
 * ONE canonical RX shared by every rule-write path:
 *   - stategraph evaluateSkills verdicts (context_rule.upsert)
 *   - command-service cli.agent save_rule (agent-loop learned rules)
 *   - command-service browser.act diagnose/examine auto-writes
 */

const ROUTING_RX = /npm\s+i(?:nstall)?\b|brew\s+install\b|pip3?\s+install\b|apt(?:-get)?\s+install\b|\b(?:shell\.run|cli\.agent|browser\.agent|browser\.act|app\.agent|web\.agent|web\.crawl|turn\.loop\.agent|dom\.act|url\.first\.agent|tab\.map\.agent|form\.fill\.agent|playwright\.agent|video\.agent|edit\.agent|doc\.read|fs\.(?:read|search|stat)|dir\.list|mcp\.agent|build_agent)\b|\b(?:scan_page|navigate_url|read_url|nav_task|print_page|save_rule|ask_user)\b|\b(?:run|execute|invoke)\s+(?:open|curl|wget|osascript|node|python3?|bash|zsh|sh)\b|\bwaitForStableText\b|\bgetPageText\b|\bplaywright-cli\b|(?:use|prefer|try|switch\s+to)\s+[\w.-]*\.(?:agent|act|crawl)\b|do\s+not\s+use\s+(?:a\s+)?[\w.-]*\.?(?:agent|act|run|crawl)\b/i;

/**
 * @param {string} ruleText
 * @returns {boolean} true when the rule prescribes commands/routing rather
 *   than facts — callers must skip the write.
 */
function rulePrescribesRouting(ruleText) {
  return ROUTING_RX.test(String(ruleText || ''));
}

module.exports = { rulePrescribesRouting, ROUTING_RX };
