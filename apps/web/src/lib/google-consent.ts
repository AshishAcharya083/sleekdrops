/**
 * Countries where Google's European regulations message is eligible to show:
 * the 30 EEA states, the United Kingdom and Switzerland.
 *
 * Google uses ISO 3166-2 region codes for Consent Mode defaults. Keeping the
 * list in a typed module makes the region boundary reviewable and testable
 * instead of burying it in an inline script.
 */
export const GOOGLE_EU_CONSENT_REGIONS = [
  'AT',
  'BE',
  'BG',
  'CH',
  'CY',
  'CZ',
  'DE',
  'DK',
  'EE',
  'ES',
  'FI',
  'FR',
  'GB',
  'GR',
  'HR',
  'HU',
  'IE',
  'IS',
  'IT',
  'LI',
  'LT',
  'LU',
  'LV',
  'MT',
  'NL',
  'NO',
  'PL',
  'PT',
  'RO',
  'SE',
  'SI',
  'SK',
] as const;
