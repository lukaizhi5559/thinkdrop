export function cleanOcrText(raw: any) {
  return raw
    .replace(/\s+/g, ' ') // Turn multiple spaces/newlines into one space
    .replace(/[^\x20-\x7E]/g, '') // Remove non-printable ASCII, optional
    .trim();
}

export function extractFileNames(text: string): string[] {
  // matches file.js or file.tsx, optionally with paths
  const regex = /(?:[a-zA-Z0-9/_-]+\.){1}(?:js|jsx|ts|tsx|json|md|png)/g;
  // returns list, deduplicated
  return [...new Set(text.match(regex) || [])];
}

export function extractCodeSnippets(text: string): string[] {
  // Basic: lines starting with 'export', 'import', 'function', or 'const'
  const lines = text.split('\n');
  return lines.filter(line =>
    /^(export|import|function|const|let|var)\b/.test(line.trim())
  );
}

export function additionalCleanup(text: string): string {
  // Remove square-bracketed tags
  text = text.replace(/\[[^\]]+\]/g, '');

  // Remove timestamps (e.g., "2026-02-09 at 2.47.44 PM")
  text = text.replace(/\d{4}-\d{2}-\d{2} at \d{1,2}\.\d{2}\.\d{2} [AP]M/g, '');

  // Remove session/id hashes
  text = text.replace(/[A-Z0-9]{8,}/g, '');

  // Remove emoji and miscellaneous symbols
  text = text.replace(/[\u2190-\u21FF\u2300-\u27BF\u2600-\u26FF\u2700-\u27BF\u2B50-\u2BFF\ud83c-\ud83e][\ufe0f]*/g, '');

  // Remove excessive whitespace and blank lines
  text = text.replace(/\s+/g, ' ').replace(/(\r?\n){2,}/g, '\n');

  return text.trim();
}
export function processOcrOutput(rawOcrText: string) {
  // Step 1: Normalize and sanitize
  const cleaned = cleanOcrText(rawOcrText);

  // Step 2: Extract files and code
  const files = extractFileNames(cleaned);
  const code = extractCodeSnippets(cleaned);

  // Step 3: Remove duplicates and validate files
  const validFiles = step3_dedupeAndValidate(files);

  // Step 4: Redact files and code snippets from cleaned text
  let redactedText = cleaned;
  // Remove file names
  validFiles.forEach(file => {
    // Use regex to replace all occurrences, escape regex special characters
    const escaped = file.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    redactedText = redactedText.replace(new RegExp(escaped, 'g'), '');
  });
  // Remove code snippets
  code.forEach(snippet => {
    // Remove only if non-empty snippet
    const snippetTrimmed = snippet.trim();
    if (snippetTrimmed) {
      const escaped = snippetTrimmed.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
      redactedText = redactedText.replace(new RegExp(escaped, 'g'), '');
    }
  });

  const additionalCleaned = additionalCleanup(redactedText);

  return {
    files: validFiles,
    codeSnippets: code,
    cleanedText: cleaned,
    redactedText: redactedText,
    additionalCleanedText: additionalCleaned,
  };
}
// Helper function: Basic filename validation (no forbidden chars, not too long, not empty)
function isValidFileName(name: string): boolean {
  // Adjust forbidden characters as needed for your use case
  const forbiddenPattern = /[<>:"/\\|?*\x00-\x1F]/; // includes control chars
  // Required: must have at least a dot, only reasonable length, not just whitespace
  return (
    typeof name === 'string' &&
    !forbiddenPattern.test(name) &&
    name.trim().length > 0 &&
    name.length < 256 &&
    /\.[a-zA-Z0-9]+$/.test(name)
  );
}

export function step3_dedupeAndValidate(files: string[]): string[]   {
  // Remove duplicates (case-insensitive)
  const uniqueFiles = Array.from(
    new Set(files.map(f => f.toLowerCase()))
  ).map(lower =>
    // Get original-case version from first match
    files.find(f => f.toLowerCase() === lower)
  );

  // Validate file names
  const validFiles = uniqueFiles.filter((f: string | undefined): f is string => f !== undefined && isValidFileName(f));
  
  return validFiles;
}