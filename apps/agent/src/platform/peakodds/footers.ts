// The responsible-gambling footers the assembler appends to every PeakOdds
// article. The model never writes these: they are data, appended by code, so a
// draft cannot drop, soften or misquote a helpline.
//
// Every contact below was checked against the service's own site on the date
// in `verified`. Re-check them before changing a footer - a wrong helpline
// number on a gambling page is worse than none.

export interface Helpline {
  name: string;
  /** The number as the service itself prints it. */
  phone: string;
  url: string;
  /** The official page the number was read from. */
  source: string;
  verified: string;
}

export const GAMBLING_HELP_ONLINE: Helpline = {
  name: 'Gambling Help Online',
  phone: '1800 858 858',
  url: 'https://www.gamblinghelponline.org.au',
  source: 'https://www.gamblinghelponline.org.au/',
  verified: '2026-10-02',
};

export const BETSTOP: Helpline = {
  name: 'BetStop - the National Self-Exclusion Register',
  phone: '',
  url: 'https://www.betstop.gov.au',
  source: 'https://www.betstop.gov.au/',
  verified: '2026-10-02',
};

export const GAMCARE: Helpline = {
  name: 'GamCare (National Gambling Helpline, UK)',
  phone: '0808 8020 133',
  url: 'https://www.gamcare.org.uk',
  source: 'https://www.gamcare.org.uk/get-support/talk-to-us-now/',
  verified: '2026-10-02',
};

/**
 * Since January 2026 the US National Problem Gambling Helpline is
 * 1-800-MY-RESET. 1-800-GAMBLER still answers 24/7, run by the Council on
 * Compulsive Gambling of New Jersey, and some states still require it in
 * gambling copy, so the Global footer carries both.
 */
export const NCPG_HELPLINE: Helpline = {
  name: 'National Problem Gambling Helpline (US)',
  phone: '1-800-MY-RESET (1-800-697-3738)',
  url: 'https://www.ncpgambling.org/help-treatment/',
  source: 'https://www.ncpgambling.org/help-treatment/about-the-national-problem-gambling-helpline/',
  verified: '2026-10-02',
};

export const GAMBLER_800: Helpline = {
  name: '1-800-GAMBLER',
  phone: '1-800-GAMBLER (1-800-426-2537)',
  url: 'https://800gambler.org',
  source: 'https://800gambler.org/',
  verified: '2026-10-02',
};

export const NZ_GAMBLING_HELPLINE: Helpline = {
  name: 'Gambling Helpline (New Zealand)',
  phone: '0800 654 655',
  url: 'https://gamblinghelpline.co.nz',
  source: 'https://gamblinghelpline.co.nz/',
  verified: '2026-10-02',
};

/**
 * The national Consistent Gambling Messaging for online wagering: one of the
 * seven official taglines plus the standard call to action, word for word.
 * Source: https://www.cits.wa.gov.au/department/news/news-article/2025/03/24/consistent-gambling-messaging
 * (the published notice of the DSS measure), verified 2026-10-02.
 */
const AU_TAGLINE = "Chances are you're about to lose.";
const AU_CALL_TO_ACTION =
  'For free and confidential support call 1800 858 858 or visit gamblinghelponline.org.au.';

const ODDS_NOTE =
  'Any odds quoted are indicative, in decimal format, as at the time shown, and subject to change. ' +
  'Nothing here is a guarantee of any result.';

export const AU_FOOTER = [
  `**18+ only. ${AU_TAGLINE}** ${AU_CALL_TO_ACTION}`,
  `To block yourself from every licensed Australian online and phone gambling provider, register with [${BETSTOP.name}](${BETSTOP.url}).`,
  ODDS_NOTE,
].join('\n\n');

export const GLOBAL_FOOTER = [
  '**18+ (21+ where local law requires).** Betting is illegal or restricted in some places, check your local law before you bet.',
  [
    'If gambling is causing you or someone close to you harm, free and confidential help is available:',
    `- UK: [GamCare](${GAMCARE.url}), ${GAMCARE.phone}`,
    `- US: [National Problem Gambling Helpline](${NCPG_HELPLINE.url}), ${NCPG_HELPLINE.phone}, or [1-800-GAMBLER](${GAMBLER_800.url})`,
    `- New Zealand: [Gambling Helpline](${NZ_GAMBLING_HELPLINE.url}), ${NZ_GAMBLING_HELPLINE.phone}`,
    '- Anywhere else: contact your local gambling support service.',
  ].join('\n'),
  ODDS_NOTE,
].join('\n\n');
