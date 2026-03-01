#!/usr/bin/env node
/**
 * build-skill-library.js
 *
 * Parses all oc-mimic-skills/categories/*.md files and outputs a single
 * skill-library.json to src/renderer/data/skill-library.json
 *
 * Each entry: { name, description, category, ocUrl }
 *
 * Usage: node scripts/build-skill-library.js
 */

const fs = require('fs');
const path = require('path');

const CATEGORIES_DIR = path.join(__dirname, '..', 'oc-mimic-skills', 'categories');
const OUTPUT_FILE = path.join(__dirname, '..', 'src', 'renderer', 'data', 'skill-library.json');

// Map filename → human-readable category label
const CATEGORY_LABELS = {
  'ai-and-llms.md':               'AI & LLMs',
  'apple-apps-and-services.md':   'Apple Apps & Services',
  'browser-and-automation.md':    'Browser & Automation',
  'calendar-and-scheduling.md':   'Calendar & Scheduling',
  'clawdbot-tools.md':            'Clawdbot Tools',
  'cli-utilities.md':             'CLI Utilities',
  'coding-agents-and-ides.md':    'Coding Agents & IDEs',
  'communication.md':             'Communication',
  'data-and-analytics.md':        'Data & Analytics',
  'devops-and-cloud.md':          'DevOps & Cloud',
  'gaming.md':                    'Gaming',
  'git-and-github.md':            'Git & GitHub',
  'health-and-fitness.md':        'Health & Fitness',
  'image-and-video-generation.md':'Image & Video Generation',
  'ios-and-macos-development.md': 'iOS & macOS Development',
  'marketing-and-sales.md':       'Marketing & Sales',
  'media-and-streaming.md':       'Media & Streaming',
  'moltbook.md':                  'Moltbook',
  'notes-and-pkm.md':             'Notes & PKM',
  'pdf-and-documents.md':         'PDF & Documents',
  'personal-development.md':      'Personal Development',
  'productivity-and-tasks.md':    'Productivity & Tasks',
  'search-and-research.md':       'Search & Research',
  'security-and-passwords.md':    'Security & Passwords',
  'self-hosted-and-automation.md':'Self-Hosted & Automation',
  'shopping-and-e-commerce.md':   'Shopping & E-Commerce',
  'smart-home-and-iot.md':        'Smart Home & IoT',
  'speech-and-transcription.md':  'Speech & Transcription',
  'transportation.md':            'Transportation',
  'web-and-frontend-development.md': 'Web & Frontend Development',
};

/**
 * Parse a single category .md file.
 * Lines look like:
 *   - [skill-name](https://github.com/openclaw/skills/tree/main/skills/user/skill-name/SKILL.md) - Description text.
 */
function parseCategoryFile(filePath, categoryLabel) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const skills = [];

  // Match markdown list entries: - [name](url) - description
  const lineRegex = /^-\s+\[([^\]]+)\]\((https?:\/\/[^)]+)\)\s+-\s+(.+)$/;

  for (const line of content.split('\n')) {
    const match = line.trim().match(lineRegex);
    if (!match) continue;

    const [, name, ocUrl, description] = match;

    // Normalise the GitHub tree URL → raw SKILL.md URL for later fetching
    // tree URL:  https://github.com/openclaw/skills/tree/main/skills/user/slug/SKILL.md
    // raw URL:   https://raw.githubusercontent.com/openclaw/skills/main/skills/user/slug/SKILL.md
    const rawUrl = ocUrl
      .replace('https://github.com/', 'https://raw.githubusercontent.com/')
      .replace('/tree/', '/');

    skills.push({
      name: name.toLowerCase().trim(),
      displayName: name.trim(),
      description: description.trim(),
      category: categoryLabel,
      ocUrl: ocUrl.trim(),
      rawUrl: rawUrl.trim(),
    });
  }

  return skills;
}

function main() {
  if (!fs.existsSync(CATEGORIES_DIR)) {
    console.error(`Categories dir not found: ${CATEGORIES_DIR}`);
    process.exit(1);
  }

  const outputDir = path.dirname(OUTPUT_FILE);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const files = fs.readdirSync(CATEGORIES_DIR).filter(f => f.endsWith('.md'));
  const allSkills = [];
  const stats = {};

  for (const file of files.sort()) {
    const label = CATEGORY_LABELS[file] || file.replace('.md', '').replace(/-/g, ' ');
    const filePath = path.join(CATEGORIES_DIR, file);
    const skills = parseCategoryFile(filePath, label);
    allSkills.push(...skills);
    stats[label] = skills.length;
    console.log(`  ${label}: ${skills.length} skills`);
  }

  // Deduplicate by name (keep first occurrence)
  const seen = new Set();
  const deduped = allSkills.filter(s => {
    if (seen.has(s.name)) return false;
    seen.add(s.name);
    return true;
  });

  const output = {
    generatedAt: new Date().toISOString(),
    totalSkills: deduped.length,
    categories: Object.keys(stats).sort(),
    skills: deduped,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf-8');

  console.log(`\n✅ Wrote ${deduped.length} skills (${allSkills.length - deduped.length} dupes removed) → ${OUTPUT_FILE}`);
}

main();
