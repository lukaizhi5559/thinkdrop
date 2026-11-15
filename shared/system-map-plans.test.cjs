'use strict';
/* Tests for scoped plan recall — run: node shared/system-map-plans.test.cjs
 *
 * findPlansByName scores name/title/planId ONLY (never prompt/task content);
 * planWindowFor resolves past-facing phrases to ms windows; plansInWindow
 * lists plans by created OR mtime. findPlans' content fuzz stays available
 * only to the in-lane plan.find tool.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sysmap-plans-'));
process.env.THINKDROP_PLANS_DIR = tmp;

const sysMap = require('./system-map.cjs');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();

function plan(id, { name = '', title = 'Untitled', prompt = '', status = 'ready', created = iso(NOW - 2 * DAY), tasks = [] } = {}) {
  const body = [
    '---',
    `id: ${id}`,
    `created: ${created}`,
    'kind: task_plan',
    `status: ${status}`,
    `original_prompt: "${prompt.replace(/"/g, '\\"')}"`,
    'plan_session_id: test',
    '---',
    '',
    `# Plan: ${title}`,
    '',
    '## Tasks',
    '',
    ...tasks.map((t, i) => `## Task ${i + 1} — ${t}\n- **Prompt**: do ${t}\n- **Status**: ⬜ pending\n- **Result**: —\n`),
  ].join('\n');
  const fp = path.join(tmp, `${id}.md`);
  fs.writeFileSync(fp, body);
  // Backdate mtime to `created` so window tests exercise `created` matching —
  // otherwise every fresh file hits via mtime and the window is meaningless.
  const ts = Date.parse(created) / 1000;
  fs.utimesSync(fp, ts, ts);
  return id;
}

plan('plan_nylas', { name: 'nylas.setup', title: 'Set up Nylas email', prompt: 'set up my nylas email', tasks: ['auth nylas', 'verify scopes'] });
plan('plan_career', { name: 'career.pivot', title: 'Career pivot research', prompt: 'help me think about a career change', status: 'drafting', created: iso(NOW - 10 * DAY), tasks: ['research roles'] });
plan('plan_shot', { name: 'screenshot.tool', title: 'Screenshot analysis', prompt: 'take screenshots', status: 'done', created: iso(NOW - 40 * DAY) });
plan('plan_lunch', { name: 'lunch.party', title: 'Lunch party', prompt: 'plan a lunch for the team', created: iso(NOW - 1 * DAY) });

// ── findPlansByName — name/title/ID only ────────────────────────────────────

let hits = sysMap.findPlansByName('nylas');
assert(hits.length === 1 && hits[0].planId === 'plan_nylas', `name hit: ${JSON.stringify(hits.map(h => h.planId))}`);

hits = sysMap.findPlansByName('career pivot');
assert(hits.length === 1 && hits[0].planId === 'plan_career', `title tokens hit: ${JSON.stringify(hits.map(h => h.planId))}`);

hits = sysMap.findPlansByName('plan_shot');
assert(hits.length === 1 && hits[0].planId === 'plan_shot', 'planId exact');

// Content fields must NOT match — the "career change" words live in
// originalPrompt of plan_career AND nowhere in name/title.
hits = sysMap.findPlansByName('email');
assert(hits.length === 1 && hits[0].planId === 'plan_nylas', 'title word still matches');
hits = sysMap.findPlansByName('roles');
assert(hits.length === 0, `task-title content must not match: ${JSON.stringify(hits.map(h => h.planId))}`);
hits = sysMap.findPlansByName('screenshots');
assert(hits.length === 0, 'prompt-only content must not match');
hits = sysMap.findPlansByName('We have a');
assert(hits.length === 0, 'junk token must not match');
hits = sysMap.findPlansByName('idea I brought up forgot that');
assert(hits.length === 0, 'clause token must not match');

// ── planWindowFor ────────────────────────────────────────────────────────────

let w = sysMap.planWindowFor('what plans did i do last week', NOW);
assert(w && (NOW - w.fromMs) <= 8 * DAY && w.toMs >= NOW - 1, `last week window: ${JSON.stringify(w)}`);

w = sysMap.planWindowFor('plans from yesterday', NOW);
assert(w && w.fromMs === w.toMs - DAY + 1 && (NOW - w.fromMs) >= DAY, `yesterday window: ${JSON.stringify(w)}`);

w = sysMap.planWindowFor('what plans did i do on tuesday', NOW);
assert(w && new Date(w.fromMs).getDay() === 2 && w.fromMs <= NOW, `tuesday window: ${JSON.stringify(w)}`);

w = sysMap.planWindowFor('plans on march 14', new Date('2025-06-01T12:00:00').getTime());
assert(w && new Date(w.fromMs).getMonth() === 2 && new Date(w.fromMs).getDate() === 14, `mar 14: ${JSON.stringify(w)}`);

w = sysMap.planWindowFor('plans in march', new Date('2025-06-15T12:00:00').getTime());
assert(w && new Date(w.fromMs).getMonth() === 2 && new Date(w.fromMs).getDate() === 1, `in march: ${JSON.stringify(w)}`);

w = sysMap.planWindowFor('plans from 3/14', new Date('2025-06-01T12:00:00').getTime());
assert(w && new Date(w.fromMs).getMonth() === 2 && new Date(w.fromMs).getDate() === 14, `3/14: ${JSON.stringify(w)}`);

w = sysMap.planWindowFor('plans 3 days ago', NOW);
assert(w && Math.abs(NOW - w.toMs - 2 * DAY) < DAY, `3 days ago: ${JSON.stringify(w)}`);

w = sysMap.planWindowFor('make a plan for tomorrow', NOW);
assert(w === null, 'tomorrow is not past-facing');
w = sysMap.planWindowFor('tell me a joke', NOW);
assert(w === null, 'no phrase → null');

// ── plansInWindow — created OR mtime ─────────────────────────────────────────

let plans = sysMap.plansInWindow({ fromMs: NOW - 3 * DAY, toMs: NOW });
const ids3 = plans.map(p => p.planId).sort();
assert(ids3.includes('plan_nylas') && ids3.includes('plan_lunch') && !ids3.includes('plan_career'),
  `3-day window: ${JSON.stringify(ids3)}`);

plans = sysMap.plansInWindow({ fromMs: NOW - 45 * DAY, toMs: NOW - 35 * DAY });
assert(plans.length === 1 && plans[0].planId === 'plan_shot', `40-day window: ${JSON.stringify(plans.map(p => p.planId))}`);

console.log('system-map-plans.test.cjs: all assertions passed');
