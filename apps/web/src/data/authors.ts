/**
 * Public byline registry.
 *
 * There is exactly one byline: `SleekDrops Editorial Team`, an accountable
 * entity with an about page behind it. What varies per piece is the beat it
 * was written on, which is a tag on that byline rather than a byline of its
 * own. Named desks and "staff" bylines each promise a staffed team, and a
 * masthead whose team does not exist is the failure mode that gets AI-assisted
 * affiliate sites removed - so no invented people, no fictional credentials
 * and no claimed hands-on testing live here.
 *
 * Older D1 posts carry the internal author ids they were published with.
 * `getAuthor` maps any id, legacy or beat, onto the one byline plus the beat
 * tag, so old URLs keep rendering while readers see accurate attribution.
 *
 * The `voice` blocks mirror AUTHORS in apps/agent/src/content/contract.ts,
 * which is what the pipeline's writer and editor prompts are built from. They
 * live here as well so the two registries cannot drift: a beat that publishes
 * on the site but has no voice on the agent side writes in nobody's voice.
 */

/** How a beat writes. Mirrors AuthorVoice in the agent's content contract. */
export interface AuthorVoice {
  /** Sentence-rhythm habits - lengths, openings, where this beat breaks. */
  rhythm: string;
  /** The vocabulary this beat reaches for, and what it will not write. */
  vocabulary: string;
  /** What it cares about - the thing it checks on every product, always. */
  cares: string;
  /** A paragraph in this voice. The writer matches its texture. */
  specimen: string;
}

/** One beat of the editorial team: a voice to write in and a tag on the byline. */
export interface EditorialBeat {
  /** The id stored on a post. Mirrors an AUTHORS id in the agent contract. */
  id: string;
  /** The tag shown beside the byline. Empty on the house voice. */
  label: string;
  /** What this beat covers, and what it checks. Shown on the author card. */
  focus: string;
  voice: AuthorVoice;
}

export interface Author {
  /** Always the editorial team's id - the byline is one entity, on every piece. */
  id: string;
  name: string;
  /** Role shown next to the byline. */
  role: string;
  /** One-line bio for the article footer / author page. */
  bio: string;
  /** Optional initials override; defaults to first letters of name. */
  initials?: string;
  /** Optional public profile link. */
  url?: string;
  /** The beat tag for this piece, when it was written on a specialist beat. */
  beat?: string;
  /** What that beat covers and checks. Set only alongside `beat`. */
  focus?: string;
  /** The beat's house voice, as the pipeline writes to it. */
  voice: AuthorVoice;
}

/** The one accountable byline. Its archive is every post on the site. */
export const EDITORIAL_TEAM = {
  id: 'desk',
  name: 'SleekDrops Editorial Team',
  role: 'Editorial team',
  bio: 'Researches products, prices and published evidence for Australian shoppers. Each recommendation states what we checked and when we have not tested a product ourselves.',
  initials: 'SD',
} as const;

export const beats = {
  desk: {
    id: 'desk',
    label: '',
    focus:
      'Research-led coverage across every category on the site, held to the evidence we can actually show.',
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
  tech: {
    id: 'tech',
    label: 'Tech',
    focus:
      'Audio, computing, mobile and smart-home hardware. Every spec claim is checked against a published measurement.',
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
  home: {
    id: 'home',
    label: 'Home',
    focus:
      'Kitchen, cleaning, furniture and clothing - the things that have to survive daily use. Owner reviews are read for what fails after six months, and the fault rate is reported with its sample size.',
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
  value: {
    id: 'value',
    label: 'Value',
    focus:
      'The money side of a purchase: RRP, running costs, warranty terms and what a policy actually pays out. Prices are stated with the retailer and the day they were checked.',
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
} as const satisfies Record<string, EditorialBeat>;

export type BeatId = keyof typeof beats;

/**
 * The beat a stored author id was written on. Legacy person ids from before
 * the beats existed, and anything unrecognised, resolve to the house voice -
 * the byline a reader sees on those posts is the same either way.
 */
export function resolveBeat(id: string): EditorialBeat {
  return (beats as Record<string, EditorialBeat>)[id] ?? beats.desk;
}

/**
 * The byline for a stored author id: the editorial team, tagged with the beat
 * the piece was written on and carrying that beat's voice.
 */
export function getAuthor(id: string): Author {
  const beat = resolveBeat(id);
  return {
    ...EDITORIAL_TEAM,
    beat: beat.label || undefined,
    focus: beat.label ? beat.focus : undefined,
    voice: beat.voice,
  };
}

/** Every public byline. One entity, so one entry - and one author archive. */
export function listAuthors(): Author[] {
  return [getAuthor(EDITORIAL_TEAM.id)];
}

/** Every beat voice, for the drift check against the agent's registry. */
export function listBeats(): EditorialBeat[] {
  return Object.values(beats);
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
