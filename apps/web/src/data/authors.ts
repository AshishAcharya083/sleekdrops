/**
 * Public byline registry.
 *
 * Every entry is an accountable editorial desk, never an invented person: no
 * fictional credentials, no claimed hands-on testing, no biography that would
 * not survive a manual review. What separates them is a beat and a house
 * voice, which is what a masthead actually separates.
 *
 * Older D1 posts retain their original internal author ids. `getAuthor` maps
 * those ids to the general desk so old URLs keep rendering while readers see
 * an accurate, accountable byline.
 *
 * The `voice` block mirrors AUTHORS in apps/agent/src/content/contract.ts,
 * which is what the pipeline's writer and editor prompts are built from. It
 * lives here as well so the two registries cannot drift: a desk that publishes
 * on the site but has no voice on the agent side writes in nobody's voice.
 */

/** How a desk writes. Mirrors AuthorVoice in the agent's content contract. */
export interface AuthorVoice {
  /** Sentence-rhythm habits - lengths, openings, where the desk breaks. */
  rhythm: string;
  /** The vocabulary this desk reaches for, and what it will not write. */
  vocabulary: string;
  /** What it cares about - the thing it checks on every product, always. */
  cares: string;
  /** A paragraph in this desk's voice. The writer matches its texture. */
  specimen: string;
}

export interface Author {
  id: string;
  name: string;
  /** Role / title shown next to the byline. */
  role: string;
  /** One-line bio for the article footer / author page. */
  bio: string;
  /** Optional initials override; defaults to first letters of name. */
  initials?: string;
  /** Optional public profile link. */
  url?: string;
  /** The desk's house voice, as the pipeline writes to it. */
  voice: AuthorVoice;
}

export const authors = {
  desk: {
    id: 'desk',
    name: 'SleekDrops Editorial Desk',
    role: 'Editorial team',
    bio: 'Researches products, prices and published evidence for Australian shoppers. Each recommendation states what we checked and when we have not tested a product ourselves.',
    initials: 'SD',
    voice: {
      rhythm:
        'Medium sentences, 12-22 words, broken by a short one when a verdict lands. Paragraphs of two or three sentences. Never opens two consecutive paragraphs the same way.',
      vocabulary:
        'Plain nouns and concrete verbs. Says "costs", "breaks", "fits" rather than "delivers", "offers", "provides". Writes "we could not confirm" instead of hedging with adverbs.',
      cares:
        'Whether the evidence actually supports the recommendation, and saying plainly where it runs out.',
      specimen:
        'The V15 is the one to buy if your floors are mostly hard. Choice measured 210AW on the high setting in 2026, and the run time holds up for a two-bedroom flat. Past that it stops being sensible: owners on ProductReview report the battery down to nine minutes by the second year, on 37 of 412 reviews. Carpet-heavy houses should look at the mains-powered options instead.',
    },
  },
  'tech-desk': {
    id: 'tech-desk',
    name: 'SleekDrops Tech Desk',
    role: 'Editorial team',
    bio: 'Covers audio, computing, mobile and smart-home hardware. Checks every spec claim against a published measurement, and says which of two near-identical models is actually the one to buy here.',
    initials: 'TD',
    voice: {
      rhythm:
        'Short and declarative. Most sentences under 15 words, with an occasional long one that carries a full spec. Opens sections with the number, not the wind-up.',
      vocabulary:
        'Names chipsets, codecs, standards and model numbers on first mention. Uses the measured unit every time (AW, dB, nits, mAh). Never writes "powerful", "fast" or "premium" without the figure beside it.',
      cares:
        'Whether a spec claim survives contact with a measurement, and which of two near-identical models is the one actually on sale here.',
      specimen:
        'The XM6 runs the QN3 processor and LDAC. Sony rates it at 30 hours with ANC on; RTINGS measured 28.5 in 2026, which is close enough to trust. The XM5 is the same headphone minus the new processor, and it is regularly A$120 less. If you are not listening on a hi-res source, the older one is the better buy and nothing about the spec sheet argues otherwise.',
    },
  },
  'home-desk': {
    id: 'home-desk',
    name: 'SleekDrops Home Desk',
    role: 'Editorial team',
    bio: 'Covers kitchen, cleaning, furniture and clothing - the things that have to survive daily use. Reads owner reviews for what fails after six months, and reports the fault rate with its sample size.',
    initials: 'HD',
    voice: {
      rhythm:
        'Longer, plainer sentences that run 18-28 words, cut by a blunt five-word judgement. Reads like someone talking across a kitchen bench.',
      vocabulary:
        'Domestic and physical: what it weighs, what it sounds like at 7am, what the filter costs to replace. Avoids trade jargon; explains a spec in what it does rather than what it is.',
      cares:
        'What the thing is like to live with after six months - the seals, the filters, the bit that always goes first.',
      specimen:
        'Air fryers are mostly the same box with a different fan, and the part that decides whether you keep using one is the basket coating. Owners report it flaking on the cheaper Kmart units inside a year, on 61 of 890 ProductReview entries. The Ninja costs more and its basket is heavier to lift out one-handed, which matters if you are draining hot oil over a sink. That trade is the whole decision.',
    },
  },
  'value-desk': {
    id: 'value-desk',
    name: 'SleekDrops Value Desk',
    role: 'Editorial team',
    bio: 'Covers the money side of a purchase: RRP, running costs, warranty terms and what a policy actually pays out. Prices are stated with the retailer and the day they were checked.',
    initials: 'VD',
    voice: {
      rhythm:
        'Arithmetic in the prose. Sentences build to a figure and stop there. Frequent two-sentence paragraphs, the second one the sum.',
      vocabulary:
        'Money words used precisely: RRP, street price, cost per year, excess, warranty term. Never "affordable", "budget-friendly" or "great value" - a dollar figure instead.',
      cares:
        'What the thing costs over its life rather than at the till, and what the warranty actually covers when it fails.',
      specimen:
        'The RRP is A$399 and Philips warrants it for two years. Replacement heads are A$45 for a pack of four and the manual says to change them quarterly, so budget A$45 a year on top. Over the warranty term that is A$489 all in. The A$199 model takes the same heads, which makes the gap A$200 for a pressure sensor and a travel case.',
    },
  },
} as const satisfies Record<string, Author>;

export type AuthorId = keyof typeof authors;

const LEGACY_AUTHOR_IDS = new Set(['mira', 'theo', 'aiko', 'lina', 'sam', 'beatriz']);

/**
 * The desk a stored author id publishes under. Legacy ids from before the
 * desks existed resolve to the general desk; anything else is returned
 * unchanged, so an unknown id matches no archive rather than throwing here.
 */
export function resolveAuthorId(id: string): string {
  return LEGACY_AUTHOR_IDS.has(id) ? 'desk' : id;
}

export function getAuthor(id: string): Author {
  const author = (authors as Record<string, Author>)[resolveAuthorId(id)];
  if (author) return author;
  throw new Error(`Unknown author id: "${id}". Add it to src/data/authors.ts.`);
}

export function listAuthors(): Author[] {
  return Object.values(authors);
}

export function authorInitials(author: Author): string {
  if (author.initials) return author.initials;
  return author.name
    .split(' ')
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}
