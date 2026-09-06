// Deterministic AI-slop detector.
//
// Telling a model "don't write like an AI" does not work — it agrees, then
// writes "In today's fast-paced landscape, it's worth noting that this robust
// solution seamlessly delves into..." anyway. What works is measuring the
// output and handing the specific hits back as fixable issues.
//
// So this module is plain string matching, no LLM: banned vocabulary, banned
// phrases, the structural tells (binary contrasts, negative listings,
// rule-of-three, dramatic fragments), rhythm metrics, and false agency. The
// SEO reviewer runs it before it prompts anything and folds the hits into its
// verdict; the editor gets the same list with line numbers.
//
// Rule sources: the `stop-slop` skill (Hardik Pandya) and the superseo
// `write-content` anti-slop ruleset, narrowed to what a regex can judge
// honestly. Anything needing taste (is this specific enough? does it take a
// position?) stays with the reviewing model.

export type SlopCategory =
  | 'banned-word'
  | 'banned-phrase'
  | 'structure'
  | 'rhythm'
  | 'hedge'
  | 'false-agency';

export interface SlopFinding {
  category: SlopCategory;
  /** Human-readable rule name, e.g. "AI vocabulary: delve". */
  rule: string;
  /** Verbatim hits, capped so a prompt can't be flooded by one rule. */
  matches: string[];
  count: number;
  /** 1-based body line numbers, capped alongside `matches`. */
  lines: number[];
  /** Concrete instruction for the editor. */
  fix: string;
}

export interface SlopReport {
  /** 0-100, 100 = clean. Below 70 is a high-severity failure. */
  score: number;
  findings: SlopFinding[];
  /** Prose word count the density rules were measured against. */
  words: number;
}

/** Below this the draft goes back for a revision round. */
export const SLOP_PASS_SCORE = 70;

const EXAMPLES_PER_RULE = 5;

// ---------------------------------------------------------------------------
// Rule tables
// ---------------------------------------------------------------------------

/**
 * Tier-1 AI vocabulary — words whose presence is close to conclusive. Kept to
 * words with a plain-English replacement, so a fix is always available. Words
 * a product spec genuinely needs ("comprehensive warranty") are deliberately
 * absent; the cost of a false positive is a pointless edit round.
 */
const BANNED_WORDS: Array<{ word: string; instead: string }> = [
  { word: 'delve', instead: 'look at, dig into' },
  { word: 'delves', instead: 'looks at' },
  { word: 'delving', instead: 'looking at' },
  { word: 'leverage', instead: 'use' },
  { word: 'leverages', instead: 'uses' },
  { word: 'leveraging', instead: 'using' },
  { word: 'utilize', instead: 'use' },
  { word: 'utilizes', instead: 'uses' },
  { word: 'utilise', instead: 'use' },
  { word: 'utilising', instead: 'using' },
  { word: 'robust', instead: 'sturdy, reliable — or name the spec' },
  { word: 'seamless', instead: 'name what does not break' },
  { word: 'seamlessly', instead: 'name what does not break' },
  { word: 'furthermore', instead: 'start the sentence' },
  { word: 'moreover', instead: 'start the sentence' },
  { word: 'additionally', instead: 'also, or start the sentence' },
  { word: 'pivotal', instead: 'important — or say what it changes' },
  { word: 'multifaceted', instead: 'name the facets' },
  { word: 'harness', instead: 'use' },
  { word: 'harnessing', instead: 'using' },
  { word: 'embark', instead: 'start' },
  { word: 'showcase', instead: 'show' },
  { word: 'showcases', instead: 'shows' },
  { word: 'showcasing', instead: 'showing' },
  { word: 'streamline', instead: 'simplify, speed up' },
  { word: 'streamlined', instead: 'simpler, faster' },
  { word: 'paramount', instead: 'the thing that matters most' },
  { word: 'culminate', instead: 'end in' },
  { word: 'culminates', instead: 'ends in' },
  { word: 'spearhead', instead: 'lead' },
  { word: 'commence', instead: 'start' },
  { word: 'endeavor', instead: 'try, effort' },
  { word: 'endeavour', instead: 'try, effort' },
  { word: 'testament', instead: 'name the evidence' },
  { word: 'vibrant', instead: 'name the colour or the sound' },
  { word: 'myriad', instead: 'many, or the number' },
  { word: 'plethora', instead: 'many, or the number' },
  { word: 'bustling', instead: 'busy' },
  { word: 'elevate', instead: 'improve, raise' },
  { word: 'elevates', instead: 'improves' },
  { word: 'unlock', instead: 'get, enable' },
  { word: 'unlocks', instead: 'gets, enables' },
  { word: 'game-changer', instead: 'say what changed' },
  { word: 'gamechanger', instead: 'say what changed' },
  { word: 'cutting-edge', instead: 'name the year or the spec' },
  { word: 'state-of-the-art', instead: 'name the year or the spec' },
];

/**
 * Metaphorical uses only — the literal senses are fine, so each carries a
 * guard that skips the reading a product page legitimately needs.
 */
const CONTEXTUAL_WORDS: Array<{ rule: string; re: RegExp; fix: string }> = [
  {
    rule: 'AI vocabulary: "landscape" (metaphorical)',
    // "the audio landscape" is slop; "landscape mode", "landscape photography"
    // and "landscape lighting" are products.
    re: /\blandscapes?\b(?!\s+(?:mode|orientation|photograph|photography|lighting|design|garden|edging|fabric|shot|format))/gi,
    fix: 'Replace with the specific thing: "the audio landscape" → "wireless headphones under $300".',
  },
  {
    rule: 'AI vocabulary: "navigate" (metaphorical)',
    // Keep literal navigation: GPS, menus, maps.
    re: /\bnavigat(?:e|es|ing|ion)\b(?=\s+(?:the\s+)?(?:complexit|challeng|landscape|world|maze|nuance|trade-?off|market|decision|process|choice))/gi,
    fix: 'Say "handle", "work through", or name the actual step.',
  },
  {
    rule: 'AI vocabulary: "comprehensive" (as a filler adjective)',
    re: /\bcomprehensive\b(?!\s+(?:warranty|insurance|cover(?:age)?|test(?:ing)?|service))/gi,
    fix: 'Delete it, or say what the piece actually covers.',
  },
];

const BANNED_PHRASES: Array<{ rule: string; re: RegExp; fix: string }> = [
  {
    rule: 'Throat-clearing: "here\'s the thing / here\'s what"',
    re: /\bhere(?:'|’)?s\s+(?:the\s+thing|what|why|how|where|the\s+(?:problem|catch|deal|kicker|truth))\b/gi,
    fix: 'Delete the opener and state the point in the same sentence.',
  },
  {
    rule: 'Filler: "it\'s worth noting"',
    re: /\bit(?:'|’)?s\s+worth\s+(?:noting|mentioning|pointing\s+out)\b/gi,
    fix: 'Delete the phrase. If the fact is worth stating, state it.',
  },
  {
    rule: 'Filler: "in today\'s [anything]"',
    re: /\bin\s+today(?:'|’)?s\s+\w+/gi,
    fix: 'Delete. Anchor to a date instead if recency matters.',
  },
  {
    rule: 'Filler: "let\'s dive in / deep dive"',
    re: /\b(?:let(?:'|’)?s\s+dive\s+(?:in|into)|deep\s+dive|dive\s+into\s+the)\b/gi,
    fix: 'Cut it and start with the first real point.',
  },
  {
    rule: 'Filler: "in conclusion / to sum up"',
    re: /\b(?:in\s+conclusion|to\s+sum\s+up|to\s+wrap\s+(?:things\s+)?up|in\s+summary)\b/gi,
    fix: 'Delete the label. The last section is visibly the last section.',
  },
  {
    rule: 'Filler: "plays a crucial/vital/pivotal role"',
    re: /\bplays?\s+an?\s+(?:crucial|vital|pivotal|key|important|significant)\s+role\b/gi,
    fix: 'Say what it does: "the 40mm driver is what makes the bass hold up".',
  },
  {
    rule: 'Filler: "it goes without saying"',
    re: /\bit\s+goes\s+without\s+saying\b/gi,
    fix: 'Delete. If it goes without saying, do not say it.',
  },
  {
    rule: 'Filler: "in the realm of / in the world of"',
    re: /\bin\s+the\s+(?:realm|world|age|era)\s+of\b/gi,
    fix: 'Name the category directly.',
  },
  {
    rule: 'Filler: "when it comes to"',
    re: /\bwhen\s+it\s+comes\s+to\b/gi,
    fix: 'Restructure: "For battery life, the Sony wins" beats "When it comes to battery life...".',
  },
  {
    rule: 'Filler: "at the end of the day / at its core"',
    re: /\b(?:at\s+the\s+end\s+of\s+the\s+day|at\s+its\s+core|the\s+reality\s+is)\b/gi,
    fix: 'Delete and state the claim.',
  },
  {
    rule: 'Emphasis crutch: "let that sink in / make no mistake / full stop"',
    re: /\b(?:let\s+that\s+sink\s+in|make\s+no\s+mistake|full\s+stop\.|period\.)(?=\s|$)/gi,
    fix: 'Delete. The sentence before it has to carry the weight on its own.',
  },
  {
    rule: 'Emphasis crutch: "this matters because / here\'s why that matters"',
    re: /\b(?:this\s+matters\s+because|here(?:'|’)?s\s+why\s+that\s+matters|why\s+this\s+matters:)/gi,
    fix: 'State the consequence directly instead of announcing that one follows.',
  },
  {
    rule: 'Meta-commentary: "in this section / as we\'ll see / let me walk you through"',
    re: /\b(?:in\s+this\s+(?:section|article|guide)\s*,?\s*we(?:'|’)?ll|as\s+we(?:'|’)?ll\s+see|let\s+me\s+walk\s+you\s+through|the\s+rest\s+of\s+this\s+(?:article|guide|post))\b/gi,
    fix: 'Delete. Let the piece move instead of narrating its own structure.',
  },
  {
    rule: 'Business jargon: "unpack / circle back / double down / moving forward"',
    re: /\b(?:unpack(?:s|ing)?\s+(?:the|this|what)|circle\s+back|double\s+down|moving\s+forward\s*,|take\s+a\s+step\s+back|lean\s+into)\b/gi,
    fix: 'Use the plain word: explain, revisit, commit, next.',
  },
  {
    rule: 'Hype: urgency copy',
    re: /\b(?:hurry|act\s+now|don(?:'|’)?t\s+miss\s+out|limited\s+time\s+only|while\s+stocks\s+last|grab\s+yours)\b/gi,
    fix: 'Remove. The editorial rules forbid urgency copy outright.',
  },
];

const STRUCTURE_RULES: Array<{ rule: string; re: RegExp; fix: string }> = [
  {
    rule: 'Binary contrast: "it\'s not X, it\'s Y"',
    re: /\b(?:it(?:'|’)?s|this\s+is|that(?:'|’)?s|they(?:'|’)?re)\s+not\s+(?:just\s+)?[^.!?\n]{2,60}?,?\s+it(?:'|’)?s\s+/gi,
    fix: 'Drop the negation and assert Y directly.',
  },
  {
    rule: 'Binary contrast: "the X isn\'t Y. It\'s Z."',
    re: /\bthe\s+\w+\s+(?:isn(?:'|’)?t|is\s+not)\s+[^.!?\n]{2,60}[.!?]\s+It(?:'|’)?s\s+/g,
    fix: 'State the real claim in one sentence. No setup-and-reveal.',
  },
  {
    rule: 'Additive hedge: "not just X but (also) Y"',
    re: /\bnot\s+(?:just|only)\s+[^.!?\n]{2,60}?\bbut\s+(?:also\s+)?/gi,
    fix: 'Pick the claim that matters and make it.',
  },
  {
    rule: 'Rhetorical setup: "the question isn\'t / the answer isn\'t / what if"',
    re: /\b(?:the\s+(?:question|answer|problem|issue)\s+(?:isn(?:'|’)?t|is\s+not)|what\s+if\s+(?:you|we|the)|think\s+about\s+it[:.])/gi,
    fix: 'Ask nothing. Give the answer.',
  },
  {
    rule: 'Dramatic fragment: "That\'s it. / That\'s the X."',
    re: /(?:^|[.!?]\s)(?:That(?:'|’)?s\s+it\.|That(?:'|’)?s\s+the\s+\w+\.|Simple\.|Full\s+stop\.)/gm,
    fix: 'Write the complete sentence. Manufactured punch reads as filler.',
  },
  {
    rule: 'Copula avoidance: "serves as / acts as / stands as"',
    re: /\b(?:serves?|acts?|stands?)\s+as\s+(?:a|an|the)\b/gi,
    fix: 'Just say "is".',
  },
  {
    rule: 'Participial tack-on: "..., highlighting/underscoring/showcasing the ..."',
    re: /,\s+(?:highlighting|underscoring|emphasi[sz]ing|showcasing|demonstrating|reflecting|making\s+it)\s+(?:the\s+)?\w+/gi,
    fix: 'Delete the clause or promote it to its own sentence with a subject.',
  },
  {
    rule: 'Negative listing: "It wasn\'t X. It wasn\'t Y."',
    re: /\b(?:It|This|That)\s+(?:wasn(?:'|’)?t|isn(?:'|’)?t)\s+[^.!?\n]{2,50}[.!?]\s+(?:It|This|That)\s+(?:wasn(?:'|’)?t|isn(?:'|’)?t)\s+/g,
    fix: 'Delete the runway and state what it is.',
  },
];

const FALSE_AGENCY: Array<{ rule: string; re: RegExp; fix: string }> = [
  {
    rule: 'False agency: an inanimate subject doing a human verb',
    re: /\b(?:the\s+(?:data|market|decision|culture|conversation|technology|design|price|feature)|prices|the\s+specs?)\s+(?:tells?\s+us|rewards?|decides?|emerges?|shifts?\s+toward|demands?|wants?|knows?|believes?)\b/gi,
    fix: 'Name the person: "buyers pay more for" beats "the market rewards".',
  },
  {
    rule: 'Narrator-from-a-distance: "people tend to / nobody / everyone"',
    re: /\b(?:people\s+(?:tend\s+to|often)|nobody\s+(?:really\s+)?(?:wants|knows|designed)|everyone\s+(?:knows|agrees))\b/gi,
    fix: 'Put the reader in it: "You will notice..." beats "People tend to notice...".',
  },
];

/**
 * Hedge adverbs — allowed at low density, flagged when they pile up. A blanket
 * ban on -ly words would swamp every other finding on a 1,800-word guide, so
 * this is the named-offender list from the stop-slop reference only.
 */
const HEDGE_WORDS = [
  'really',
  'literally',
  'genuinely',
  'honestly',
  'simply',
  'actually',
  'truly',
  'fundamentally',
  'inherently',
  'inevitably',
  'interestingly',
  'importantly',
  'crucially',
  'notably',
  'essentially',
  'arguably',
  'undoubtedly',
  'certainly',
  'basically',
];
/** Hedges tolerated per 1,000 words before it counts as a pattern. */
const HEDGE_ALLOWANCE_PER_1K = 2;
/** Em-dashes tolerated per 1,000 words (superseo: "max 1-2 per 1000 words"). */
const EM_DASH_ALLOWANCE_PER_1K = 2;

// ---------------------------------------------------------------------------
// Markdown → prose
// ---------------------------------------------------------------------------

/**
 * Blank out everything that is not prose, preserving line count so findings
 * keep real line numbers: fenced code, inline code, link targets, bare URLs,
 * table delimiter rows, and HTML comments.
 */
export function proseLines(markdown: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const raw of markdown.split('\n')) {
    if (/^\s*(?:```|~~~)/.test(raw)) {
      inFence = !inFence;
      out.push('');
      continue;
    }
    if (inFence || /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(raw)) {
      out.push('');
      continue;
    }
    out.push(
      raw
        .replace(/`[^`]*`/g, ' ')
        // Keep the anchor text of a markdown link, drop its target.
        .replace(/\]\([^)]*\)/g, '] ')
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' '),
    );
  }
  return out;
}

function countWords(lines: string[]): number {
  return lines
    .join(' ')
    .replace(/[#>*_[\]]/g, ' ')
    .split(/\s+/)
    .filter((w) => /[a-z0-9]/i.test(w)).length;
}

/** Scan every prose line for `re`, collecting hits with their line numbers. */
function scan(
  lines: string[],
  re: RegExp,
): { matches: string[]; lines: number[]; count: number } {
  const matches: string[] = [];
  const lineNumbers: number[] = [];
  let count = 0;
  for (const [i, line] of lines.entries()) {
    // Each line gets a fresh lastIndex; the tables share these regexes.
    re.lastIndex = 0;
    for (const m of line.matchAll(re)) {
      count += 1;
      if (matches.length < EXAMPLES_PER_RULE) {
        matches.push(m[0].trim().replace(/\s+/g, ' ').slice(0, 80));
        lineNumbers.push(i + 1);
      }
    }
  }
  return { matches, lines: lineNumbers, count };
}

/** Sentences from the prose, ignoring headings, list bullets and tables. */
function sentences(lines: string[]): string[] {
  const body = lines
    .filter((l) => !/^\s*(?:#{1,6}\s|\||\s*$)/.test(l))
    .join(' ')
    .replace(/\s+/g, ' ');
  return body
    .split(/(?<=[.!?])\s+(?=[A-Z"'“‘])/)
    .map((s) => s.trim())
    .filter((s) => s.split(/\s+/).length >= 3);
}

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

/**
 * Penalty weight per hit, and the cap on how much one rule can cost. Tier-1
 * vocabulary is weighted hardest because it is the least ambiguous signal —
 * nobody writes "seamlessly delves" by accident.
 */
const WEIGHTS: Record<SlopCategory, { each: number; cap: number }> = {
  'banned-word': { each: 12, cap: 24 },
  'banned-phrase': { each: 8, cap: 20 },
  structure: { each: 5, cap: 15 },
  'false-agency': { each: 4, cap: 8 },
  rhythm: { each: 4, cap: 12 },
  hedge: { each: 3, cap: 9 },
};

/**
 * Severity the SEO reviewer files a finding under. Banned vocabulary and
 * phrases are always high: one "delve" in an otherwise strong draft still
 * ships an obvious AI tell, and the score alone would let it through. High
 * severity is what forces the revision round, independent of the number.
 */
export function slopSeverity(finding: SlopFinding): 'high' | 'medium' | 'low' {
  if (finding.category === 'banned-word' || finding.category === 'banned-phrase') return 'high';
  if (finding.category === 'structure' || finding.category === 'false-agency') return 'medium';
  return 'low';
}

export function detectSlop(markdown: string): SlopReport {
  const lines = proseLines(markdown ?? '');
  const words = countWords(lines);
  const findings: SlopFinding[] = [];

  const add = (
    category: SlopCategory,
    rule: string,
    fix: string,
    hit: { matches: string[]; lines: number[]; count: number },
  ): void => {
    if (hit.count === 0) return;
    findings.push({ category, rule, fix, ...hit });
  };

  for (const { word, instead } of BANNED_WORDS) {
    const re = new RegExp(`\\b${word.replace(/[-]/g, '[- ]?')}\\b`, 'gi');
    add('banned-word', `AI vocabulary: "${word}"`, `Replace with: ${instead}.`, scan(lines, re));
  }
  for (const { rule, re, fix } of CONTEXTUAL_WORDS) add('banned-word', rule, fix, scan(lines, re));
  for (const { rule, re, fix } of BANNED_PHRASES) add('banned-phrase', rule, fix, scan(lines, re));
  for (const { rule, re, fix } of STRUCTURE_RULES) add('structure', rule, fix, scan(lines, re));
  for (const { rule, re, fix } of FALSE_AGENCY) add('false-agency', rule, fix, scan(lines, re));

  // Density rules scale with length: a 300-word news piece and a 2,000-word
  // guide can't share an absolute budget.
  const per1k = Math.max(1, words / 1000);

  const hedgeRe = new RegExp(`\\b(?:${HEDGE_WORDS.join('|')})\\b`, 'gi');
  const hedges = scan(lines, hedgeRe);
  const hedgeBudget = Math.ceil(HEDGE_ALLOWANCE_PER_1K * per1k);
  if (hedges.count > hedgeBudget) {
    findings.push({
      category: 'hedge',
      rule: 'Hedge adverbs',
      matches: hedges.matches,
      lines: hedges.lines,
      count: hedges.count - hedgeBudget,
      fix: `${hedges.count} hedge adverbs in ${words} words (budget ${hedgeBudget}). Delete them — "really", "actually", "simply" and friends add nothing.`,
    });
  }

  const emDashes = scan(lines, /—/g);
  const emDashBudget = Math.ceil(EM_DASH_ALLOWANCE_PER_1K * per1k);
  if (emDashes.count > emDashBudget) {
    findings.push({
      category: 'rhythm',
      rule: 'Em-dash density',
      matches: emDashes.matches,
      lines: emDashes.lines,
      count: emDashes.count - emDashBudget,
      fix: `${emDashes.count} em-dashes in ${words} words (budget ${emDashBudget}). Convert the excess to commas, colons or full stops.`,
    });
  }

  // Metronomic rhythm: runs of similar-length sentences. Human prose varies.
  const lengths = sentences(lines).map((s) => s.split(/\s+/).length);
  let run = 1;
  let flatRuns = 0;
  for (let i = 1; i < lengths.length; i++) {
    if (Math.abs(lengths[i] - lengths[i - 1]) <= 3) {
      run += 1;
      if (run === 4) flatRuns += 1;
    } else {
      run = 1;
    }
  }
  if (flatRuns > 0) {
    findings.push({
      category: 'rhythm',
      rule: 'Metronomic sentence rhythm',
      matches: [],
      lines: [],
      count: flatRuns,
      fix: `${flatRuns} run(s) of 4+ consecutive sentences within 3 words of each other. Break them up — mix a 5-word sentence into the 25-word ones.`,
    });
  }

  let penalty = 0;
  for (const finding of findings) {
    const { each, cap } = WEIGHTS[finding.category];
    penalty += Math.min(finding.count * each, cap);
  }
  const score = Math.max(0, Math.min(100, Math.round(100 - penalty)));

  findings.sort((a, b) => b.count * WEIGHTS[b.category].each - a.count * WEIGHTS[a.category].each);
  return { score, findings, words };
}

/** Render a report for an LLM prompt. Empty string when the draft is clean. */
export function formatSlopReport(report: SlopReport): string {
  if (report.findings.length === 0) return '';
  const lines = report.findings.map((f) => {
    const where = f.lines.length > 0 ? ` (line${f.lines.length > 1 ? 's' : ''} ${f.lines.join(', ')})` : '';
    const examples = f.matches.length > 0 ? `\n  Found: ${f.matches.map((m) => `"${m}"`).join(', ')}${where}` : '';
    return `- [${f.category}] ${f.rule} ×${f.count}${examples}\n  Fix: ${f.fix}`;
  });
  return `Anti-slop scan: ${report.score}/100 over ${report.words} words (pass mark ${SLOP_PASS_SCORE}).
${lines.join('\n')}`;
}
