// The per-channel renderer: one article plus one channel plus a wanted
// placement, in - one post, ready to send, out.
//
// Everything a provider would otherwise be tempted to compose itself lives
// here, for two reasons. The rights rule (never upload someone else's
// photograph) and the disclosure rule (present wherever the endorsement is
// made) are the same on every network, and a rule re-implemented per adapter
// is a rule that is eventually wrong on one of them. And the copy is measured
// rather than trusted - detectSlop() decides whether a generated headline
// ships - which is a ladder no adapter should own a second copy of.
//
// A provider therefore reads the payload and sends it. It never writes copy.
import { createLogger } from '../../lib/log.js';
import { MONETISED_INTENTS } from '../../content/contract.js';
import { expectedOpenGraph, taggedUrl } from '../queue.js';
import { channelSpec, placementFor, type ChannelSpec } from './channels.js';
import {
  AFFILIATE_DISCLOSURE,
  composeCaption,
  FIRST_COMMENT_CUE,
  headlineBudget,
  modelWriter,
  writeHeadline,
  type CopyWriter,
} from './copy.js';
import { resolveImage, type ImageDeps } from './image.js';
import type { DistributableArticle, LinkPlacement, RenderedPayload } from '../types.js';

export { channelSpec, CHANNEL_SPECS, type ChannelSpec } from './channels.js';
export {
  AFFILIATE_DISCLOSURE,
  FIRST_COMMENT_CUE,
  authorshipClaim,
  headlineTrip,
  type CopySource,
  type CopyWriter,
} from './copy.js';
export { resolveImage, SOCIAL_CARD_SIZE, type ImageDeps, type ImageStrategy } from './image.js';

const log = createLogger('distribution');

export interface RenderDeps extends ImageDeps {
  /** The copy call. A stub here is what makes the slop ladder testable. */
  writeCopy?: CopyWriter;
}

/**
 * Whether this piece makes an endorsement the reader is owed a disclosure for.
 *
 * Read off the keyword plan's intent rather than off the presence of affiliate
 * links, because what the caption discloses is the endorsement the post makes,
 * and a commercial-investigation piece is an endorsement whether or not this
 * particular caption names a product.
 */
export function needsDisclosure(article: DistributableArticle): boolean {
  const intent = article.keyword_plan?.intent;
  return typeof intent === 'string' && MONETISED_INTENTS.has(intent);
}

/**
 * Compose one post for one channel.
 *
 * The order of work matters: the image is resolved first because it can take
 * the first-comment placement away, the placement then decides the cue and the
 * UTM tag, and only then is there a budget to write a headline against.
 */
export async function render(
  article: DistributableArticle,
  channel: string | ChannelSpec,
  placement: LinkPlacement,
  deps: RenderDeps = {},
): Promise<RenderedPayload> {
  const spec = typeof channel === 'string' ? channelSpec(channel) : channel;
  const slug = article.slug;
  if (!slug) throw new Error(`article ${article.id} has no slug, so there is nothing to link to`);

  const image = await resolveImage(article, spec.name, placementFor(spec, placement), deps);
  const resolved = image.placement;
  const url = taggedUrl(slug, spec.name, resolved);

  const cue = resolved === 'first_comment' ? FIRST_COMMENT_CUE : null;
  const disclosure = needsDisclosure(article) ? AFFILIATE_DISCLOSURE : null;
  const bodyUrl = resolved === 'in_body' ? url : null;

  const frontmatter = article.frontmatter ?? {};
  const copy = await writeHeadline(
    {
      title: typeof frontmatter.title === 'string' ? frontmatter.title : article.title,
      dek: typeof frontmatter.dek === 'string' ? frontmatter.dek : '',
      keyword: article.keyword_plan?.primaryKeyword ?? '',
      channel: spec,
      budget: headlineBudget(spec, { cue, disclosure, url: bodyUrl }),
    },
    deps.writeCopy ?? modelWriter,
  );

  log.info('rendered social copy', {
    slug,
    channel: spec.name,
    copy: copy.source,
    image: image.strategy,
    placement: resolved,
    placement_changed: resolved !== placement,
  });

  return {
    caption: composeCaption({ headline: copy.headline, cue, disclosure, url: bodyUrl }),
    url,
    placement: resolved,
    commentText: url,
    imageUrl: image.imageUrl,
    imageSource: image.imageSource,
    expected: expectedOpenGraph(article),
  };
}
