export const AFFILIATE_REGISTRY: Record<string, { name: string; url: string; network: string }> = {
  amazon_au: { name: 'Amazon AU', url: '', network: 'amazon' },
  amazon_us: { name: 'Amazon US', url: '', network: 'amazon' },
};

export const resolveAffiliateUrl = (key: string): string =>
  AFFILIATE_REGISTRY[key]?.url ?? '#';
