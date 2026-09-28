// Which image, if any, this post may carry - and what to do when the answer is
// none.
//
// The pipeline's first image strategy is web search, so the typical hero is a
// third party's photograph, vetted for watermarks and quality and nothing
// else. Uploading that natively to a network is a rights problem rather than a
// taste one: the terms take a sublicensable licence in what is uploaded, and
// that is not ours to grant in a photo we did not make. Displaying it on our
// own page under fair dealing is the risk the site already runs; granting a
// licence in it is a step further and this module never takes it.
//
// So the ladder is:
//   1. hero we generated  -> upload it as it is
//   2. anything else      -> render a fresh social card and upload that
//   3. the card failed    -> no image, and the placement resolves to 'in_body'
//      so the link preview carries the post instead of nothing carrying it
import { createLogger } from '../../lib/log.js';
import { generateImage } from '../../llm/genai.js';
import { gcsConfigured, uploadPublicImage } from '../../tools/gcs.js';
import type { DistributableArticle, HeroImageSource, LinkPlacement } from '../types.js';

const log = createLogger('distribution');

/**
 * The card's target size. 1200x630 is the link-card size every network crops
 * to; the image model takes a named aspect ratio rather than pixels and 16:9
 * is its nearest, so the size is stated in the prompt and the result is
 * cropped by the network to the same frame a link preview would have used.
 */
export const SOCIAL_CARD_SIZE = { width: 1200, height: 630 } as const;

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** One generated image. Injected so a test never reaches an image model. */
export type CardRenderer = (prompt: string) => Promise<{ data: Buffer; mimeType: string }>;

/** One upload to our own bucket, returning the public URL. */
export type CardUploader = (
  objectName: string,
  data: Buffer,
  contentType: string,
) => Promise<string>;

export interface ImageDeps {
  renderCard?: CardRenderer;
  uploadCard?: CardUploader;
}

/** Where the image we are about to post came from. */
export type ImageStrategy = 'hero' | 'card' | 'none';

export interface ResolvedImage {
  /** Only ever an image we made: the hero we generated, or the card we just did. */
  imageUrl: string | null;
  /**
   * Provenance of the article's own hero, whether or not it could be used. A
   * 'found' hero beside a non-null `imageUrl` is the card branch having done
   * its job, and it is what lets the panel say why a card was needed.
   */
  imageSource: HeroImageSource | null;
  strategy: ImageStrategy;
  /** The placement that is still available given what we ended up with. */
  placement: LinkPlacement;
}

/** The hero as frontmatter carries it - the same field the live page serves. */
function heroImage(article: DistributableArticle): string | null {
  const frontmatter = article.frontmatter ?? {};
  return typeof frontmatter.heroImage === 'string' ? frontmatter.heroImage : null;
}

function cardPrompt(article: DistributableArticle): string {
  const frontmatter = article.frontmatter ?? {};
  const title = typeof frontmatter.title === 'string' ? frontmatter.title : article.title;
  const dek = typeof frontmatter.dek === 'string' ? frontmatter.dek : '';
  return `Editorial social card illustrating an article titled "${title}".
${dek ? `The article is about: ${dek}` : ''}
Composition for a ${SOCIAL_CARD_SIZE.width}x${SOCIAL_CARD_SIZE.height} link card: wide, single clear subject, generous empty space, calm studio lighting, plain uncluttered background.
Absolutely NO text, NO letters, NO numbers, NO logos, NO watermarks, NO recognisable faces.`;
}

/**
 * Resolve the image and the placement together, because one decides the other:
 * a post with no image it may upload is a post that needs the link preview,
 * and the link preview only exists when the link is in the body.
 */
export async function resolveImage(
  article: DistributableArticle,
  channel: string,
  placement: LinkPlacement,
  deps: ImageDeps = {},
): Promise<ResolvedImage> {
  const hero = heroImage(article);
  const imageSource = hero ? article.hero_image_source : null;
  if (hero && imageSource === 'generated') {
    return { imageUrl: hero, imageSource, strategy: 'hero', placement };
  }

  const slug = article.slug ?? article.id;
  // Nothing to upload to: skip the generation rather than pay for an image
  // that has nowhere to live.
  if (!deps.uploadCard && !gcsConfigured()) {
    log.warn('no social card rendered; GCS is not configured', { slug, channel });
    return { imageUrl: null, imageSource, strategy: 'none', placement: 'in_body' };
  }

  const render = deps.renderCard ?? ((prompt: string) => generateImage(prompt));
  const upload = deps.uploadCard ?? uploadPublicImage;
  try {
    const card = await render(cardPrompt(article));
    const url = await upload(
      `social/${slug}-${channel}.${EXT[card.mimeType] ?? 'png'}`,
      card.data,
      card.mimeType,
    );
    return { imageUrl: url, imageSource, strategy: 'card', placement };
  } catch (err) {
    // Never a reason not to post: the body link still earns a preview card
    // built from the page's own Open Graph tags.
    log.warn('social card failed; falling back to a body link', {
      slug,
      channel,
      hero_image_source: imageSource,
      error: err instanceof Error ? err.message : String(err),
    });
    return { imageUrl: null, imageSource, strategy: 'none', placement: 'in_body' };
  }
}
