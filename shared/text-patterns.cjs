'use strict';

/**
 * text-patterns.cjs — Canonical catalog of cross-cutting text guards/patterns.
 *
 * Single source of truth for user-utterance and plan-shape detection shared by
 * comms-graph, stategraph-module, and command-service. These patterns used to
 * be inline copies that drifted apart (e.g. the "chatt"/"talkin" STT-truncation
 * fix had to land in three files). Update a pattern HERE, not at a call site.
 *
 * Roles these patterns play:
 *   - Fail-open safety upgrades: a MISS falls through to the LLM classifier
 *     (usually correct); a HIT deterministically routes to the safer/deeper
 *     path. Brittleness to novel phrasing is acceptable in this direction.
 *   - Defined-syntax parsing (template tokens) — regex is the correct tool.
 *   - Retrieval-mode gates inside memory retrieval.
 *
 * NOT here (stay local to their file):
 *   - Security denylists (shell.run BLOCKED/DANGEROUS patterns)
 *   - browser.agent domain regexes (commerce/login-wall/search syntax)
 *   - executeCommand's generic {{ident}} placeholder validator
 *     (different purpose: arg validation, not known-token stripping)
 *   - DOM-instruction verb detection in browser.agent (_DOM_ACTION_VERB_RE —
 *     deliberately different semantics from ACTION_VERB_RE below)
 */

// ── Conversation recall ──────────────────────────────────────────────────────

/**
 * Tolerant conversation-recall guard — catches meta-questions about the chat
 * transcript across phrasings AND voice-transcription truncations
 * ("chatt", "talkin", "discussin", contractions like "we've").
 * Consumers: comms-graph classify (→ handoff), intentGuesser memory_retrieve.
 */
const CONVERSATION_RECALL_RE = new RegExp([
  // explicit transcript nouns: "our previous conversation", "the chat history"
  '\\b(our|your|my|previous|past|prior|earlier|the)\\s+(?:\\w+\\s+){0,2}(conversations?|chats?|chat\\s*(?:history|logs?)|conversation\\s*(?:history|logs?)|discussions?)\\b',
  // "what have we been talking/chatting about", "we've been chatting about what"
  '\\b(?:we|i)(?:\'(?:ve|re))?\\s+(?:have|had|were|are|been)\\s+.{0,20}?\\b(?:talk\\w*|chat\\w*|discuss\\w*|spoke|went\\s+over|covered)\\b',
  // "did we talk about X", "have we discussed/chatted"
  '\\b(?:did|have|had)\\s+we\\s+(?:talk\\w*|chat\\w*|discuss\\w*|speak|go\\s+over|cover|mention)\\b',
  // "what did I (just) ask/say/tell you", "what was my last question/prompt"
  '\\bwhat\\s+did\\s+i\\s+(?:just\\s+)?(?:ask|say|tell\\s+you|mention)\\b',
  '\\bwhat\\s+was\\s+my\\s+(?:last|first|previous)\\s+(?:question|prompt|message|request)\\b',
  // "remind me what we said", "look/pull up (our/the) conversation"
  '\\bremind\\s+me\\s+what\\s+we\\b',
  '\\b(?:look|pull|bring)\\s+up\\s+.{0,30}?\\b(?:conversations?|chats?)\\b',
  // "summarize/recap our conversation", "the messages we chatted/sent"
  '\\b(?:summarize|recap|sum\\s+up)\\s+.{0,20}?\\b(?:conversations?|chats?|discussed)\\b',
  '\\bmessages?\\s+we\\s+(?:chatted|talked|sent|discussed|exchanged)\\b',
  // "no/any conversation with you (at all)", "conversations with you"
  '\\bconversations?\\s+with\\s+(?:you|thinkdrop)\\b',
].join('|'), 'i');

/**
 * Narrow meta-question variant — gates the isConversationRecall flag inside
 * classifyTask (which decides whether answer.js injects chat history).
 * Intentionally narrower than CONVERSATION_RECALL_RE: broad topical recall
 * phrasing would over-trigger the transcript-injection path.
 */
const CONVERSATION_RECALL_META_RE = /\b(?:what did i (?:just )?ask(?:ed)?|what did i (?:just )?say|what did we talk about|what were we (?:just )?talking about|what did we discuss|did we (?:talk|speak|chat|discuss)|have we (?:talked|discussed|spoken|mentioned)|what was my (?:last|previous|recent) (?:question|prompt|message)|what did you (?:just )?say|what did i ask you .* ago|summarize our conversation|what have we been (?:discussing|talking about)|repeat what i said|remind me what we were talking about|go back to what i said (?:earlier|before)|look (?:that |it )? up in (?:your |the )?(?:memory|conversation|chat|history)|check (?:your |the )?(?:memory|conversation|chat|history)|in our (?:conversation|chat|history))\b/i;

/**
 * Retrieval-side recall query detector (subject+noun pairs) — decides whether
 * retrieveMemory should treat the query as transcript recall vs episodic memory.
 */
const CONV_RECALL_QUERY_RE = /\b(did i|have i|i'?ve|list my|repeat my|my (last|recent|past|previous)|what did (i|we)|what was (the|my) (last|first|previous)|what were (my|the)|show (me )?my)\b.{0,60}\b(prompt\w*|messages?|emails?|texts?|ask\w*|sen[dt]\w*|search\w*|sa(y|id)|talk\w*|discuss\w*|chat\w*|conversation\w*|request\w*|question\w*|wrote|regarding|about)\b/i;

/** Legacy narrow fallback for "conversation/chat about X" phrasings. */
const LEGACY_RECALL_RE = /\b(conversation|chat|talk|discussed|talking)\s+(about|regarding|on|where)\b/i;

// ── Follow-up / consent ──────────────────────────────────────────────────────

/** Bare affirmation/consent — a CLOSED word class; regex is the right tool. */
const BARE_AFFIRM_RE = /^(?:yes|yeah|yep|yup|sure|ok(?:ay)?|go\s+ahead|do\s+it|yes\s+you\s+can|please\s+do|sounds?\s+good|absolutely|definitely|of\s+course|please)$/;

/** Assistant-side offer phrasing — pairs with BARE_AFFIRM_RE: affirmation +
 *  preceding offer = the user wants the offered action done (→ handoff). */
const OFFER_RE = /\b(?:would you like me to|want me to|shall i|should i|do you want me to|i can|i could|let me know if you'?d like|if you'?d like)\b/i;

/** Bare conversational follow-ups reacting to the last assistant turn. */
const BARE_FOLLOWUPS = new Set([
  'why', 'why not', 'how come', 'what do you mean', 'huh', 'really',
  'seriously', 'what', 'and', 'so', 'ok', 'okay',
]);

// ── File-write intent ────────────────────────────────────────────────────────

/** Write/create verbs — signal that a referenced path is a DESTINATION
 *  (may not exist yet), not a source to read. */
const FILE_WRITE_VERB_RE = /\b(save|saving|write|writing|create|creating|export|download|put|store|generate|move|copy|rename)\b/i;

/** File-ish nouns that pair with a write verb to signal a file-authoring goal. */
const FILE_NOUN_RE = /\b(file|\.md|\.txt|\.html?|\.jsx?|\.tsx?|\.py|\.css|code|content|script|document|markdown)\b/i;

/** Explicit file path with extension — the most reliable write-goal signal. */
const EXPLICIT_FILE_PATH_RE = /(?:~|\/|[A-Za-z]:\\)[\w.\-\\/ ]*\.[A-Za-z0-9]{1,10}\b/;

/**
 * isFileWriteGoal(goal) — detect a shell.run goal that writes file content.
 * Primary signal: an explicit path-with-extension in the goal ("write the code
 * to ~/Desktop/three.md"). Secondary: write-verb + file-noun pair. Verbs alone
 * are deliberately NOT enough — too brittle ("open the file" is a read).
 */
function isFileWriteGoal(goal) {
  const g = String(goal || '');
  if (!g) return false;
  if (EXPLICIT_FILE_PATH_RE.test(g) && FILE_WRITE_VERB_RE.test(g)) return true;
  return FILE_WRITE_VERB_RE.test(g) && FILE_NOUN_RE.test(g);
}

// ── Time phrasing / episodic ─────────────────────────────────────────────────

/**
 * Episodic-recall markers — past-activity phrasing ("what was I watching on
 * Netflix"). Used by intentGuesser; distinct from hasRelativeTimePhrase in
 * stategraph-module/parseDateRange.js which sanity-checks date-range output.
 */
const EPISODIC_RE = /\b(yesterday|last\s+(night|week|time|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|this\s+(morning|afternoon)|earlier(\s+today)?|a\s+(few|couple)\s+(minutes|hours|days|weeks)\s+ago|the\s+other\s+day|what\s+was\s+i|was\s+i\s+(watching|listening|reading|playing|browsing|looking)|what\s+did\s+i|what\s+was\s+on\s+my\s+screen)\b/i;

// ── Media / image requests ───────────────────────────────────────────────────

/** Image/picture request phrasings — route to web_search (image carousel),
 *  not command_automate. Checked before the single-step short-circuit. */
const IMAGE_REQUEST_RES = [
  /\bshow\s+me\s+(a\s+|an\s+|the\s+|some\s+)?(picture|image|photo|pic|logo|icon)s?\s+(of|for)\b/i,
  /\b(show|find|search\s+for|look\s+up|get\s+me)\s+(a\s+|an\s+|the\s+|some\s+)?(picture|image|photo|pic|logo|icon)s?\s+(of|for)\b/i,
  /\bwhat\s+does\s+.+\s+look\s+like\b/i,
  /\b(can\s+i\s+see|let\s+me\s+see)\s+(a\s+|an\s+|the\s+)?(picture|image|photo|pic|logo|icon)\b/i,
];

// ── Deictic / file references in follow-ups ──────────────────────────────────

/** Generic deictic/anaphoric words signalling a follow-up reference. */
const REFERENTIAL_RE = /\b(this|that|these|those|it|them|they|above|previous|last|again)\b/i;

/** Explicit file-artifact references ("this file", "that script.js") — gates
 *  injection of the live IDE open-file context into classification. */
const FILE_REF_RE = /\b(?:this|that|the|open|current|active)\s+(?:file|script|code|function|class|method|component|module)\b|\b(?:this|that|the)\s+\w+\.(?:ts|js|tsx|jsx|py|cjs|mjs|md|json|sh|bash)\b|\b(?:open|current|active)\s+(?:file|tab|editor|buffer)\b/i;

// ── Named apps / action verbs (comms-graph fast-path) ────────────────────────

/** Named apps/sites that indicate command_automate (not web_search). */
const NAMED_APP_RE = /\b(chatgpt|chat\s*gpt|openai|claude|anthropic|perplexity|grok|x\.ai|gmail|google\s*mail|youtube|yt|amazon|twitter|x\.com|tweet|reddit|github|git\s*hub|notion|slack|spotify|netflix|whatsapp|telegram|discord|linkedin|facebook|instagram|tiktok|maps|google\s*maps|apple\s*music|zoom|figma|vscode|vs\s*code|safari|chrome|firefox|edge|word|excel|powerpoint|outlook|calendar|dropbox|drive|google\s*docs|google\s*sheets|google\s*slides)\b/i;

/** User-action verbs paired with a named app → command_automate. Lookup verbs
 *  intentionally excluded ("search X on YouTube" is web_search). NOTE: do not
 *  confuse with browser.agent's _DOM_ACTION_VERB_RE (instruction verbs). */
const ACTION_VERB_RE = /\b(open|close|send|post|share|create|make|new|delete|remove|cancel|navigate|go\s+to|launch|start|stop|schedule|remind|update|edit|modify|change|rename|fill|submit|download|upload|copy|paste|click|type|press|install|uninstall|sign\s+in|log\s+in|log\s+out|play|pause|watch|listen|order|book|buy|shop|browse|scroll|refresh|reload|turn|toggle|enable|disable|connect|disconnect|pair|mute|unmute|record|print|quit|restart|shut\s*down|lock|unlock|sleep|wake|minimize|maximize|screenshot|snap|capture|adjust|set)\b/i;

// ── Plan-template tokens ─────────────────────────────────────────────────────

/** Known plan-contract tokens — strips unresolved {{...}} refs from prompts.
 *  Distinct from executeCommand's generic {{ident}} validator (arg checking).
 *  Exported as a function: a shared /g regex would leak lastIndex across
 *  modules if anyone called .test()/.exec() on it — the function is safe. */
const _UNRESOLVED_TOKEN_SRC = '\\{\\{(?:CONTRACT\\[\\d+\\]|PREV_CONTRACT|PREV_OUTPUT|PREV_OUTPUT_FILE|prev_stdout|LAST_SUCCESSFUL|LAST_WITH_OUTPUT|synthesisAnswer|user\\.agent\\.[^}]*)(?:\\.[^}]*)?\\}\\}';
function stripUnresolvedTokens(s) {
  return typeof s === 'string' ? s.replace(new RegExp(_UNRESOLVED_TOKEN_SRC, 'g'), '') : s;
}

// ── Retrieval-mode gates (retrieveMemory) ────────────────────────────────────

/** "what's my X" profile-fact queries — skip date-range inheritance. */
const PROFILE_QUERY_PATTERN = /^(what'?s|what is|who is|who'?s|where is)\s+(my|i am|am i)\b|^what (type|kind|sort) of (person|man|woman|human|individual)/i;

/** "first/earliest/ever" queries — search all history, no time window. */
const ALL_TIME_QUERY_PATTERN = /\b(first|earliest|ever|all time|oldest|very first|all history)\b/i;

module.exports = {
  CONVERSATION_RECALL_RE,
  CONVERSATION_RECALL_META_RE,
  CONV_RECALL_QUERY_RE,
  LEGACY_RECALL_RE,
  BARE_AFFIRM_RE,
  OFFER_RE,
  BARE_FOLLOWUPS,
  FILE_WRITE_VERB_RE,
  FILE_NOUN_RE,
  EXPLICIT_FILE_PATH_RE,
  isFileWriteGoal,
  EPISODIC_RE,
  IMAGE_REQUEST_RES,
  REFERENTIAL_RE,
  FILE_REF_RE,
  NAMED_APP_RE,
  ACTION_VERB_RE,
  stripUnresolvedTokens,
  PROFILE_QUERY_PATTERN,
  ALL_TIME_QUERY_PATTERN,
};
