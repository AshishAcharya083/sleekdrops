// What a post says and what it carries, decided without a model and without a
// network.
//
// Every rung of both ladders is reachable from here: the copy writer is a stub
// whose replies the test chooses, and the card renderer is a stub that either
// returns bytes or throws. That is the only way the interesting cases - a
// second slop trip, a rights-unsafe hero, an image model that is down - are
// testable at all, because each of them is a thing that happens to one post in
// a hundred and none of them can be provoked live.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = 'postgres://unused:unused@127.0.0.1:1/unreachable';
process.env.SITE_URL = 'https://sleekdrops.com';

const { render, needsDisclosure, AFFILIATE_DISCLOSURE, FIRST_COMMENT_CUE, channelSpec } =
  await import('./index.js');
const { clamp, fallbackHeadline, headlineTrip, HEADLINE_MAX_CHARS } = await import('./copy.js');
const { detectSlop, houseBlock } = await import('../../content/slop.js');

import type { CopyWriter } from './copy.js';
import type { CardRenderer, CardUploader } from './image.js';
import type { DistributableArticle } from '../types.js';

/** Copy the scan passes: specific, priced, and nothing on the banned lists. */
const CLEAN = 'The $549 Sony XM6 leads on the 7:12; the $399 Bose is the one to buy under $400.';
const CLEANER = 'Four weeks of listings, and the $549 Sony XM6 still beats the $399 Bose.';
/** Copy the scan trips on: six pieces of banned vocabulary in one line. */
const SLOPPY = 'Unlock a seamless, robust audio landscape as we delve into the myriad options.';
/** Copy the scan likes and the site may never post: nobody here has used these. */
const HANDS_ON = 'We tested these headphones for three weeks on the 7:12 and the noise floor held.';

const DEK =
  'The noise floor drops 12 dB on the 7:12, and the $399 Bose is the one to buy under $400. That is the whole finding.';
const HERO = 'https://storage.googleapis.com/images/heroes/quiet-commutes.png';

function article(fields: Partial<DistributableArticle> = {}): DistributableArticle {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    slug: 'quiet-commutes',
    title: 'The headphones for a quiet commute',
    frontmatter: {
      title: 'The headphones for a quiet commute',
      dek: DEK,
      heroImage: HERO,
    },
    hero_image_url: null,
    hero_image_source: 'generated',
    keyword_plan: { intent: 'Commercial Investigation', primaryKeyword: 'best noise cancelling headphones' },
    ...fields,
  };
}

/** A copy call that replies with the given lines in order, repeating the last. */
function writer(...replies: string[]): CopyWriter & { calls: Array<string | undefined> } {
  const calls: Array<string | undefined> = [];
  const stub = async (_request: unknown, complaint?: string): Promise<string> => {
    calls.push(complaint);
    return replies[Math.min(calls.length - 1, replies.length - 1)];
  };
  return Object.assign(stub as CopyWriter, { calls });
}

/** A card renderer that succeeds, and the uploads it produced. */
function cardStub(): { renderCard: CardRenderer; uploadCard: CardUploader; keys: string[] } {
  const keys: string[] = [];
  return {
    renderCard: async () => ({ data: Buffer.from('card-bytes'), mimeType: 'image/png' }),
    uploadCard: async (objectName) => {
      keys.push(objectName);
      return `https://storage.googleapis.com/images/${objectName}`;
    },
    keys,
  };
}

const failingCard: CardRenderer = async () => {
  throw new Error('image model returned no image data');
};

const deps = (over: Record<string, unknown> = {}) => ({
  writeCopy: writer(CLEAN),
  ...cardStub(),
  ...over,
});

// ── Composition ────────────────────────────────────────────────────────────

test('the caption composes in one order: headline, cue, disclosure', async () => {
  const payload = await render(article(), 'facebook', 'first_comment', deps());
  const [headline, cue, disclosure, ...rest] = payload.caption.split('\n\n');

  assert.equal(headline, CLEAN);
  assert.equal(cue, FIRST_COMMENT_CUE);
  assert.equal(disclosure, AFFILIATE_DISCLOSURE);
  assert.deepEqual(rest, [], 'a first-comment caption carries no link of its own');
  assert.equal(payload.placement, 'first_comment');
  assert.equal(payload.commentText, payload.url);
});

test('the fixtures are the registered house text, not a second wording', () => {
  // Registered rather than typed here, so the repetition metrics skip them and
  // one place decides what the site says. Mirrors HOUSE_BLOCKS for the body.
  assert.equal(AFFILIATE_DISCLOSURE, houseBlock('social-disclosure').text);
  assert.equal(FIRST_COMMENT_CUE, houseBlock('link-placement-cue').text);
});

test('the cue appears only when the link really is in the first comment', async () => {
  const commented = await render(article(), 'facebook', 'first_comment', deps());
  assert.ok(commented.caption.includes(FIRST_COMMENT_CUE));
  assert.ok(!commented.caption.includes('https://'), 'no link in a first-comment caption');

  const inBody = await render(article(), 'facebook', 'in_body', deps());
  assert.ok(!inBody.caption.includes(FIRST_COMMENT_CUE), 'nothing is in a first comment here');
  assert.ok(inBody.caption.endsWith(inBody.url), 'the link is the last thing in the caption');
});

test('the destination is tagged with the placement that was actually used', async () => {
  const commented = await render(article(), 'facebook', 'first_comment', deps());
  assert.equal(new URL(commented.url).searchParams.get('utm_content'), 'first_comment');
  assert.equal(new URL(commented.url).searchParams.get('utm_source'), 'facebook');

  const inBody = await render(article(), 'facebook', 'in_body', deps());
  assert.equal(new URL(inBody.url).searchParams.get('utm_content'), 'in_body');
});

// ── The affiliate disclosure ───────────────────────────────────────────────

test('the disclosure rides on the monetised intents and on nothing else', async () => {
  for (const intent of ['Commercial Investigation', 'Transactional']) {
    const payload = await render(
      article({ keyword_plan: { intent } }),
      'facebook',
      'first_comment',
      deps(),
    );
    assert.ok(payload.caption.includes(AFFILIATE_DISCLOSURE), `${intent} earns, so it discloses`);
  }

  for (const plan of [{ intent: 'Informational' }, { intent: 'Navigational' }, null]) {
    const payload = await render(
      article({ keyword_plan: plan }),
      'facebook',
      'first_comment',
      deps(),
    );
    assert.ok(
      !payload.caption.includes(AFFILIATE_DISCLOSURE),
      `${plan?.intent ?? 'no keyword plan'} makes no endorsement to disclose`,
    );
  }

  // An article written before the keyword stage existed carries no plan at all.
  assert.equal(needsDisclosure(article({ keyword_plan: undefined })), false);
});

// ── The slop ladder ────────────────────────────────────────────────────────

test('copy the scan trips on is regenerated once, with the hits handed back', async () => {
  const writeCopy = writer(SLOPPY, CLEANER);
  const payload = await render(article(), 'facebook', 'first_comment', deps({ writeCopy }));

  assert.ok(payload.caption.startsWith(CLEANER), 'the second attempt is what ships');
  assert.equal(writeCopy.calls.length, 2, 'exactly one regeneration');
  assert.equal(writeCopy.calls[0], undefined, 'the first attempt has nothing to complain about');
  assert.match(String(writeCopy.calls[1]), /delve/, 'the regeneration is told what tripped');
});

test('a second trip falls back to the dek, deterministically', async () => {
  const writeCopy = writer(SLOPPY);
  const payload = await render(article(), 'facebook', 'first_comment', deps({ writeCopy }));

  assert.equal(writeCopy.calls.length, 2, 'the model gets one regeneration, never two');
  assert.ok(
    payload.caption.startsWith('The noise floor drops 12 dB on the 7:12, and the $399 Bose'),
    `fell back to something else: ${payload.caption}`,
  );
  assert.ok(!payload.caption.includes('delve'), 'nothing the scan rejected reaches the post');

  const again = await render(article(), 'facebook', 'first_comment', deps({ writeCopy: writer(SLOPPY) }));
  assert.equal(again.caption, payload.caption, 'the fallback is derived, not written');
});

test('copy that claims someone here used the product never ships', async () => {
  // The scan has no opinion on this line - it is specific, varied and clean -
  // so nothing but the authorship check stands between it and a public Page.
  assert.equal(detectSlop(HANDS_ON).score, 100);
  assert.ok(headlineTrip(HANDS_ON), 'the renderer rejects it anyway');

  const payload = await render(
    article(),
    'facebook',
    'first_comment',
    deps({ writeCopy: writer(HANDS_ON) }),
  );
  assert.ok(!payload.caption.includes('We tested'), payload.caption);
  assert.ok(payload.caption.startsWith('The noise floor drops 12 dB'), 'the dek carried it');
});

test('a copy call that fails outright still produces a post', async () => {
  const writeCopy: CopyWriter = async () => {
    throw new Error('Gemini not configured');
  };
  const payload = await render(article(), 'facebook', 'first_comment', deps({ writeCopy }));
  assert.ok(payload.caption.startsWith('The noise floor drops 12 dB'));
  assert.ok(payload.caption.includes(FIRST_COMMENT_CUE));
});

test('a link the model wrote itself never survives into the caption', async () => {
  // Where the link goes is decided above the copy call. A first-comment post
  // whose caption smuggles a URL in is the exact thing the placement exists to
  // avoid, and nothing downstream would notice.
  const smuggled = `${CLEAN} Read it here: https://sleekdrops.com/blog/quiet-commutes`;
  const payload = await render(
    article(),
    'facebook',
    'first_comment',
    deps({ writeCopy: writer(smuggled) }),
  );

  assert.ok(!payload.caption.includes('https://'), payload.caption);
  assert.ok(payload.caption.startsWith(CLEAN));
  assert.ok(!payload.caption.includes('Read it here:'), 'the dangling lead-in goes with it');
});

// ── Image provenance ───────────────────────────────────────────────────────

test('a hero we generated is posted as it is', async () => {
  const card = cardStub();
  const payload = await render(article(), 'facebook', 'first_comment', {
    writeCopy: writer(CLEAN),
    ...card,
  });

  assert.equal(payload.imageUrl, HERO);
  assert.equal(payload.imageSource, 'generated');
  assert.equal(payload.placement, 'first_comment', 'an image we may upload keeps the placement');
  assert.deepEqual(card.keys, [], 'no card is rendered when the hero is already ours');
});

test('a hero we did not make is replaced by a card, never uploaded', async () => {
  for (const source of ['found', 'operator'] as const) {
    const card = cardStub();
    const payload = await render(article({ hero_image_source: source }), 'facebook', 'first_comment', {
      writeCopy: writer(CLEAN),
      ...card,
    });

    assert.notEqual(payload.imageUrl, HERO, `a ${source} hero is not ours to sublicense`);
    assert.equal(payload.imageUrl, 'https://storage.googleapis.com/images/social/quiet-commutes-facebook.png');
    assert.deepEqual(card.keys, ['social/quiet-commutes-facebook.png']);
    assert.equal(payload.imageSource, source, 'the provenance still travels, for the panel');
    assert.equal(payload.placement, 'first_comment');
    assert.equal(
      payload.expected.ogImage,
      HERO,
      'the readiness gate still waits for the page, which serves the hero',
    );
  }
});

test('no safe image means no image, and the link moves into the body', async () => {
  const payload = await render(article({ hero_image_source: 'found' }), 'facebook', 'first_comment', {
    writeCopy: writer(CLEAN),
    renderCard: failingCard,
    uploadCard: async () => 'never reached',
  });

  assert.equal(payload.imageUrl, null);
  assert.equal(payload.imageSource, 'found');
  assert.equal(payload.placement, 'in_body', 'the link preview has to carry the post instead');
  assert.ok(!payload.caption.includes(FIRST_COMMENT_CUE), 'no cue to a comment that is not coming');
  assert.ok(payload.caption.endsWith(payload.url));
  assert.equal(new URL(payload.url).searchParams.get('utm_content'), 'in_body');
});

test('an article with no hero at all still gets a card', async () => {
  const card = cardStub();
  const payload = await render(
    article({ frontmatter: { title: 'No hero here', dek: DEK }, hero_image_source: null }),
    'facebook',
    'first_comment',
    { writeCopy: writer(CLEAN), ...card },
  );

  assert.equal(payload.imageSource, null, 'there is no hero to report a provenance for');
  assert.equal(payload.imageUrl, 'https://storage.googleapis.com/images/social/quiet-commutes-facebook.png');
  assert.equal(payload.expected.ogImage, null, 'nothing to wait for on the live page');
});

// ── Per channel ────────────────────────────────────────────────────────────

test('copy is written per channel, so a 300-character network needs no rework', async () => {
  const long = `${CLEAN} ${CLEANER} ${CLEAN} ${CLEANER}`;

  const bluesky = await render(article(), 'bluesky', 'first_comment', deps({ writeCopy: writer(long) }));
  assert.ok(bluesky.caption.length <= channelSpec('bluesky').captionLimit, bluesky.caption);
  assert.ok(bluesky.caption.includes(AFFILIATE_DISCLOSURE), 'the fixtures are never what gets cut');
  assert.ok(bluesky.caption.includes(FIRST_COMMENT_CUE));
  assert.ok(bluesky.caption.startsWith(CLEAN.slice(0, 40)));

  const facebook = await render(article(), 'facebook', 'first_comment', deps({ writeCopy: writer(long) }));
  assert.ok(
    facebook.caption.length > bluesky.caption.length,
    'the same copy is not truncated where it does not have to be',
  );
  assert.equal(
    new URL(facebook.url).searchParams.get('utm_source'),
    'facebook',
    'each channel gets its own tagged destination',
  );
});

test('an unregistered channel is treated as strict and comment-less', async () => {
  const spec = channelSpec('pinterest');
  assert.equal(spec.captionLimit, 300);
  assert.equal(spec.supportsFirstComment, false);

  const payload = await render(article(), 'pinterest', 'first_comment', deps());
  assert.equal(payload.placement, 'in_body', 'a cue to a comment the network has not got is a dead end');
  assert.ok(payload.caption.endsWith(payload.url));
});

// ── The pure pieces ────────────────────────────────────────────────────────

test('a headline is cut at a word boundary, never mid-word', () => {
  assert.equal(clamp('short enough', 40), 'short enough');
  const cut = clamp('The $549 Sony XM6 leads on the 7:12 train', 20);
  assert.ok(cut.length <= 20, cut);
  assert.ok(cut.endsWith('…'));
  assert.ok(!cut.includes('  '));
  assert.equal(clamp('anything', 0), '');
});

test('the fallback is the dek down to one sentence, then the title', () => {
  assert.equal(
    fallbackHeadline({ title: 'unused', dek: 'One sentence. And a second one.' }, HEADLINE_MAX_CHARS),
    'One sentence.',
  );
  assert.equal(
    fallbackHeadline({ title: 'The headphones for a quiet commute', dek: '' }, HEADLINE_MAX_CHARS),
    'The headphones for a quiet commute',
  );
});

test('a decimal inside a sentence is not read as the end of it', () => {
  // The rung nothing downstream checks, so a price cut at its decimal point
  // would be posted understating what the thing costs - the misreading the
  // price-currency house block exists to keep the site out of.
  assert.equal(
    fallbackHeadline(
      { title: 'unused', dek: 'The XM6 is $1,299.99 at 2.4 GHz today. Buy it now.' },
      HEADLINE_MAX_CHARS,
    ),
    'The XM6 is $1,299.99 at 2.4 GHz today.',
  );
  assert.equal(
    fallbackHeadline({ title: 'unused', dek: 'A dek with no terminator at all' }, HEADLINE_MAX_CHARS),
    'A dek with no terminator at all',
  );
});

test('a title that claims someone here used the product is no fallback either', () => {
  // A title is guarded by prompt instruction only, and this rung posts without
  // a further check, so it is measured like everything else on the way out.
  assert.equal(
    fallbackHeadline(
      { title: 'We tested every pair on the 7:12', dek: `${HANDS_ON} ${CLEAN}` },
      HEADLINE_MAX_CHARS,
    ),
    CLEAN,
    'the next clean dek sentence carried it',
  );
  assert.equal(
    fallbackHeadline({ title: 'Our testers on the 7:12', dek: HANDS_ON }, HEADLINE_MAX_CHARS),
    '',
    'nothing clean to say is better than a claim nobody here can make',
  );
});

test('a caption with no clean headline still carries its fixtures', async () => {
  const payload = await render(
    article({
      title: 'We tested every pair on the 7:12',
      frontmatter: { title: 'We tested every pair on the 7:12', dek: HANDS_ON, heroImage: HERO },
    }),
    'facebook',
    'first_comment',
    deps({ writeCopy: writer(HANDS_ON) }),
  );

  assert.equal(payload.caption, `${FIRST_COMMENT_CUE}\n\n${AFFILIATE_DISCLOSURE}`);
});
