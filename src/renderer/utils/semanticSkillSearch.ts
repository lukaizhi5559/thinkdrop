/**
 * semanticSkillSearch — fast TF-IDF word-overlap search against skill-library.json
 *
 * No embeddings needed. Tokenizes the query and each skill's name + description,
 * computes Jaccard-style overlap weighted by IDF-like inverse term frequency,
 * returns top-N skills sorted by descending score.
 */

import skillLibraryData from '../data/skill-library.json';

interface SkillEntry {
  name: string;
  displayName: string;
  description: string;
  category: string;
  ocUrl: string;
  rawUrl: string;
}

interface SkillLibrary {
  skills: SkillEntry[];
}

const library = skillLibraryData as SkillLibrary;

const STOPWORDS = new Set([
  'a','an','the','and','or','but','in','on','at','to','for','of','with','by',
  'from','up','about','into','through','during','is','are','was','were','be',
  'been','being','have','has','had','do','does','did','will','would','could',
  'should','may','might','shall','can','need','dare','ought','used','i','me',
  'my','we','you','your','it','its','this','that','these','those','via','per',
  'new','make','get','use','using','based','your','our','all','any','each',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOPWORDS.has(t));
}

// Pre-build token sets for every skill (computed once on first call)
let _skillTokens: Array<{ skill: SkillEntry; tokens: Set<string>; tokenList: string[] }> | null = null;

function getSkillTokens() {
  if (_skillTokens) return _skillTokens;
  _skillTokens = library.skills.map(skill => {
    const tokenList = tokenize(`${skill.name} ${skill.displayName} ${skill.description} ${skill.category}`);
    return { skill, tokens: new Set(tokenList), tokenList };
  });
  return _skillTokens;
}

export interface SkillMatch {
  skill: SkillEntry;
  score: number;
}

export function semanticSkillSearch(query: string, topN = 3): SkillMatch[] {
  if (!query || !query.trim()) return [];

  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const querySet = new Set(queryTokens);
  const skillTokens = getSkillTokens();

  const scored = skillTokens.map(({ skill, tokens }) => {
    // Intersection size
    let intersection = 0;
    for (const t of querySet) {
      if (tokens.has(t)) intersection++;
    }
    if (intersection === 0) return { skill, score: 0 };

    // Jaccard similarity: |A ∩ B| / |A ∪ B|
    const union = querySet.size + tokens.size - intersection;
    const jaccard = intersection / union;

    // Boost: skill name directly contains a query token → heavy weight
    const nameTokens = tokenize(skill.name + ' ' + skill.displayName);
    let nameBoost = 0;
    for (const t of queryTokens) {
      if (nameTokens.includes(t)) nameBoost += 0.15;
    }

    return { skill, score: jaccard + nameBoost };
  });

  return scored
    .filter(m => m.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
}
