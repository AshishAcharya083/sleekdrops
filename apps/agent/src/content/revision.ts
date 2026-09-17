// What a requalification actually changed, and whether that earns a fresh date.
//
// A requalified page comes out at the address it went in at, so the only thing
// telling a reader they are looking at a revision is the date on it. Google is
// explicit about both halves of that: an article that has been substantially
// changed should carry a fresh date, and a page freshened without significant
// new information is a negative signal - the helpful-content self-assessment
// asks, in as many words, whether we are changing dates to make pages seem
// fresh. A pipeline that stamps today onto every regeneration is exactly the
// pattern being warned about, and this platform regenerates by the button.
//
// So the stamp is earned rather than automatic: the rebuild is compared with
// the page it replaces, and where it differs the date is accompanied by a line
// naming what moved, in the page's own product names. That the line could not
// have been written about any other page is the point - one fixed sentence
// repeated across the corpus reads as scale, not as editorial care, which is
// the same judgement that put the corpus in front of an ad reviewer.
import { goLinkSearchTerms, goSlugsIn } from './contract.js';

/** A recommendation the rebuild ships, as the assembler resolved it. */
export interface RevisionPick {
  name: string;
  goSlug: string;
}

export interface RevisionInput {
  /** The body of the page as it is live right now. */
  liveBody: string;
  /** The rebuilt body, after healing and stripping. */
  body: string;
  /** The rebuild's resolved picks - the best names it has for its own slugs. */
  picks: readonly RevisionPick[];
  /** How many sources the rebuild cites. */
  sourceCount: number;
}

export interface Revision {
  /** True when the rebuild changed the page enough to earn a fresh date. */
  substantial: boolean;
  /** What changed, for the reader. Null when nothing did. */
  note: string | null;
  /** Products the rebuild recommends that the live page did not, and the reverse. */
  added: string[];
  dropped: string[];
  kept: string[];
}

/** Longest a product name may run inside the note, so one anchor cannot flood it. */
const MAX_NAME = 48;
/** Products named before the note starts counting instead. */
const MAX_NAMED = 3;
/** Matches `updateNote`'s schema bound - past it the note falls back to its first sentence. */
const MAX_NOTE = 300;

/**
 * The page's prose, as a reader would compare two printouts of it: link
 * destinations, markdown and casing removed, words kept. Two rebuilds that
 * differ only in which /go/ slug a sentence points at compare equal here - the
 * pick comparison is what catches that, and it catches it by name.
 */
function comparableProse(body: string): string {
  return body
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function titleCase(text: string): string {
  return text.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function shorten(name: string): string {
  return name.length > MAX_NAME ? `${name.slice(0, MAX_NAME).trimEnd()}…` : name;
}

/**
 * The best name each /go/ slug in a body has, keyed by slug.
 *
 * A resolved pick names its product exactly, so it wins where there is one -
 * which is the rebuild's side of the comparison. The live page has no dossier
 * behind it any more, so its names come from the words the writer put on the
 * link, and failing those from the slug, which is a product name kebab-cased.
 */
function namesBySlug(body: string, picks: readonly RevisionPick[] = []): Map<string, string> {
  const byPick = new Map(
    picks.flatMap((pick) => (pick.name.trim() ? [[pick.goSlug, pick.name.trim()] as const] : [])),
  );
  const terms = goLinkSearchTerms(body);
  const names = new Map<string, string>();
  for (const slug of goSlugsIn(body)) {
    const anchor = terms.get(slug);
    const named =
      byPick.get(slug) ??
      (anchor?.source === 'anchor text'
        ? anchor.term
        : titleCase(anchor?.term ?? slug.split('-').join(' ')));
    names.set(slug, shorten(named));
  }
  return names;
}

/** "A", "A and B", "A, B and C", then "A, B, C and 2 more". */
function list(names: readonly string[]): string {
  const shown = names.slice(0, MAX_NAMED);
  const rest = names.length - shown.length;
  if (rest > 0) return `${shown.join(', ')} and ${rest} more`;
  if (shown.length === 1) return shown[0];
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

/** The half of the note about the recommendations - the half only this page could carry. */
function picksSentence(added: string[], dropped: string[], kept: string[]): string {
  if (added.length === 1 && dropped.length === 1) {
    return `Swapped the ${dropped[0]} for the ${added[0]}.`;
  }
  if (added.length > 0 && dropped.length > 0) {
    return `Dropped ${list(dropped)}; added ${list(added)}.`;
  }
  if (added.length > 0) return `Added ${list(added)}.`;
  if (dropped.length > 0) return `Dropped ${list(dropped)}.`;
  if (kept.length > 0) return `The picks are unchanged: ${list(kept)}.`;
  return '';
}

/**
 * Compare a rebuild with the live page it replaces.
 *
 * Substantial means the reader is being shown something different: the prose
 * was rewritten, or the recommendations moved. Anything less leaves the page's
 * date exactly as it was, which is the whole reason this function exists.
 */
export function describeRevision(input: RevisionInput): Revision {
  const live = namesBySlug(input.liveBody);
  const next = namesBySlug(input.body, input.picks);

  const added = [...next].filter(([slug]) => !live.has(slug)).map(([, name]) => name);
  const dropped = [...live].filter(([slug]) => !next.has(slug)).map(([, name]) => name);
  const kept = [...next].filter(([slug]) => live.has(slug)).map(([, name]) => name);

  const rewritten = comparableProse(input.body) !== comparableProse(input.liveBody);
  const substantial = rewritten || added.length > 0 || dropped.length > 0;
  if (!substantial) return { substantial, note: null, added, dropped, kept };

  const against =
    input.sourceCount > 0
      ? ` against ${input.sourceCount} ${input.sourceCount === 1 ? 'source' : 'sources'}`
      : '';
  const opening = rewritten
    ? `Rewritten from new research${against}.`
    : `Rechecked${against}.`;
  const note = [opening, picksSentence(added, dropped, kept)].filter(Boolean).join(' ');
  return {
    substantial,
    // A name long enough to burst the schema bound costs the picks sentence
    // rather than the article: assembly validates this field, and failing a
    // whole run over a note would be the wrong trade every time.
    note: note.length <= MAX_NOTE ? note : opening,
    added,
    dropped,
    kept,
  };
}
