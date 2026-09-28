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

/** Bare refusal/decline — the closed-class counterpart of BARE_AFFIRM_RE.
 *  Consumers: stategraph resolution contract (declined_ack), offer-decline
 *  detection. Keep anchored — never matches inside a longer message. */
const BARE_DECLINE_RE = /^(?:no|nope|nah|no\s+thanks|not\s+now|later|maybe\s+later|no\s+thank\s+you|i'?m\s+good|pass)$/;

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
const EPISODIC_RE = /\b(yesterday|recently|last\s+(night|week|time|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|this\s+(morning|afternoon)|earlier(\s+today)?|a\s+(few|couple)\s+(minutes|hours|days|weeks)\s+ago|the\s+other\s+day|what\s+was\s+i|was\s+i\s+(watching|listening|reading|playing|browsing|looking)|what\s+did\s+i|what\s+was\s+on\s+my\s+screen)\b/i;

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

/** Bare-deictic continuations — the referent is carried entirely by
 *  "that/this/it/…" with no content noun, so it can only be resolved from
 *  the conversation transcript. A quick tier cannot see the transcript
 *  (observed: "when was that" → general_quick hallucinated a date), and in
 *  the graph these are conversational referents — never the ambient screen
 *  file/url (observed: "tell me more about that" → classifyTask set
 *  activeDocRef:'file' + followUpTarget:'the plan file in Devin' and the
 *  answer discussed Devin planning instead of the prior recall). */
const DEICTIC_CONTINUATION_RE = new RegExp([
  // question word + aux + bare deictic subject: "when was that", "who is it"
  '\\b(?:when|what|who|where|which|why|how)\\s+(?:was|were|is|are|did|do|does|will|would|can|could|should)\\s+(?:that|this|it|those|these|them|they|he|she)\\b',
  // "tell me (more) about that", "what about that", "more on this"
  '\\b(?:tell me(?: more)? about|more about|what about|how about|expand on|elaborate on|go on about)\\s+(?:that|this|it|those|them)\\b',
].join('|'), 'i');

/** Screen-observation questions — "what's on my screen", "describe what I'm
 *  looking at", "read the text visible on screen". These need a live capture,
 *  so both comms (handoff guard) and the stategraph (screen_intelligence) key
 *  off this single vocabulary. Past-tense variants ("what was on my screen")
 *  are intentionally included: they hand off too (to memory_retrieve). */
const SCREEN_OBSERVATION_RE = new RegExp([
  // direct screen-surface questions
  '\\b(?:what\'?s\\s+on\\s+(?:my\\s+)?screen|what\\s+am\\s+i\\s+looking\\s+at|what\\s+i\'?m\\s+looking\\s+at|describe\\s+(?:what\'?s\\s+on|what\\s+i\'?m\\s+looking\\s+at)|read\\s+(?:what\'?s\\s+)?on\\s+screen|what\\s+(?:does|do)\\s+(?:my|the)\\s+screen\\s+show|what\\s+app\\s+am\\s+i\\s+(?:in|looking\\s+at|viewing|using|on)|what\'?s\\s+the\\s+active\\s+app|what\\s+window\\s+is\\s+open|analyze\\s+(?:the\\s+|my\\s+)?screen|scan\\s+(?:my\\s+)?screen|what\\s+app\\s+is\\s+(?:open|focused|running)|what\\s+program\\s+is\\s+running|what\\s+is\\s+currently\\s+displayed|check\\s+(?:this|the)\\s+\\w+\\s+on\\s+(?:my\\s+|the\\s+)?screen)\\b',
  // read/see/show + content word + visible/on-screen marker
  '\\b(?:read|see|show|tell\\s+me)\\b.{0,30}\\b(?:text|words|content|message|error|dialog)\\b.{0,30}\\b(?:visible|shown|displayed|on\\s+(?:my\\s+|the\\s+)?screen)\\b',
  // visible-on-screen tail
  '\\b(?:visible|displayed|showing|open)\\s+on\\s+(?:my\\s+|the\\s+)?screen\\b',
  // window/app chrome — passive reads of visible window metadata, gated on
  // an observation verb so imperatives ("rename the window title") stay out:
  // "read the title of that window", "what's the name of this app",
  // "what is the window title".
  '\\b(?:read|see|show|tell\\s+me|what|which|get|check|know)\\b[^.]{0,25}\\b(?:title|name)\\s+of\\s+(?:that|this|the|my|the\\s+current|the\\s+active)\\s+(?:window|app|application|tab|program)\\b',
  '\\b(?:read|see|show|tell\\s+me|what|which|get|check|know)\\b[^.]{0,25}\\b(?:window|app|application|tab)(?:\'?s)?\\s+(?:title|name)\\b',
  '\\bwhat\\s+(?:window|app|application|program|tab)\\s+is\\s+(?:that|this|there|active|open|focused|running)\\b',
  // locative — any wh-question about a thing "on (my|the) screen" observes it:
  // "what is that on my screen", "what is running on my screen"
  '\\bwhat\\s+(?:is|are)\\s+[^.]{0,25}\\bon\\s+(?:my\\s+|the\\s+)?screen\\b',
].join('|'), 'i');

/** Artifact nouns that can name a live ambient referent — an open file, the
 *  focused window, the active app, a visible tab. resolveReferencesV2 gates
 *  the getActiveAppContext fetch on this vocabulary (plus screen-observation
 *  and action+demonstrative shapes): a message with none of these cannot
 *  refer to the live app/file, so the ambient context is unused noise — and
 *  a misresolution temptation for bare deictics. */
const AMBIENT_ARTIFACT_RE = /\b(?:file|folder|document|doc|page|tab|window|app|application|screen|desktop|editor|browser|site|article|pdf|image|photo|picture|email|spreadsheet|presentation)\b/i;

/* Lexical inference for GhostLayer display requests. classifyTask's
 * screenOutputKind/screenOutputContent fields are individually flaky — when
 * they miss, the decompose guard's fetch-step heuristic misfires (observed:
 * "make confetti appear on my screen" → [web_search, screen_display], the
 * search ran first and its answer hallucinated "displayed on screen"). The
 * kind vocabulary mirrors screenOutput.js's payload builders so the same
 * utterance classifies identically at both layers. inferScreenOutput returns
 * { kind, content } — either may be null when nothing is lexically
 * determinable. Explicit literal content (a quoted string) wins over kind
 * inference: "show the word confetti on screen" is a text display. */
const SCREEN_EFFECT_RE  = /\b(emoji[\s-]?rain|fireworks?|confetti|snow|make\s+it\s+rain)\b/i;
const SCREEN_EMOJI_RE   = /\p{Extended_Pictographic}/u;
const SCREEN_IMG_URL_RE = /https?:\/\/\S+?\.(?:png|jpe?g|gif|webp|svg)(?:\?\S*)?/i;
const SCREEN_IMG_PATH_RE = /(?:~?\/[\w\-./ ]+?\.(?:png|jpe?g|gif|webp|svg))/i;
const SCREEN_ALERT_RE   = /\b(?:alert|warning|caution)\b/i;
const SCREEN_DECK_RE    = /\b(?:slides?|slide\s?deck|deck|slideshow|pitch\s*deck|presentation)\b/i;
const SCREEN_CHART_RE   = /\b(?:pie|donut|bar|line|area|scatter)?\s*(?:chart|graph)\b/i;

/** three.js/WebGL scene phrasing — "show a 3d starfield", "a spinning cube",
 *  "some particles". Marks the 'three' screen kind in inferScreenOutput. */
const SCREEN_THREE_RE   = /\b(?:3\s?-?d|three\.?js|webgl|starfield|particle\s+(?:field|wave|system|animation)|spinning\s+(?:cube|globe|torus|knot)|torus\s+knot|hologram|wireframe)\b/i;

/** Display verb + presentation-artifact noun — "show me a pie chart", "make a
 *  slideshow", "give me a line graph". Unlike SCREEN_OUTPUT_RE these need no
 *  "on screen" tail: a chart/deck is a presentation artifact, so the request
 *  is only satisfiable by painting it. Callers MUST still subtract the
 *  artifact-belongs-elsewhere cases before trusting a hit: file ops (chart
 *  goes to a file), named apps (chart goes inside Excel/Keynote — check
 *  NAMED_APP_RE / tc.targetService), observation and capture phrasing.
 *  Bare 'plot' is excluded from the kind list — too ambiguous ("the plot of
 *  the movie"); it stays in the verb list ("plot a bar chart"). */
const SCREEN_VISUAL_KIND_RE = new RegExp([
  '\\b(?:show|display|plot|draw|present|put\\s+up|make|create|generate|render|give\\s+me|pull\\s+up|bring\\s+up|visuali[sz]e)\\b[^.]{0,50}\\b(?:pie|donut|bar|line|area|scatter)?\\s*(?:chart|graph)\\b',
  '\\b(?:show|display|plot|draw|present|put\\s+up|make|create|generate|render|give\\s+me|pull\\s+up|bring\\s+up)\\b[^.]{0,50}\\b(?:slide\\s?deck|deck|slides?|slideshow|presentation)\\b',
].join('|'), 'i');

/** Artifact-into-app phrasing — "chart in Excel", "slides on PowerPoint",
 *  "make a deck in Keynote". A presentation kind word + containment
 *  preposition points the artifact INSIDE an app — combine with NAMED_APP_RE
 *  at the call site (the preposition alone hits "slides on my screen").
 *  Data-label hits don't match: "chart of browsers: arc, safari" — "of"
 *  and ":" are not containment prepositions. */
const VISUAL_INTO_APP_RE = /\b(?:charts?|graphs?|plots?|deck|slides?|slideshow|presentations?)\s+(?:in|on|into|inside|using|with|via)\s+/i;

/** Subjects whose data lives locally — "my task activity", "my task journal",
 *  "my usage". Used by the decompose guard to pick a command_automate gather
 *  step (journal_stats/sys_query templates) instead of web_search when a
 *  fetch is needed before display. DEVICE_STATE_RE covers the telemetry
 *  family (battery/disk/uptime); this covers the app-activity family. */
const LOCAL_DATA_SUBJECT_RE = /\b(?:my|the|our)\s+(?:task\s+)?(?:activit\w+|usage|productivity|task\s+(?:history|count|log|journal)|journal|conversations?\s+(?:history|count|log)|chat\s+history|message\s+count|screen\s+time)\b|\b(?:task|app|usage)\s+activit\w+\b/i;
const SCREEN_QUOTED_RE  = /["“]([^"”\n]{1,300})["”]|'([^'\n]{1,300})'/;
const SCREEN_DISPLAY_TAIL_RE = /\b(.+?)\s+on(?:to)?\s+(?:the\s+|my\s+)?screen\b/i;
const SCREEN_DISPLAY_VERB_RE = /\b(?:show|put|display|paint|write|post|flash|project)\b/i;
const SCREEN_CONTENT_LEAD_RE = /^(?:(?:the\s+|a\s+|an\s+)?(?:word|words|phrase|text|message|sentence)\s+|(?:that\s+)?(?:says?|reads?|saying)\s+)/i;

/** Lexical screen-output (GhostLayer) display signal — the same class comms'
 * screen_output_guard detects. classifyTask's isScreenOutput flag flakes
 * (observed: "look up the current bitcoin price and show it on my screen" →
 * flag missing → llmDecompose → command_automate). A display verb targeting
 * "on (my|the) screen", a clear/dismiss of the screen, or a self-contained
 * effect word marks the utterance deterministically; SCREEN_OBSERVATION_RE
 * callers subtract passive questions before trusting this. */
const SCREEN_OUTPUT_RE = new RegExp([
  '\\b(?:show|put|display|paint|write|post|flash|project)\\b[^.]{0,60}\\bon(?:to)?\\s+(?:the\\s+|my\\s+)?screen\\b',
  '\\bon\\s+screen\\s+(?:display|mode)\\b',
  '\\b(?:clear|hide|dismiss|wipe)\\s+(?:the\\s+|my\\s+)?screen\\b',
  '\\btake\\s+\\w+\\s+off\\s+(?:the\\s+|my\\s+)?screen\\b',
  '\\bmake\\s+it\\s+(?:rain|snow)\\b',
  '\\b(?:fireworks?|confetti|emoji[\\s-]?rain)\\b[^.]{0,40}\\bscreen\\b',
  '\\bscreen\\b[^.]{0,40}\\b(?:fireworks?|confetti|emoji[\\s-]?rain)\\b',
].join('|'), 'i');

/** Fetch-then-display shape: a lookup verb AND a display verb targeting the
 * screen — "look up the bitcoin price and show it on my screen". The display
 * half's referential 'it' suppresses the normal fetch heuristic, so the
 * lookup clause must re-enable it deterministically. */
const LOOKUP_THEN_DISPLAY_RE = /\b(?:look\s*up|lookup|search(?:\s+for)?|find|fetch|get|check|pull\s+up)\b[^.]{0,90}\b(?:show|put|display|paint|post)\b[^.]{0,45}\bon(?:to)?\s+(?:the\s+|my\s+)?screen\b/i;

/** Device-state questions — "what's my battery", "how much disk space",
 * "is my wifi on", "check my uptime". Fresh telemetry only exists via OS
 * tools (local_system → command_automate); a text tier can only hallucinate
 * it. Mirrors comms' live-data exclusion: freshness lives behind a tool. */
// A literal filesystem path in the message is ground truth the classifier
// cannot hallucinate away — "read the file /tmp/x.txt" flaked to
// taskType:'query' once and the passive intent hallucinated
// "I can't read files". Any POSIX path token means the task touches the
// filesystem. Requires a word-boundary char before '/' so URLs don't match.
const FILE_PATH_RE = /(?:^|[\s"'`(])\/(?:[\w.~-]+\/)+[\w.~-]+|(?:^|[\s"'`])~\/[\w.~/-]+|(?:^|[\s"'`])\.{1,2}\/[\w.~/-]+/;

// Screen CAPTURE, not display — "take a screenshot of my screen" flaked
// isScreenOutput:true once and the screen-output guard emitted a
// [web_search, screen_display] plan that hallucinated a captured image.
// Capture verbs + screenshot/screen-recording noun = a local OS action
// (screen.capture skill), never a display payload.
const SCREEN_CAPTURE_RE = /\b(?:take|capture|snap|grab|shoot|record)\s+(?:a\s+|an\s+|the\s+|my\s+)?(?:quick\s+|new\s+|full\s+)?(?:screenshot|screen\s*(?:shot|recording|capture|grab)|picture\s+of\s+(?:my\s+|the\s+)screen|photo\s+of\s+(?:my\s+|the\s+)screen)\b/i;

const DEVICE_STATE_RE = /\b(?:battery|disk\s+(?:space|usage)|storage|free\s+space|uptime|wifi|wi-?fi|bluetooth|volume|brightness|cpu|gpu|memory\s+(?:usage|pressure|ram)|ram\s+usage|charging|charger|temperature|fan(?:s)?\s+speed|network\s+(?:status|interfaces?)|ip\s+address|hostname|os\s+version|macos\s+version|kernel)\b|\bhow\s+much\s+(?:ram|memory|storage|disk|battery)\b|\b(?:ram|memory|disk|storage|battery)\s+(?:do\s+i\s+have|left|available|free|remaining|full)\b|\bhow\s+long\s+has\s+(?:my|the|this)\s+(?:computer|mac|pc|laptop|machine|system|phone)\s+been\s+(?:running|on|up)\b|\b(?:processes?|apps?|programs?)\s+(?:using|consuming|hogging|eating)\s+(?:the\s+)?(?:most\s+)?(?:memory|cpu|ram|resources?)\b|\btop\s+\d*\s*(?:processes?|apps?|programs?)\s+(?:by|using|consuming|sorted)\b|\b(?:running|open|active)\s+(?:apps?|applications|programs?|processes?)\b|\b(?:apps?|applications|programs?|processes?)\s+(?:\w+\s+){0,3}(?:running|open)\b/i;

function inferScreenOutput(message) {
  const msg = String(message || '');
  const out = { kind: null, content: null };
  if (!msg) return out;

  const q = msg.match(SCREEN_QUOTED_RE);
  if (q) {
    out.kind = 'text';
    out.content = (q[1] || q[2] || '').trim() || null;
    return out;
  }

  if (SCREEN_EFFECT_RE.test(msg)) out.kind = 'effect';
  else if (SCREEN_EMOJI_RE.test(msg)) out.kind = 'emoji';
  else if (SCREEN_IMG_URL_RE.test(msg) || SCREEN_IMG_PATH_RE.test(msg)
           || (/\b(?:image|picture|photo|img)\b/i.test(msg) && /https?:\/\/|~\//.test(msg))) out.kind = 'image';
  else if (SCREEN_ALERT_RE.test(msg)) out.kind = 'alert';
  else if (SCREEN_DECK_RE.test(msg)) out.kind = 'deck';
  else if (SCREEN_CHART_RE.test(msg)) out.kind = 'chart';
  else if (SCREEN_THREE_RE.test(msg)) out.kind = 'three';

  // Alert copy: "...that says X" → X is the alert text. The screenOutput
  // node fills payload.text from screenOutputContent; when the classifier
  // leaves it empty the node would paint stale conversation text instead.
  if (out.kind === 'alert') {
    const s = msg.match(/(?:says?|saying|that\s+says?)\s+(.{1,200})$/i);
    if (s) out.content = s[1].trim();
  }

  // Unquoted text content exists ONLY when an explicit literal-payload lead
  // marks it — "the word DONE", "text saying hello". Bare "show me the
  // weather"/"show me john 3:16" name a fetchable referent, not literal
  // content, and must stay null so the guard keeps its fetch step.
  if ((!out.kind || out.kind === 'text') && SCREEN_DISPLAY_VERB_RE.test(msg)) {
    const t = msg.match(SCREEN_DISPLAY_TAIL_RE);
    if (t) {
      const body = t[1]
        .replace(new RegExp('^\\s*' + SCREEN_DISPLAY_VERB_RE.source, 'i'), '')
        .replace(/^\s*(?:me|us)\s+/i, '')
        .trim();
      if (SCREEN_CONTENT_LEAD_RE.test(body)) {
        let content = body;
        while (SCREEN_CONTENT_LEAD_RE.test(content)) {
          content = content.replace(SCREEN_CONTENT_LEAD_RE, '').trim();
        }
        if (content && content.length <= 200) out.content = content;
      }
    }
  }
  return out;
}

module.exports = {
  CONVERSATION_RECALL_RE,
  CONVERSATION_RECALL_META_RE,
  CONV_RECALL_QUERY_RE,
  LEGACY_RECALL_RE,
  BARE_AFFIRM_RE,
  BARE_DECLINE_RE,
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
  SCREEN_OBSERVATION_RE,
  DEICTIC_CONTINUATION_RE,
  AMBIENT_ARTIFACT_RE,
  SCREEN_OUTPUT_RE,
  LOOKUP_THEN_DISPLAY_RE,
  SCREEN_VISUAL_KIND_RE,
  VISUAL_INTO_APP_RE,
  SCREEN_THREE_RE,
  LOCAL_DATA_SUBJECT_RE,
  DEVICE_STATE_RE,
  FILE_PATH_RE,
  SCREEN_CAPTURE_RE,
  inferScreenOutput,
};
