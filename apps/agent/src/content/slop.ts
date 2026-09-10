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
// takes an optional corpus of already-published bodies and measures verbatim
// runs, n-gram overlap and opening-line overlap against it.
//
// House text is handled by registry rather than by allowance (HOUSE_BLOCKS):
// the disclosure and the pointer at the standing methodology page are removed
// from both sides before any similarity is measured, and the disclosure is
// asserted by presence instead - each endorsement needs its own, so repeating
// it is correct and absence is the defect.
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
  | 'repetition'
  /** Required house text: present, verbatim, and never counted as repetition. */
  | 'disclosure';

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
  /** Prose word count of the draft, which the per-1,000-word budgets scale with. */
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
  /**
   * Body-copy words needed before a density or presence read is anything but
   * noise. Spec tables are not body copy and are excluded from both sides of
   * every density below, so a table of figures cannot carry a vague article.
   */
  minWordsForSpecificity: 300,
  /**
   * Verifiable specifics (prices, model designations, measured quantities,
   * dates, named sources) wanted per 100 words of body copy.
   *
   * Calibrated against the AU category leaders rather than against our own
   * prose, which is the trap: CHOICE and Canstar Blue run 5-14 per 100 words
   * in verdict and test-result passages and about 2 in their thinnest
   * methodology boilerplate, which blends to 3-5 across a whole article once
   * intro, explainer and FAQ prose are counted. 3.0 is the floor of that band.
   */
  specificityPer100: 3,
  /**
   * ...and no window of this many consecutive words may fall below
   * `specificityWindowPer100`, so an article cannot pass on one dense
   * paragraph bolted to several of filler.
   */
  specificityWindowWords: 150,
  specificityWindowPer100: 1,
  /** A paragraph this long with no specific of any kind gets anchored. */
  bareParagraphWords: 40,

  /** Words per shingle for the cross-corpus n-gram comparison. */
  ngramSize: 5,
  /** Unregistered shingles the draft needs before overlap ratios mean anything. */
  minDraftShingles: 40,
  /**
   * An unbroken run of this many words shared verbatim with one published
   * article is a lifted passage, whatever the totals say. Publication-ethics
   * practice draws the line at a sentence-length run, and similarity tooling
   * matches on runs rather than on a global percentage.
   */
  verbatimRunWords: 25,
  /**
   * Share of the draft's remaining body words - remaining meaning after the
   * registered house blocks are removed from both sides - that may also
   * appear in the published corpus. The house voice is budgeted in words by
   * HOUSE_BLOCKS, not as a share of the draft, because a percentage allowance
   * simultaneously excuses 280 words of padding on a flagship guide and flags
   * the required disclosure on a short one.
   */
  maxSharedWordShare: 0.05,
  /**
   * Unregistered phrasing in at least this share of the corpus is house voice
   * that nobody registered: the fix is to register it or move it to a
   * standing page, so it gets its own finding rather than the recycling one.
   * Needs `minDocsForUbiquity` documents before the share means anything.
   */
  ubiquitousDocShare: 0.6,
  minDocsForUbiquity: 5,
  /** Token overlap between two opening paragraphs before they are one opening. */
  maxOpeningSimilarity: 0.45,
  /** Opening tokens compared. */
  openingTokens: 30,

  /**
   * The cap is on the registry, not on the draft. Observed leader practice is
   * a constant absolute budget - a material-connection line, a rating-scale
   * note and a one-sentence pointer at the standing methodology page - that
   * does not grow with article length. A fifth block, or a longer one, is the
   * signal to move that content to a page and link it.
   */
  houseBlockCount: 4,
  houseBlockWords: 200,
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

/** Prices, in any currency the site quotes. */
const PRICE_MARKER = String.raw`(?:AU?\$|US\$|\$|€|£)\s?\d[\d,]*(?:\.\d+)?`;

/** Model designations: AF160, XM6, V15, WH-1000XM5. */
const MODEL_MARKER = String.raw`\b[A-Z][A-Za-z]*-?\d[\dA-Za-z-]*\b`;

/**
 * Attribution to somebody with a name - the maker, a lab, a named tester.
 * Thin affiliate copy reliably lacks these; the category leaders reliably
 * carry them, which is why the article-level check below asks for one.
 */
const ATTRIBUTION_MARKER = [
  // Case is not optional in this marker set - a model designation is defined
  // by its capital - so an attribution that opens a sentence carries its own.
  String.raw`\b(?:[Aa]ccording\s+to|[Aa]s\s+measured\s+by|[Tt]ested\s+by|[Rr]eviewed\s+by|[Aa]s\s+reported\s+by|[Rr]ated\s+by|[Pp]ublished\s+by|[Aa]s\s+listed\s+by)\s+[A-Z][\w.'-]*`,
  String.raw`\b[A-Z][A-Za-z]+(?:'s)?\s+(?:rates?|rated|quotes?|quoted|publishes|published|lists?|listed|claims?|specifies|specified|measured|reports?)\b`,
  String.raw`\b[A-Z][A-Za-z]+(?:'s)?\s+(?:spec(?:ification)?\s+sheet|data\s+sheet|test\s+(?:results?|bench)|lab|listing|manual|warranty\s+terms)\b`,
].join('|');

/** A date a claim can be checked against: a year, or a month and a day. */
const DATE_MARKER = [
  String.raw`\b(?:19|20)\d{2}\b`,
  String.raw`\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}\b`,
].join('|');

/**
 * What "specific" looks like to a regex: prices, model designations, measured
 * quantities, years and dates, and attributions to a named source. Ordered so
 * a model number matches as a model number rather than as a bare figure.
 *
 * Deliberately not one shape of specific: CHOICE ships measured quantities
 * from its own lab while Canstar Blue is survey-based and nearly all of its
 * specifics are prices, model designations and survey statistics. A gate that
 * demanded measurements alone would fail a page readers plainly treat as
 * authoritative.
 */
const SPECIFICITY_MARKERS = new RegExp(
  [
    PRICE_MARKER,
    MODEL_MARKER,
    // Measured quantities. One word may sit between the figure and its unit
    // ("500 charge cycles"), and a hyphen counts as the space ("2-year").
    String.raw`\b\d+(?:[.,]\d+)?\s*(?:%|°C)`,
    String.raw`\b\d+(?:[.,]\d+)?(?:[\s-][a-z]+)?[\s-](?:mm|cm|km|kg|g|ml|l|litres?|liters?|kW|W|watts?|AW|Wh|mAh|Pa|kPa|GB|TB|Hz|kHz|dB|rpm|cycles?|hours?|hrs?|h|minutes?|mins?|seconds?|secs?|years?|months?|weeks?|days?|inch(?:es)?|stars?)\b`,
    // Decimal ratings - the site's own scale, "4.3 out of 5".
    String.raw`\b\d(?:\.\d)?\s*(?:\/|out\s+of\s+)\s*5\b`,
    DATE_MARKER,
    ATTRIBUTION_MARKER,
  ].join('|'),
  'g',
);

// ---------------------------------------------------------------------------
// The house-block registry
// ---------------------------------------------------------------------------

/**
 * The four kinds of text a publisher legitimately repeats word for word in
 * every article. Publication ethics treats exactly this as a named carve-out -
 * mandated disclosures and boilerplate method descriptions are acceptable
 * reuse - and the FTC requires the material-connection disclosure on every
 * endorsement, because a reader may not have seen any earlier post.
 */
export type HouseBlockTag =
  | 'disclosure'
  | 'methodology-pointer'
  | 'editorial-independence'
  | 'rating-scale';

export interface HouseBlock {
  id: string;
  tag: HouseBlockTag;
  /** Bumped when the wording changes, so a draft can be told which one to use. */
  version: number;
  /** The exact string. Registered text is removed before any similarity is computed. */
  text: string;
}

/**
 * House text, registered rather than allowanced.
 *
 * A percentage allowance misfires in both directions: 10% of a 2,800-word
 * guide is more verbatim repetition than any category leader actually uses,
 * and 10% of a 350-word deal post cannot hold a compliant disclosure. So the
 * registry is a fixed set of exact strings, each removed from BOTH sides of
 * the corpus comparison, and the budget below caps the registry rather than
 * the draft.
 *
 * Every entry restates an existing editorial rule (see agents/context.ts) or
 * an existing page on the site; the registry is where the wording is frozen so
 * it can be exempted, asserted and versioned in one place. Depth belongs on a
 * standing page - the methodology entry is a pointer, not the method.
 */
export const HOUSE_BLOCKS: HouseBlock[] = [
  {
    id: 'no-hands-on-testing',
    tag: 'disclosure',
    version: 1,
    text: 'This is editorial synthesis from published specifications, retailer listings and owner reviews. We have not run these products through a lab.',
  },
  {
    id: 'how-we-picked-pointer',
    tag: 'methodology-pointer',
    version: 1,
    text: 'We start from what is actually sold in Australia, cut anything without a published spec sheet, and read the 1-star reviews before the 5-star ones. Our full method is on the disclaimer page.',
  },
  {
    id: 'editorial-independence',
    tag: 'editorial-independence',
    version: 1,
    text: 'No brand pays for a place on this site, and no brand sees a piece before it is published.',
  },
  {
    id: 'decimal-ratings',
    tag: 'rating-scale',
    version: 1,
    text: 'Ratings are decimal out of 5 and describe how a product performs for the buyer this piece is written for, not against every product ever made.',
  },
];

/** Words of registered house text. Capped by `SCAN_THRESHOLDS.houseBlockWords`. */
export function houseBlockWords(entries: HouseBlock[] = HOUSE_BLOCKS): number {
  return countWords(entries.map((entry) => entry.text));
}

/** Lowercase, punctuation-free form, for comparing a draft against a block. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^a-z0-9'$%. ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Something the reader can recognise as the no-hands-on disclosure, whatever
 * words it ended up in. Presence is what the check asserts; the registered
 * wording is what it asks for.
 */
const DISCLOSURE_EQUIVALENT =
  /\b(?:editorial\s+synthesis|have\s+not\s+(?:lab-)?tested|haven(?:'|’)?t\s+(?:lab-)?tested|not\s+(?:run|put)\s+these[\s\S]{0,60}?through\s+a\s+lab|no\s+hands-on\s+testing|without\s+hands-on\s+testing)\b/i;

/** An affiliate link in the raw markdown - the signal that a page earns commission. */
const AFFILIATE_LINK = /\]\(\/go\/[a-z0-9][a-z0-9-]*\)/i;

/** The same link, capturing the product slug. */
const AFFILIATE_SLUG = /\]\(\/go\/([a-z0-9][a-z0-9-]*)\)/gi;

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
  /** Token index it starts at, so consecutive shingles can be recognised. */
  index: number;
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
      index: i,
    });
  }
  return out;
}

function shingleSet(lines: string[], size: number): Set<string> {
  return new Set(shingles(proseTokens(lines), size).map((s) => s.key));
}

/**
 * Prose for the cross-corpus metrics, with the anchor text of affiliate links
 * dropped. "Check the price on Amazon" is mandated by the link-placement
 * rules and appears on every page by design, so counting it as repetition
 * would flag the one thing the article is required to say.
 */
function repetitionLines(markdown: string): string[] {
  return proseLines((markdown ?? '').replace(/\[[^\]]*\]\(\/go\/[^)]*\)/g, ' '));
}

/** Words on each 1-based line that belong to a registered house block. */
function registeredWordsByLine(lines: string[]): Map<number, number> {
  const tokens = proseTokens(lines);
  const registered = registeredShingles();
  const covered = new Set<number>();
  for (const shingle of shingles(tokens, SCAN_THRESHOLDS.ngramSize)) {
    if (!registered.has(shingle.key)) continue;
    for (let i = 0; i < SCAN_THRESHOLDS.ngramSize; i++) covered.add(shingle.index + i);
  }
  const byLine = new Map<number, number>();
  for (const index of covered) {
    const line = tokens[index].line;
    byLine.set(line, (byLine.get(line) ?? 0) + 1);
  }
  return byLine;
}

/** Every 5-word sequence of the registered house blocks. Computed once. */
let registeredKeys: Set<string> | null = null;
function registeredShingles(): Set<string> {
  if (!registeredKeys) {
    registeredKeys = new Set<string>();
    for (const block of HOUSE_BLOCKS) {
      for (const key of shingleSet(proseLines(block.text), SCAN_THRESHOLDS.ngramSize)) {
        registeredKeys.add(key);
      }
    }
  }
  return registeredKeys;
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
  // A presence check, not a density: three points for a paraphrase, nine for
  // no disclosure at all. Enough that the editor fixes it in the round it is
  // raised, never enough to route a draft back on its own.
  disclosure: { each: 3, cap: 9 },
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
    finding.category === 'repetition' ||
    finding.category === 'disclosure'
  ) {
    return 'medium';
  }
  return 'low';
}

export function detectSlop(markdown: string, options?: SlopScanOptions): SlopReport {
  const raw = (markdown ?? '').split('\n');
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
  findings.push(...specificityFindings(raw, lines));
  findings.push(...disclosureFindings(raw, lines));
  findings.push(...corpusFindings(markdown ?? '', options?.corpus ?? []));

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
 * Body copy: the prose, with spec tables and registered house blocks blanked
 * out and line numbers kept.
 *
 * A table of figures must not be able to carry a vague article; a heading is
 * navigation, so a model designation parked in an H2 cannot either; and the
 * mandated house text - the disclosure, the pointer at the standing
 * methodology page - carries no specifics by nature and is not the writer's
 * to make specific. Both sides of every density below are measured on what is
 * left, which is the writing this piece is actually responsible for.
 */
function bodyCopyLines(lines: string[]): string[] {
  const house = registeredWordsByLine(lines);
  return lines.map((line, i) => {
    const table = /^\s*\|/.test(line);
    const heading = /^\s*#{1,6}\s/.test(line);
    const registered = (house.get(i + 1) ?? 0) >= countWords([line]);
    return table || heading || registered ? '' : line;
  });
}

function countMarkers(text: string): number {
  SPECIFICITY_MARKERS.lastIndex = 0;
  return (text.match(SPECIFICITY_MARKERS) ?? []).length;
}

function hasSpecific(text: string): boolean {
  SPECIFICITY_MARKERS.lastIndex = 0;
  return SPECIFICITY_MARKERS.test(text);
}

/** A stretch of body copy whose specificity density falls below the floor. */
interface ThinStretch {
  line: number;
  text: string;
}

/**
 * Rolling windows of `specificityWindowWords` consecutive body words, so an
 * article cannot pass the article-level gate on one dense paragraph bolted to
 * several of filler. Overlapping thin windows are merged, so the editor gets
 * one anchor per thin passage rather than one per window.
 */
function thinStretches(lines: string[]): ThinStretch[] {
  const T = SCAN_THRESHOLDS;
  const rows = lines
    .map((line, i) => ({ line: i + 1, text: line, words: countWords([line]), markers: countMarkers(line) }))
    .filter((row) => row.words > 0);

  const out: ThinStretch[] = [];
  let last = -1;
  let end = 0;
  let words = 0;
  let markers = 0;
  for (let start = 0; start < rows.length; start++) {
    if (end < start) {
      end = start;
      words = 0;
      markers = 0;
    }
    while (end < rows.length && words < T.specificityWindowWords) {
      words += rows[end].words;
      markers += rows[end].markers;
      end += 1;
    }
    // The tail of an article is not a window: judging the last 40 words on
    // their own would flag every conclusion.
    if (words < T.specificityWindowWords) break;
    if ((markers / words) * 100 < T.specificityWindowPer100 && rows[start].line > last) {
      out.push({ line: rows[start].line, text: rows[start].text });
      last = rows[end - 1].line;
    }
    words -= rows[start].words;
    markers -= rows[start].markers;
  }
  return out;
}

/** A heading and the body lines under it, from the raw markdown. */
interface RawSection {
  heading: string;
  /** 1-based line of the heading. */
  line: number;
  from: number;
  to: number;
}

function rawSections(raw: string[]): RawSection[] {
  // The opening is a section too: it is where the "buy the X" answer lives,
  // and it carries a link as often as any H2 does.
  const out: RawSection[] = [{ heading: 'the opening', line: 1, from: 1, to: raw.length }];
  for (const [i, line] of raw.entries()) {
    const heading = /^\s*#{2,6}\s+(.*)$/.exec(line);
    if (!heading) continue;
    out[out.length - 1].to = i;
    out.push({ heading: heading[1].trim(), line: i + 1, from: i + 1, to: raw.length });
  }
  return out.filter((section) => section.to >= section.from);
}

interface ProductPick {
  slug: string;
  /** 1-based line of the first link to this product. */
  line: number;
  hasPrice: boolean;
  hasModel: boolean;
}

/**
 * The products this piece earns on, found through the affiliate links rather
 * than by guessing at prose: a /go/ slug is the site's own record that a
 * passage sells something. Each owes the reader a price and an exact model
 * designation, which is what a category-leader page always carries and thin
 * affiliate copy never does.
 *
 * Judged across every section that links the product, not section by section:
 * the link-placement rules have the conclusion link each pick a second time,
 * and a verdict line is not the place to restate the RRP.
 */
function productPicks(raw: string[], lines: string[]): ProductPick[] {
  const price = new RegExp(PRICE_MARKER, 'g');
  const model = new RegExp(MODEL_MARKER, 'g');
  const picks = new Map<string, ProductPick>();

  for (const section of rawSections(raw)) {
    const linked = new Map<string, number>();
    for (const [offset, line] of raw.slice(section.from - 1, section.to).entries()) {
      AFFILIATE_SLUG.lastIndex = 0;
      for (const match of line.matchAll(AFFILIATE_SLUG)) {
        const slug = match[1].toLowerCase();
        if (!linked.has(slug)) linked.set(slug, section.from + offset);
      }
    }
    if (linked.size === 0) continue;

    // Prose lines, so a /go/ slug or an image URL cannot pass as a model
    // designation; tables kept, because a comparison row is a fair place for
    // the price to live.
    const text = lines.slice(section.from - 1, section.to).join(' ');
    price.lastIndex = 0;
    model.lastIndex = 0;
    const hasPrice = price.test(text);
    const hasModel = model.test(text);

    for (const [slug, line] of linked) {
      const seen = picks.get(slug);
      if (seen) {
        seen.hasPrice = seen.hasPrice || hasPrice;
        seen.hasModel = seen.hasModel || hasModel;
      } else {
        picks.set(slug, { slug, line, hasPrice, hasModel });
      }
    }
  }
  return [...picks.values()];
}

/**
 * Specificity, measured the way the AU category leaders actually write.
 *
 * Four checks, four findings, because the fix for each is different: the
 * article-level density, the rolling window that stops one dense paragraph
 * carrying an article of filler, a price and a model designation for every
 * product we earn on, and one dated named source for the piece.
 *
 * All four are density or presence reads over a whole article, so all four
 * wait for `minWordsForSpecificity` words of body copy: below that a deal post
 * would be judged on a paragraph.
 */
function specificityFindings(raw: string[], lines: string[]): SlopFinding[] {
  const T = SCAN_THRESHOLDS;
  const out: SlopFinding[] = [];

  // Spec tables are excluded from both sides of the density: a table of
  // figures must not be able to carry a vague article.
  const body = bodyCopyLines(lines);
  const words = countWords(body);
  if (words < T.minWordsForSpecificity) return out;

  const markers = scan(body, SPECIFICITY_MARKERS);
  const budget = Math.ceil((T.specificityPer100 * words) / 100);
  if (markers.count < budget) {
    const paragraphs = blocks(body).filter((b) => b.kind === 'paragraph');
    const bare = paragraphs.filter((p) => p.words >= T.bareParagraphWords && !hasSpecific(p.text));
    // Anchored on the paragraphs carrying nothing specific; failing that, on
    // the longest ones, and failing even that on whatever block comes first,
    // so the finding always points somewhere.
    const byLength = [...paragraphs].sort((a, b) => b.words - a.words);
    const fallback = blocks(lines).slice(0, 1);
    const anchors = (bare.length > 0 ? bare : byLength.length > 0 ? byLength : fallback).slice(
      0,
      EXAMPLES_PER_RULE,
    );
    const per100 = (markers.count / words) * 100;
    out.push({
      category: 'specificity',
      rule: 'Thin specificity density',
      matches: anchors.map((p) => excerpt(p.text, 60)),
      lines: anchors.map((p) => p.line),
      count: budget - markers.count,
      fix: `${markers.count} specifics (numbers, model designations, dates, named sources) in ${words} words of body copy - ${per100.toFixed(1)} per 100, want ${T.specificityPer100}. ${bare.length > 0 ? `${bare.length} paragraph(s) carry none at all, starting at the lines above. ` : ''}Replace the adjectives with the figure from the dossier and name who published it. Spec tables do not count towards this.`,
    });
  }

  const thin = thinStretches(body);
  if (thin.length > 0) {
    const shown = thin.slice(0, EXAMPLES_PER_RULE);
    out.push({
      category: 'specificity',
      rule: 'Thin passage',
      matches: shown.map((stretch) => excerpt(stretch.text, 60)),
      lines: shown.map((stretch) => stretch.line),
      count: thin.length,
      fix: `${thin.length} passage(s) of ${T.specificityWindowWords} words carry fewer than ${T.specificityWindowPer100} specific(s) per 100 words. An article does not pass on one dense paragraph: give each of these a figure, a model designation or a dated source, or cut it.`,
    });
  }

  const picks = productPicks(raw, lines);
  const incomplete = picks.filter((pick) => !pick.hasPrice || !pick.hasModel);
  if (incomplete.length > 0) {
    const shown = incomplete.slice(0, EXAMPLES_PER_RULE);
    out.push({
      category: 'specificity',
      rule: 'Product without a price or a model designation',
      matches: shown.map(
        (pick) =>
          `/go/${pick.slug} (missing ${[
            pick.hasPrice ? '' : 'price',
            pick.hasModel ? '' : 'model designation',
          ]
            .filter(Boolean)
            .join(' and ')})`,
      ),
      lines: shown.map((pick) => pick.line),
      count: incomplete.length,
      fix: `${incomplete.length} of ${picks.length} linked product(s) are covered without their exact model designation ("Ninja AF160", not "the Ninja") or without a price. Add both where the product is covered. The price is the manufacturer's RRP with its source and year - never an Amazon price, which the Associates terms do not let us print.`,
    });
  }

  const named = new RegExp(ATTRIBUTION_MARKER);
  const date = new RegExp(DATE_MARKER);
  const dated = sentenceSpans(body).filter(
    (span) => named.test(span.text) && date.test(span.text),
  );
  if (dated.length === 0) {
    const first = blocks(body)[0];
    out.push({
      category: 'specificity',
      rule: 'No dated, named source',
      matches: first ? [excerpt(first.text, 60)] : [],
      lines: [first?.line ?? 1],
      count: 1,
      fix: 'No sentence names a source and dates it. Every category-leading review carries at least one - "Dyson rates the V15 at 60 minutes in its 2026 spec sheet", "according to CHOICE\'s 2026 test" - and thin affiliate copy carries none. Attribute one load-bearing claim to whoever published it, in the same sentence as the year.',
    });
  }

  return out;
}

/**
 * The one block that must repeat verbatim in every article.
 *
 * This is the inverse of the repetition metrics below, and deliberately so:
 * the FTC's position is that each endorsement needs its own disclosure,
 * because a reader may not have seen an earlier post, so the failure mode here
 * is absence, never repetition. The commission disclosure itself is page
 * furniture the site renders beside the links; what the body owes the reader
 * is the hands-on disclosure - that nobody here put these products on a bench.
 */
function disclosureFindings(raw: string[], lines: string[]): SlopFinding[] {
  const T = SCAN_THRESHOLDS;
  const block = HOUSE_BLOCKS.find((entry) => entry.tag === 'disclosure');
  if (!block) return [];
  if (countWords(bodyCopyLines(lines)) < T.minWordsForSpecificity) return [];
  if (!raw.some((line) => AFFILIATE_LINK.test(line))) return [];

  const body = normalise(lines.join(' '));
  if (body.includes(normalise(block.text))) return [];

  const reworded = DISCLOSURE_EQUIVALENT.test(lines.join(' '));
  const anchor = blocks(lines).at(-1);
  return [
    {
      category: 'disclosure',
      rule: reworded ? 'Affiliate disclosure reworded' : 'Affiliate disclosure missing',
      matches: [block.text],
      lines: [anchor?.line ?? 1],
      // Absence is the defect; a reworded one is a smaller defect than none.
      count: reworded ? 1 : 3,
      fix: `This piece links products we earn on${reworded ? ' and discloses that it was not hands-on tested, but not in the registered wording' : ' but never says we have not tested them'}. Add the registered ${block.tag} block (v${block.version}) verbatim: "${block.text}" - registered house text is exempt from the repetition metrics, a paraphrase is not.`,
    },
  ];
}

/**
 * Cross-corpus repetition. Everything above judges one draft in isolation,
 * which is exactly what let the site converge on a single voice: each article
 * passed on its own. These metrics are the only ones that can see it.
 *
 * The registered house blocks come out of both sides first, so what is
 * measured is the phrasing nobody approved: a lifted passage, a recycled
 * article, or a house frame that has never been registered and should either
 * be registered or moved to a standing page.
 */
function corpusFindings(markdown: string, corpus: CorpusArticle[]): SlopFinding[] {
  const T = SCAN_THRESHOLDS;
  const usable = corpus.filter((doc) => doc && typeof doc.body === 'string' && doc.body.trim() !== '');
  if (usable.length === 0) return [];

  const out: SlopFinding[] = [];
  const lines = repetitionLines(markdown);
  const tokens = proseTokens(lines);
  const draft = shingles(tokens, T.ngramSize);
  const registered = registeredShingles();
  const published = usable.map((doc) => ({
    doc,
    keys: shingleSet(repetitionLines(doc.body), T.ngramSize),
  }));

  // Registered house text is removed from numerator and denominator before
  // anything is measured, so it cannot contribute to a flag at any length.
  const registeredWords = new Set<number>();
  for (const shingle of draft) {
    if (!registered.has(shingle.key)) continue;
    for (let i = 0; i < T.ngramSize; i++) registeredWords.add(shingle.index + i);
  }
  const remainingWords = tokens.length - registeredWords.size;
  const unregistered = draft.filter((shingle) => !registered.has(shingle.key));

  // Measured on what is left, so the gate is on what is left: a deal post
  // that is mostly its required disclosure has nothing to compare.
  if (unregistered.length >= T.minDraftShingles) {
    const inDocs = new Map<string, number>();
    for (const shingle of unregistered) {
      if (inDocs.has(shingle.key)) continue;
      inDocs.set(shingle.key, published.filter((p) => p.keys.has(shingle.key)).length);
    }
    const ubiquitousAt = Math.ceil(T.ubiquitousDocShare * published.length);
    const isUbiquitous = (key: string): boolean =>
      published.length >= T.minDocsForUbiquity && (inDocs.get(key) ?? 0) >= ubiquitousAt;

    /** Share of the remaining body words these shingles cover. */
    const share = (list: Shingle[]): number => {
      if (remainingWords <= 0) return 0;
      const covered = new Set<number>();
      for (const shingle of list) {
        for (let i = 0; i < T.ngramSize; i++) {
          if (!registeredWords.has(shingle.index + i)) covered.add(shingle.index + i);
        }
      }
      return covered.size / remainingWords;
    };

    const distinct = (list: Shingle[]): Shingle[] => {
      const seen = new Set<string>();
      return list.filter((shingle) => !seen.has(shingle.key) && seen.add(shingle.key));
    };

    // A run of consecutive shared sequences is a lifted passage - the thing a
    // percentage total hides, because 25 words in a row is a paragraph nobody
    // rewrote whatever the article's overall overlap says.
    const longestRun = (keys: Set<string>): { length: number; at: number } => {
      let best = { length: 0, at: 0 };
      let length = 0;
      let at = 0;
      for (const [i, shingle] of draft.entries()) {
        const contiguous = length > 0 && draft[i - 1].index === shingle.index - 1;
        if (keys.has(shingle.key) && !registered.has(shingle.key)) {
          length = contiguous ? length + 1 : 1;
          if (!contiguous) at = i;
        } else {
          length = 0;
        }
        if (length > best.length) best = { length, at };
      }
      return best;
    };

    const runs = published
      .map((p) => ({ doc: p.doc, run: longestRun(p.keys) }))
      .map((entry) => ({ ...entry, words: entry.run.length === 0 ? 0 : entry.run.length + T.ngramSize - 1 }))
      .sort((a, b) => b.words - a.words);
    const worstRun = runs[0];
    if (worstRun && worstRun.words >= T.verbatimRunWords) {
      const from = draft[worstRun.run.at].index;
      const passage = tokens.slice(from, from + worstRun.words).map((t) => t.word).join(' ');
      out.push({
        category: 'repetition',
        rule: 'Verbatim passage recycled from a published article',
        matches: [excerpt(passage, 120)],
        lines: [draft[worstRun.run.at].line],
        count: worstRun.words,
        fix: `${worstRun.words} consecutive words here also run word for word in "${worstRun.doc.slug}" (limit ${T.verbatimRunWords}). Rewrite the passage from the evidence rather than from the earlier article, or - if it is house text every piece owes the reader - register it in HOUSE_BLOCKS so it is exempt everywhere.`,
      });
    }

    // Deduped only for reporting: `share` needs every occurrence, because it
    // measures the words these sequences cover, not how many of them there are.
    const ubiquitous = unregistered.filter((shingle) => isUbiquitous(shingle.key));
    const houseShare = share(ubiquitous);
    if (houseShare >= T.maxSharedWordShare) {
      const distinctHouse = distinct(ubiquitous);
      const shown = distinctHouse.slice(0, EXAMPLES_PER_RULE);
      out.push({
        category: 'repetition',
        rule: 'House phrasing repeated site-wide',
        matches: shown.map((shingle) => shingle.key),
        lines: shown.map((shingle) => shingle.line),
        count: distinctHouse.length,
        fix: `${Math.round(houseShare * 100)}% of this draft's unregistered body words also appear in most of the last ${published.length} published articles (limit ${Math.round(T.maxSharedWordShare * 100)}%). This is the sameness a reader meets on the second page they open. Either rewrite these frames in this article's own terms, or - if every piece genuinely owes the reader this text - shorten it to a pointer at a standing page and register that pointer in HOUSE_BLOCKS (budget ${T.houseBlockCount} blocks, ${T.houseBlockWords} words).`,
      });
    }

    const recycled = unregistered.filter(
      (shingle) => (inDocs.get(shingle.key) ?? 0) > 0 && !isUbiquitous(shingle.key),
    );
    const recycledShare = share(recycled);
    if (recycledShare >= T.maxSharedWordShare) {
      const perDoc = published
        .map((p) => ({ doc: p.doc, shared: recycled.filter((shingle) => p.keys.has(shingle.key)) }))
        .sort((a, b) => b.shared.length - a.shared.length);
      const worst = perDoc[0];
      const shown = distinct(worst.shared.length > 0 ? worst.shared : recycled).slice(0, EXAMPLES_PER_RULE);
      out.push({
        category: 'repetition',
        rule: 'Recycled phrasing from published articles',
        matches: shown.map((shingle) => shingle.key),
        lines: shown.map((shingle) => shingle.line),
        count: distinct(recycled).length,
        fix: `${Math.round(recycledShare * 100)}% of this draft's unregistered body words already appear in the last ${published.length} published articles (limit ${Math.round(T.maxSharedWordShare * 100)}%), most of it in "${worst.doc.slug}". Rewrite those passages in this article's own terms - a reader who lands on two of our pages must not meet the same sentences twice.`,
      });
    }
  }

  const draftOpening = new Set(openingTokens(lines));
  if (draftOpening.size >= 8) {
    const similar = usable
      .map((doc) => {
        const opening = new Set(openingTokens(repetitionLines(doc.body)));
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
