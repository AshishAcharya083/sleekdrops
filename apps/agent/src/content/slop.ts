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
//
// v2 adds the measurements a blocklist cannot make. A draft can clear every
// banned word and still read as machine-written, because what gives it away is
// shape: sentences all the same length, paragraphs all the same size, every H2
// opening with the same move, and claims carrying no numbers. Worse, a scan of
// one draft in isolation can never see the thing an AdSense reviewer sees
// first - that every article on the site opens the same way. So the scan also
// takes an optional corpus of already-published bodies and measures n-gram and
// opening-line overlap against it.
//
// Everything here stays synchronous, deterministic and offline: the corpus is
// passed in (see content/corpus.ts), never fetched, so the scan can run on
// every review round.

export type SlopCategory =
  | 'banned-word'
  | 'banned-phrase'
  | 'structure'
  | 'rhythm'
  | 'hedge'
  | 'false-agency'
  /** Sameness of shape: sentence, paragraph and section-opening uniformity. */
  | 'uniformity'
  /** Numbers, model names, dates and named sources per 100 words. */
  | 'specificity'
  /** Overlap with previously published articles. */
  | 'repetition';

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

/**
 * A previously published article the draft is measured against. Only `slug`
 * and `body` are used by the scan; the rest travels with the record so a
 * finding can name what the draft is echoing.
 */
export interface CorpusArticle {
  slug: string;
  body: string;
  title?: string;
  publishedAt?: string | null;
}

export interface SlopScanOptions {
  /**
   * Previously published bodies to check overlap against, newest first.
   * Omitted or empty: the cross-corpus metrics are skipped entirely - no
   * findings, no effect on the score.
   */
  corpus?: CorpusArticle[];
}

/** Alias kept so either name in the parallel-work contracts resolves. */
export type ScanOptions = SlopScanOptions;

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

/** A sentence with the body line it starts on, so findings stay anchored. */
interface SentenceSpan {
  text: string;
  /** 1-based body line the sentence starts on. */
  line: number;
  words: number;
}

/** Lines that carry running prose - not headings, table rows or blanks. */
function isProse(line: string): boolean {
  return !/^\s*(?:#{1,6}\s|\||\s*$)/.test(line);
}

/**
 * Sentences from the prose, ignoring headings, list bullets and tables, each
 * carrying the line it starts on. Paragraphs wrap across lines, so the line
 * number comes from an offset map over the joined text rather than from a
 * per-line split.
 */
function sentenceSpans(lines: string[]): SentenceSpan[] {
  const kept: Array<{ text: string; line: number }> = [];
  for (const [i, line] of lines.entries()) {
    if (!isProse(line)) continue;
    kept.push({ text: line.replace(/\s+/g, ' ').trim(), line: i + 1 });
  }
  // One space between lines, so every whitespace run in `body` is one
  // character wide and offsets survive the sentence split.
  const body = kept.map((k) => k.text).join(' ');
  const starts: number[] = [];
  let offset = 0;
  for (const k of kept) {
    starts.push(offset);
    offset += k.text.length + 1;
  }

  const spans: SentenceSpan[] = [];
  let cursor = 0;
  let keptIndex = 0;
  for (const raw of body.split(/(?<=[.!?])\s+(?=[A-Z"'“‘])/)) {
    const start = cursor;
    cursor += raw.length + 1;
    const text = raw.trim();
    const words = text.split(/\s+/).filter(Boolean).length;
    if (words < 3) continue;
    while (keptIndex + 1 < kept.length && starts[keptIndex + 1] <= start) keptIndex += 1;
    spans.push({ text, line: kept[keptIndex]?.line ?? 1, words });
  }
  return spans;
}

// ---------------------------------------------------------------------------
// Structure, specificity and repetition (scanner v2)
// ---------------------------------------------------------------------------

/**
 * Every threshold the v2 metrics gate on, in one block so retuning is a
 * one-line change. Calibrated so a varied, specific article passes and a
 * template does not: the numbers below sit roughly midway between the two
 * fixtures in slop.test.ts, which are modelled on what the pipeline actually
 * ships. Anything measured as a coefficient of variation (standard deviation
 * over the mean) is scale-free, so it holds for a 900-word piece and a
 * 2,000-word one alike.
 */
export const SCAN_THRESHOLDS = {
  /** Sentences needed before length variance says anything. */
  minSentences: 12,
  /** Sentence-length variation below this reads as a metronome. */
  sentenceVariationMin: 0.35,
  /** Paragraphs (of `minParagraphWords`+) needed before uniformity is measurable. */
  minParagraphs: 6,
  minParagraphWords: 20,
  /** Paragraph-length variation below this means every block is the same size. */
  paragraphVariationMin: 0.22,
  /** H2 sections needed before section shape is a pattern rather than a habit. */
  minSections: 4,
  /** Variation in the length of each section's opening block. */
  sectionOpeningVariationMin: 0.18,
  /** Sections that must share an opening frame before it counts, and their share. */
  sectionFrameRepeats: 3,
  sectionFrameShare: 0.6,
  /** Below this word count a density read is noise. */
  minWordsForSpecificity: 300,
  /** Numbers, model names, dates and named sources wanted per 100 words. */
  specificityPer100: 1.5,
  /** A paragraph this long with no specific of any kind gets anchored. */
  bareParagraphWords: 40,

  /** Words per shingle for the cross-corpus n-gram comparison. */
  ngramSize: 5,
  /** Shingles the draft needs before overlap ratios mean anything. */
  minDraftShingles: 40,
  /**
   * Share of the draft's shingles that may reappear in one published article.
   * Two unrelated articles in one category share a few per cent, and the
   * maximum over thirty of them is higher than over five, so the gate sits
   * well clear of that: a real near-duplicate runs past 20%.
   */
  maxArticleOverlap: 0.1,
  /** Share that may reappear anywhere in the corpus. */
  maxCorpusOverlap: 0.25,
  /**
   * A shingle in at least this share of the corpus is site furniture (the
   * disclaimer, the CTA line) rather than repetition, and is excluded - the
   * editorial rules require those, so flagging them would only thrash.
   * Needs `minDocsForBoilerplate` documents before the share means anything.
   */
  boilerplateDocShare: 0.6,
  minDocsForBoilerplate: 5,
  /**
   * How much of a draft may be site furniture before the furniture is the
   * article: whichever is larger of this share and `stockPhrasingFloor`
   * shingles. The floor is what keeps the metric honest on a short piece,
   * where the required disclaimer alone is a tenth of the text.
   */
  stockPhrasingAllowance: 0.1,
  stockPhrasingFloor: 60,
  /** Token overlap between two opening paragraphs before they are one opening. */
  maxOpeningSimilarity: 0.45,
  /** Opening tokens compared. */
  openingTokens: 30,
};

type BlockKind = 'paragraph' | 'heading' | 'list' | 'table';

interface Block {
  kind: BlockKind;
  /** 1-based line the block starts on. */
  line: number;
  text: string;
  words: number;
  /** Heading level, 0 for everything else. */
  level: number;
}

function kindOf(line: string): BlockKind {
  if (/^\s*\|/.test(line)) return 'table';
  if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) return 'list';
  return 'paragraph';
}

/** Prose lines grouped into markdown blocks, each keeping its start line. */
function blocks(lines: string[]): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const text = heading[2].trim();
      out.push({ kind: 'heading', line: i + 1, text, words: countWords([text]), level: heading[1].length });
      i += 1;
      continue;
    }
    const kind = kindOf(line);
    const start = i;
    const parts: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*#{1,6}\s/.test(lines[i]) &&
      kindOf(lines[i]) === kind
    ) {
      parts.push(lines[i].replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim());
      i += 1;
    }
    const text = parts.join(' ');
    out.push({ kind, line: start + 1, text, words: countWords([text]), level: 0 });
  }
  return out;
}

const FAQ_HEADING = /^(?:faq|faqs|frequently\s+asked)/i;

/**
 * Line range of the FAQ section, or null. Its answers are uniform by
 * instruction - the site builds FAQPage schema out of them - so the
 * uniformity metrics step around it rather than punishing a required shape.
 */
function faqRange(list: Block[]): { from: number; to: number } | null {
  const start = list.findIndex((b) => b.kind === 'heading' && b.level === 2 && FAQ_HEADING.test(b.text));
  if (start === -1) return null;
  const next = list.slice(start + 1).find((b) => b.kind === 'heading' && b.level <= 2);
  return { from: list[start].line, to: next ? next.line : Number.MAX_SAFE_INTEGER };
}

function outsideFaq(list: Block[]): (block: Block) => boolean {
  const faq = faqRange(list);
  return (block: Block) => !faq || block.line < faq.from || block.line >= faq.to;
}

/** Standard deviation over the mean. 0 = every value identical. */
function variation(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return 0;
  const spread = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(spread) / mean;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function firstSentence(text: string): string {
  const [first] = text.split(/(?<=[.!?])\s+(?=[A-Z"'“‘])/);
  return (first ?? text).trim();
}

/** The first sentence of an article's running prose, headings skipped. */
function openingSentence(markdown: string): string {
  return sentenceSpans(proseLines(markdown ?? ''))[0]?.text ?? '';
}

function excerpt(text: string, chars = 80): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > chars ? `${clean.slice(0, chars - 1)}…` : clean;
}

/**
 * The move a sentence opens with. Two sections that both start "The Dyson V15
 * is..." and "The Shark Detect is..." are the same shape even though they
 * share no words, which is exactly the tell a word-level check misses.
 */
const OPENING_FRAMES: Array<{ id: string; re: RegExp }> = [
  { id: 'a yes/no answer', re: /^(?:yes|no)\b/i },
  { id: 'a conditional lead-in', re: /^(?:if|when|for|whether|unless)\b/i },
  { id: 'a "there is/are" opener', re: /^there\s+(?:is|are|were)\b/i },
  { id: 'a quantifier ("most/every/all …")', re: /^(?:most|many|some|all|every|few)\b/i },
  { id: 'second person ("you …")', re: /^(?:you|your)\b/i },
  { id: 'first person plural ("we …")', re: /^(?:we|our)\b/i },
  {
    id: 'a definition ("The X is/has/costs …")',
    re: /^the\s+[\w'-]+(?:\s+[\w'-]+)?\s+(?:is|are|was|were|has|have|costs?|weighs?|runs?|delivers?|offers?|comes?|holds?)\b/i,
  },
  {
    id: 'a named product plus copula ("Sony XM6 is …")',
    re: /^[A-Z][\w'-]*(?:\s+[A-Z0-9][\w'-]*){0,3}\s+(?:is|are|was|has|have|costs?|weighs?|wins?|tops?|runs?|holds?)\b/,
  },
];

function openingFrame(sentence: string): string {
  for (const frame of OPENING_FRAMES) if (frame.re.test(sentence)) return frame.id;
  const words = sentence.split(/\s+/).slice(0, 2).join(' ').toLowerCase().replace(/[^a-z0-9 '-]/g, '');
  return `an opening on "${words}"`;
}

interface SectionOpening {
  heading: string;
  /** Line of the opening block, so the finding points at the prose. */
  line: number;
  words: number;
  sentence: string;
  frame: string;
}

/**
 * The block each H2 opens with. Sections that open on a list, a table or an
 * H3 are skipped: there is no opening passage to compare.
 */
function sectionOpenings(list: Block[]): SectionOpening[] {
  const out: SectionOpening[] = [];
  for (const [i, block] of list.entries()) {
    if (block.kind !== 'heading' || block.level !== 2) continue;
    if (FAQ_HEADING.test(block.text)) continue;
    const next = list[i + 1];
    if (!next || next.kind !== 'paragraph') continue;
    const sentence = firstSentence(next.text);
    out.push({
      heading: block.text,
      line: next.line,
      words: next.words,
      sentence,
      frame: openingFrame(sentence),
    });
  }
  return out;
}

/**
 * What "specific" looks like to a regex: prices, model designations, measured
 * quantities, years and dates, and attributions to a named source. Ordered so
 * a model number matches as a model number rather than as a bare figure.
 */
const SPECIFICITY_MARKERS = new RegExp(
  [
    // Prices, in any currency the site quotes.
    String.raw`(?:AU?\$|US\$|\$|€|£)\s?\d[\d,]*(?:\.\d+)?`,
    // Model designations: AF160, XM6, V15, WH-1000XM5.
    String.raw`\b[A-Z][A-Za-z]*-?\d[\dA-Za-z-]*\b`,
    // Measured quantities.
    String.raw`\b\d+(?:[.,]\d+)?\s*(?:%|°C|(?:mm|cm|km|kg|g|ml|l|litres?|liters?|kW|W|watts?|Wh|mAh|dB|rpm|hours?|hrs?|h|minutes?|mins?|seconds?|secs?|years?|months?|weeks?|days?|inch(?:es)?|star|stars)\b)`,
    // Years and dates.
    String.raw`\b(?:19|20)\d{2}\b`,
    String.raw`\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}\b`,
    // Attribution to somebody with a name.
    String.raw`\b(?:according\s+to|as\s+measured\s+by|tested\s+by|reviewed\s+by|as\s+reported\s+by|rated\s+by)\s+[A-Z][\w.'-]*`,
  ].join('|'),
  'g',
);

interface ProseToken {
  word: string;
  line: number;
  /** Bumps at every heading, table or blank line, so no phrase spans a block. */
  block: number;
}

/** Lowercase word tokens of the running prose, each with its body line. */
function proseTokens(lines: string[]): ProseToken[] {
  const out: ProseToken[] = [];
  let block = 0;
  let inProse = false;
  for (const [i, line] of lines.entries()) {
    if (!isProse(line)) {
      if (inProse) block += 1;
      inProse = false;
      continue;
    }
    inProse = true;
    for (const word of line.toLowerCase().match(/[a-z0-9]+(?:'[a-z]+)?/g) ?? []) {
      out.push({ word, line: i + 1, block });
    }
  }
  return out;
}

interface Shingle {
  key: string;
  line: number;
}

/**
 * Overlapping n-word sequences, each anchored to the line it starts on. A
 * sequence never straddles two blocks: the last four words of one section
 * plus the first of the next is not a phrase anybody wrote.
 */
function shingles(tokens: ProseToken[], size: number): Shingle[] {
  const out: Shingle[] = [];
  for (let i = 0; i + size <= tokens.length; i++) {
    if (tokens[i].block !== tokens[i + size - 1].block) continue;
    out.push({
      key: tokens.slice(i, i + size).map((t) => t.word).join(' '),
      line: tokens[i].line,
    });
  }
  return out;
}

function shingleSet(markdown: string, size: number): Set<string> {
  return new Set(shingles(proseTokens(proseLines(markdown ?? '')), size).map((s) => s.key));
}

/** The first `openingTokens` words of the running prose. */
function openingTokens(lines: string[]): string[] {
  return proseTokens(lines)
    .slice(0, SCAN_THRESHOLDS.openingTokens)
    .map((t) => t.word);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const value of a) if (b.has(value)) shared += 1;
  return shared / (a.size + b.size - shared);
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
  // v2 caps sit at or below the tier-1 vocabulary cap on purpose. No single
  // structural metric may drag a draft that is clean on the lexical rules
  // below SLOP_PASS_SCORE, and none may outrank a banned word in the sort
  // below - the reviewer only files the first MAX_SLOP_ISSUES findings, and a
  // banned word must never be the one that falls off the end.
  uniformity: { each: 2, cap: 9 },
  specificity: { each: 1, cap: 12 },
  repetition: { each: 1, cap: 12 },
};

/**
 * Severity the SEO reviewer files a finding under. Banned vocabulary and
 * phrases are always high: one "delve" in an otherwise strong draft still
 * ships an obvious AI tell, and the score alone would let it through. High
 * severity is what forces the revision round, independent of the number.
 */
export function slopSeverity(finding: SlopFinding): 'high' | 'medium' | 'low' {
  if (finding.category === 'banned-word' || finding.category === 'banned-phrase') return 'high';
  if (
    finding.category === 'structure' ||
    finding.category === 'false-agency' ||
    // Never high: these are measurements of shape, and a forced revision round
    // on one of them would spend the loop on prose the reader will not notice.
    finding.category === 'uniformity' ||
    finding.category === 'specificity' ||
    finding.category === 'repetition'
  ) {
    return 'medium';
  }
  return 'low';
}

export function detectSlop(markdown: string, options?: SlopScanOptions): SlopReport {
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
  const spans = sentenceSpans(lines);
  const lengths = spans.map((s) => s.words);
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

  findings.push(...structureFindings(lines, spans));
  findings.push(...specificityFindings(lines, words));
  findings.push(...corpusFindings(lines, options?.corpus ?? []));

  let penalty = 0;
  for (const finding of findings) {
    const { each, cap } = WEIGHTS[finding.category];
    penalty += Math.min(finding.count * each, cap);
  }
  const score = Math.max(0, Math.min(100, Math.round(100 - penalty)));

  // Ordered by the penalty actually applied, not the raw product: a rule that
  // has hit its cap costs no more than its cap, and the reviewer only files
  // the first few findings as issues.
  const applied = (f: SlopFinding): number =>
    Math.min(f.count * WEIGHTS[f.category].each, WEIGHTS[f.category].cap);
  findings.sort((a, b) => applied(b) - applied(a));
  return { score, findings, words };
}

/**
 * Sameness of shape, measured three ways: sentence length, paragraph length,
 * and the move every H2 opens with. Each has its own threshold and files its
 * own finding, because the fix for each is different.
 */
function structureFindings(lines: string[], spans: SentenceSpan[]): SlopFinding[] {
  const T = SCAN_THRESHOLDS;
  const out: SlopFinding[] = [];

  if (spans.length >= T.minSentences) {
    const variance = variation(spans.map((s) => s.words));
    if (variance < T.sentenceVariationMin) {
      const average = mean(spans.map((s) => s.words));
      const flat = spans.filter((s) => Math.abs(s.words - average) <= 3);
      // A bimodal draft can be flat overall with nothing at the mean, and a
      // finding with no line number is one the editor cannot act on.
      const shown = (flat.length > 0 ? flat : spans).slice(0, EXAMPLES_PER_RULE);
      out.push({
        category: 'uniformity',
        rule: 'Flat sentence-length variance',
        matches: shown.map((s) => excerpt(s.text)),
        lines: shown.map((s) => s.line),
        count: Math.max(flat.length, 1),
        fix: `Sentence lengths vary by only ${Math.round(variance * 100)}% around a ${Math.round(average)}-word mean (want ${Math.round(T.sentenceVariationMin * 100)}%+). ${flat.length} of ${spans.length} sentences sit within three words of that mean. Cut some to four or five words and let others run long.`,
      });
    }
  }

  const list = blocks(lines);
  const notFaq = outsideFaq(list);
  const paragraphs = list.filter(
    (b) => b.kind === 'paragraph' && b.words >= T.minParagraphWords && notFaq(b),
  );
  if (paragraphs.length >= T.minParagraphs) {
    const variance = variation(paragraphs.map((p) => p.words));
    if (variance < T.paragraphVariationMin) {
      const average = mean(paragraphs.map((p) => p.words));
      const shown = paragraphs.slice(0, EXAMPLES_PER_RULE);
      out.push({
        category: 'uniformity',
        rule: 'Uniform paragraph length',
        matches: shown.map((p) => `${p.words} words: ${excerpt(p.text, 60)}`),
        lines: shown.map((p) => p.line),
        count: paragraphs.length,
        fix: `${paragraphs.length} paragraphs, all about ${Math.round(average)} words (${Math.round(variance * 100)}% variation, want ${Math.round(T.paragraphVariationMin * 100)}%+). Let the argument set the length: a one-sentence paragraph where the point is short, a long one where it is not.`,
      });
    }
  }

  const openings = sectionOpenings(list);
  if (openings.length >= T.minSections) {
    const tally = new Map<string, SectionOpening[]>();
    for (const opening of openings) {
      tally.set(opening.frame, [...(tally.get(opening.frame) ?? []), opening]);
    }
    const [frame, sharing] = [...tally.entries()].sort((a, b) => b[1].length - a[1].length)[0];
    const repeatedFrame =
      sharing.length >= T.sectionFrameRepeats && sharing.length / openings.length >= T.sectionFrameShare;
    const lengthVariance = variation(openings.map((o) => o.words));
    const uniformLength = lengthVariance < T.sectionOpeningVariationMin;

    if (repeatedFrame || uniformLength) {
      const implicated = repeatedFrame ? sharing : openings;
      const shown = implicated.slice(0, EXAMPLES_PER_RULE);
      const reasons = [
        repeatedFrame ? `${sharing.length} of ${openings.length} sections open with ${frame}` : '',
        uniformLength
          ? `every section's opening block runs about ${Math.round(mean(openings.map((o) => o.words)))} words (${Math.round(lengthVariance * 100)}% variation)`
          : '',
      ].filter(Boolean);
      out.push({
        category: 'uniformity',
        rule: 'Section-shape uniformity',
        matches: shown.map((o) => `${o.heading}: ${excerpt(o.sentence, 60)}`),
        lines: shown.map((o) => o.line),
        count: implicated.length,
        fix: `${reasons.join('; ')}. Vary how sections start - one on a number, one on a caveat, one mid-argument - and let the ones with less to say be shorter.`,
      });
    }
  }

  return out;
}

/**
 * Specificity density. Adjectives are free; numbers, model names, dates and
 * named sources are what a writer only has if somebody did the work. The
 * finding anchors on the paragraphs carrying none at all, so the fix has
 * somewhere to land.
 */
function specificityFindings(lines: string[], words: number): SlopFinding[] {
  const T = SCAN_THRESHOLDS;
  if (words < T.minWordsForSpecificity) return [];

  const markers = scan(lines, SPECIFICITY_MARKERS);
  const budget = Math.ceil((T.specificityPer100 * words) / 100);
  if (markers.count >= budget) return [];

  const paragraphs = blocks(lines).filter((b) => b.kind === 'paragraph');
  const hasSpecific = (text: string): boolean => {
    SPECIFICITY_MARKERS.lastIndex = 0;
    return SPECIFICITY_MARKERS.test(text);
  };
  const bare = paragraphs.filter((p) => p.words >= T.bareParagraphWords && !hasSpecific(p.text));
  // Anchored on the paragraphs carrying nothing specific; failing that, on the
  // longest ones, and failing even that (a draft of nothing but tables) on
  // whatever block comes first, so the finding always points somewhere.
  const byLength = [...paragraphs].sort((a, b) => b.words - a.words);
  const fallback = blocks(lines).slice(0, 1);
  const anchors = (bare.length > 0 ? bare : byLength.length > 0 ? byLength : fallback).slice(
    0,
    EXAMPLES_PER_RULE,
  );

  const per100 = (markers.count / words) * 100;
  return [
    {
      category: 'specificity',
      rule: 'Thin specificity density',
      matches: anchors.map((p) => excerpt(p.text, 60)),
      lines: anchors.map((p) => p.line),
      count: budget - markers.count,
      fix: `${markers.count} specifics (numbers, model designations, dates, named sources) in ${words} words - ${per100.toFixed(1)} per 100, want ${T.specificityPer100}. ${bare.length > 0 ? `${bare.length} paragraph(s) carry none at all, starting at the lines above. ` : ''}Replace the adjectives with the figure from the dossier and name who measured it.`,
    },
  ];
}

/**
 * Cross-corpus repetition. Everything above judges one draft in isolation,
 * which is exactly what let the site converge on a single voice: each article
 * passed on its own. These two metrics are the only ones that can see it.
 */
function corpusFindings(lines: string[], corpus: CorpusArticle[]): SlopFinding[] {
  const T = SCAN_THRESHOLDS;
  const usable = corpus.filter((doc) => doc && typeof doc.body === 'string' && doc.body.trim() !== '');
  if (usable.length === 0) return [];

  const out: SlopFinding[] = [];
  const draftShingles = shingles(proseTokens(lines), T.ngramSize);
  const published = usable.map((doc) => ({ doc, keys: shingleSet(doc.body, T.ngramSize) }));

  if (draftShingles.length >= T.minDraftShingles) {
    const seen = new Map<string, Shingle>();
    for (const shingle of draftShingles) if (!seen.has(shingle.key)) seen.set(shingle.key, shingle);

    // Phrasing that turns up in most published articles is site furniture -
    // the disclaimer, the CTA line - which the editorial rules require, so it
    // is excluded from the comparisons below rather than thrashing every
    // draft. Past a point that stops being true: an article whose phrasing is
    // a tenth house-standard is not carrying furniture, it is the sameness
    // itself, and that gets its own finding.
    const furnitureAt = Math.ceil(T.boilerplateDocShare * published.length);
    const furniture: Shingle[] = [];
    const unique: Shingle[] = [];
    for (const shingle of seen.values()) {
      const ubiquitous =
        published.length >= T.minDocsForBoilerplate &&
        published.filter((p) => p.keys.has(shingle.key)).length >= furnitureAt;
      (ubiquitous ? furniture : unique).push(shingle);
    }

    const stockShare = furniture.length / seen.size;
    const stockBudget = Math.max(T.stockPhrasingFloor, T.stockPhrasingAllowance * seen.size);
    if (furniture.length > stockBudget) {
      const shown = furniture.slice(0, EXAMPLES_PER_RULE);
      out.push({
        category: 'repetition',
        rule: 'House phrasing repeated site-wide',
        matches: shown.map((s) => s.key),
        lines: shown.map((s) => s.line),
        count: furniture.length,
        fix: `${Math.round(stockShare * 100)}% of this draft's ${T.ngramSize}-word sequences appear in most of the last ${published.length} published articles (allowance ${Math.round(T.stockPhrasingAllowance * 100)}%, which covers the disclaimer and the CTA lines). This is the sameness a reader notices across two of our pages: rewrite the recurring frames, keeping only the wording the editorial rules actually require.`,
      });
    }

    if (unique.length >= T.minDraftShingles) {
      const perArticle = published
        .map((p) => ({ doc: p.doc, shared: unique.filter((s) => p.keys.has(s.key)) }))
        .sort((a, b) => b.shared.length - a.shared.length);
      const worst = perArticle[0];
      const worstRatio = worst.shared.length / unique.length;
      const anywhere = unique.filter((s) => published.some((p) => p.keys.has(s.key)));
      const corpusRatio = anywhere.length / unique.length;

      if (worstRatio >= T.maxArticleOverlap || corpusRatio >= T.maxCorpusOverlap) {
        const shown = (worstRatio >= T.maxArticleOverlap ? worst.shared : anywhere).slice(
          0,
          EXAMPLES_PER_RULE,
        );
        const reasons = [
          worstRatio >= T.maxArticleOverlap
            ? `${Math.round(worstRatio * 100)}% of them also appear in "${worst.doc.slug}"`
            : '',
          corpusRatio >= T.maxCorpusOverlap
            ? `${Math.round(corpusRatio * 100)}% appear somewhere in the last ${published.length} published articles`
            : '',
        ].filter(Boolean);
        out.push({
          category: 'repetition',
          rule: `Recycled phrasing from published articles`,
          matches: shown.map((s) => s.key),
          lines: shown.map((s) => s.line),
          count: (worstRatio >= T.maxArticleOverlap ? worst.shared : anywhere).length,
          fix: `Of this draft's ${unique.length} distinct ${T.ngramSize}-word sequences, ${reasons.join(' and ')}. Rewrite those passages in this article's own terms - a reader who lands on two of our pages must not meet the same sentences twice.`,
        });
      }
    }
  }

  const draftOpening = new Set(openingTokens(lines));
  if (draftOpening.size >= 8) {
    const similar = usable
      .map((doc) => {
        const opening = new Set(openingTokens(proseLines(doc.body)));
        return {
          doc,
          similarity: jaccard(draftOpening, opening),
          shared: [...draftOpening].filter((word) => opening.has(word)).length,
        };
      })
      .filter((match) => match.similarity >= T.maxOpeningSimilarity)
      .sort((a, b) => b.similarity - a.similarity);

    if (similar.length > 0) {
      const worst = similar[0];
      const openingLine = proseTokens(lines)[0]?.line ?? 1;
      out.push({
        category: 'repetition',
        rule: 'Opening reused from a published article',
        matches: similar
          .slice(0, EXAMPLES_PER_RULE)
          .map((m) => `${m.doc.slug} (${Math.round(m.similarity * 100)}%): ${excerpt(openingSentence(m.doc.body), 60)}`),
        lines: [openingLine],
        // Counted in shared words rather than in matching articles: one
        // recycled opening is the finding, and how much of it is recycled is
        // what decides the penalty.
        count: worst.shared,
        fix: `This draft's first ${T.openingTokens} words share ${Math.round(worst.similarity * 100)}% of their vocabulary with "${worst.doc.slug}"${similar.length > 1 ? ` and ${similar.length - 1} other published article(s)` : ''} (threshold ${Math.round(T.maxOpeningSimilarity * 100)}%). Open on something only this article can say - the pick and the number that decided it - rather than the house formula.`,
      });
    }
  }

  return out;
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
