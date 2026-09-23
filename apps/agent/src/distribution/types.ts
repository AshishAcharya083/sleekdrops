// The distribution contract: what a queued item is, and what a social network
// has to implement to receive one.
//
// Nothing in this file names a network. Adding a second one is one new file
// that implements `SocialProvider` and registers itself (providers.ts) - no
// migration, no change to the queue, no change to the worker. The interface is
// modelled on the Postiz provider contract (authenticate / refreshToken / post
// / analytics) because that shape has already been proven against a dozen
// networks; `fetchInsights` is the local name for its analytics call, and it
// returns the three aggregate counters distribution_metrics stores.

/**
 * Where an article's hero image came from. The distinction is a rights
 * boundary, not bookkeeping: uploading an image natively grants the network a
 * sublicensable licence in it, which we can only give for an image we made. A
 * 'found' hero is someone else's photograph, vetted for watermarks and quality
 * and nothing else.
 */
export type HeroImageSource = 'generated' | 'found' | 'operator';

/**
 * Where the destination link goes. 'first_comment' keeps the caption free of
 * an outbound link at the cost of the rich link card; 'in_body' earns the card
 * and spends one unit of whatever monthly link budget the network imposes.
 * Both are first-class - the default is a setting, and each row carries the
 * placement it was rendered for.
 */
export type LinkPlacement = 'first_comment' | 'in_body';

export const LINK_PLACEMENTS: readonly LinkPlacement[] = ['first_comment', 'in_body'];

export function isLinkPlacement(value: unknown): value is LinkPlacement {
  return typeof value === 'string' && (LINK_PLACEMENTS as readonly string[]).includes(value);
}

/**
 * Queue item state.
 *
 * 'pending' covers both "waiting for the site rebuild" and "waiting out a
 * retry backoff" - the difference is `scheduled_at`, not another state.
 * 'failed' is terminal: retries are spent, or the readiness gate never opened.
 * 'held' is for an item a provider's own ladder parked deliberately (no image
 * it may upload and no link budget left, say); the worker never claims one, so
 * it sits in the admin panel until an operator or that provider moves it.
 */
export type DistributionStatus = 'pending' | 'posting' | 'posted' | 'failed' | 'held';

export type ChannelStatus = 'active' | 'disabled' | 'needs_reauth';

/** A connected account, as the database holds it. Never a token value. */
export interface ChannelConnectionRow {
  id: string;
  provider: string;
  external_account_id: string;
  display_name: string | null;
  /** Name of the secret holding the access token - resolved at post time. */
  token_ref: string;
  refresh_token_ref: string | null;
  expires_at: string | null;
  status: ChannelStatus;
  created_at: string;
  updated_at: string;
}

/**
 * The post, rendered. Written once, at enqueue, so that re-entering the
 * publish stage cannot quietly change what an item that is already waiting
 * will say.
 */
export interface RenderedPayload {
  /** The post body exactly as it should be sent. */
  caption: string;
  /** The destination, UTM-tagged for the placement this item was rendered for. */
  url: string;
  /**
   * The placement this copy was actually composed for, which is not always the
   * one that was asked for: a renderer that could not produce an image it is
   * allowed to upload resolves to 'in_body', where the link preview carries
   * the post instead. Everything else here - the cue, the tagged url - follows
   * from this value rather than from the caller's request.
   */
  placement: LinkPlacement;
  /**
   * What to post as the first comment when `placement` is 'first_comment'. A
   * provider with no comment concept ignores it and carries `url` in the body.
   */
  commentText: string;
  /**
   * An image this account may upload natively, or null when there is none it
   * may. Null is not "no image" - read `imageSource` for why.
   */
  imageUrl: string | null;
  /** Provenance of the article's hero, whether or not it may be uploaded. */
  imageSource: HeroImageSource | null;
  /** What the live page must serve before this item may be handed to a provider. */
  expected: {
    ogTitle: string;
    ogImage: string | null;
  };
}

/** One queue row, in the shape the worker and the providers read. */
export interface DistributionItem {
  id: string;
  articleId: string | null;
  slug: string;
  channelConnectionId: string;
  provider: string;
  payload: RenderedPayload;
  placement: LinkPlacement;
  scheduledAt: string;
  status: DistributionStatus;
  attempts: number;
  lastError: string | null;
  remotePostId: string | null;
  readinessStartedAt: string | null;
  postedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A `distribution_queue` row as `pg` returns it. */
export interface DistributionQueueRow {
  id: string;
  article_id: string | null;
  slug: string;
  channel_connection_id: string;
  provider: string;
  payload: RenderedPayload;
  placement: string;
  scheduled_at: string;
  status: DistributionStatus;
  attempts: number;
  last_error: string | null;
  remote_post_id: string | null;
  readiness_started_at: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  posted_at: string | null;
  created_at: string;
  updated_at: string;
}

export function toDistributionItem(row: DistributionQueueRow): DistributionItem {
  return {
    id: row.id,
    articleId: row.article_id,
    slug: row.slug,
    channelConnectionId: row.channel_connection_id,
    provider: row.provider,
    payload: row.payload,
    // A placement written before a vocabulary change (or by hand) reads as the
    // safe one rather than as a value no provider knows what to do with.
    placement: isLinkPlacement(row.placement) ? row.placement : 'first_comment',
    scheduledAt: row.scheduled_at,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    remotePostId: row.remote_post_id,
    readinessStartedAt: row.readiness_started_at,
    postedAt: row.posted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * What an authentication or a refresh gives back. `expiresIn` is seconds from
 * now rather than a timestamp because that is what every OAuth response
 * carries; the caller turns it into `channel_connections.expires_at`.
 */
export interface AuthTokenDetails {
  externalAccountId: string;
  displayName: string;
  accessToken: string;
  refreshToken?: string;
  /** Null for a token the provider does not expire. */
  expiresIn: number | null;
}

/** What an OAuth callback hands the provider. Providers ignore what they don't use. */
export interface AuthenticateParams {
  code?: string;
  codeVerifier?: string;
  redirectUri?: string;
  /** Long-lived credentials pasted by an operator (a Page token, an app password). */
  token?: string;
}

/** The credential and account a single call runs as. Never logged, never stored. */
export interface ProviderCredentials {
  accessToken: string;
  externalAccountId: string;
}

export interface ProviderPostContext extends ProviderCredentials {
  item: DistributionItem;
}

export interface ProviderInsightsContext extends ProviderCredentials {
  remotePostId: string;
}

/** What the network said when the post landed. */
export interface PostReceipt {
  remotePostId: string;
  /**
   * True when the post went out in a reduced form the caller should know
   * about - a first-comment link that had to be appended to the caption
   * instead, say. The item is still 'posted'; `note` says what happened.
   */
  degraded?: boolean;
  note?: string;
}

/** One aggregate reading. Null is "the provider did not report it", not zero. */
export interface InsightSnapshot {
  impressions: number | null;
  clicks: number | null;
  reactions: number | null;
  fetchedAt: string;
}

/**
 * One social network. Four calls, and nothing above them knows which network
 * it is talking to.
 *
 * `post` is the only one the worker drives. The other three exist so that a
 * connection can be established and kept alive (authenticate, refreshToken)
 * and so that what a post actually did can be read back (fetchInsights)
 * without any of that leaking network-specific shapes into the queue.
 *
 * Failures are thrown. A thrown error spends one attempt and is retried with
 * backoff; a provider that knows an error is permanent (a rejected token, a
 * deleted account) throws a `PermanentProviderError` so the item fails now
 * rather than four backoffs from now.
 */
export interface SocialProvider {
  /** The value `distribution_queue.provider` and `channel_connections.provider` carry. */
  readonly name: string;
  authenticate(params: AuthenticateParams): Promise<AuthTokenDetails>;
  refreshToken(refreshToken: string): Promise<AuthTokenDetails>;
  post(context: ProviderPostContext): Promise<PostReceipt>;
  fetchInsights(context: ProviderInsightsContext): Promise<InsightSnapshot>;
}

/**
 * The network will not accept this call however many times we repeat it.
 * Retrying a revoked token only delays the moment an operator is told.
 */
export class PermanentProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentProviderError';
  }
}

/**
 * The article fields a payload is rendered from. Declared structurally rather
 * than as a Pick of ArticleRow: ArticleRow already names HeroImageSource from
 * here, and a payload renderer has no business seeing a dossier or a draft.
 */
export interface DistributableArticle {
  id: string;
  slug: string | null;
  title: string;
  frontmatter: Record<string, unknown> | null;
  hero_image_url: string | null;
  hero_image_source: HeroImageSource | null;
  /**
   * The keyword stage's read of what the search intent is. Present because the
   * affiliate disclosure is owed on the piece that makes an endorsement and
   * only on that one, and `MONETISED_INTENTS` is where that is decided.
   * Optional: an article outlined before the keyword stage existed carries no
   * plan, and no plan means no disclosure rather than a crash.
   */
  keyword_plan?: { intent: string; primaryKeyword?: string } | null;
}
