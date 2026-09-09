/**
 * Category registry.
 *
 * Used for the category strip on the homepage, the category filter pages,
 * and the footer links. Keep in sync with the `category` enum in
 * src/content/config.ts — typos here fail the build there.
 */

export interface Category {
  id: string;
  /** Display name (sentence case for the strip, used as-is). */
  name: string;
  /** Slug used in URLs (/category/[slug]). */
  slug: string;
  /** One-line description for the category landing page. */
  blurb: string;
  /** Long-form intro / hero copy for the category page. */
  intro: string;
}

export const categories: Category[] = [
  {
    id: 'tech',
    name: 'Tech',
    slug: 'tech',
    blurb: 'Headphones, speakers and practical personal technology.',
    intro:
      'Headphones, e-readers, smart-home gear, and the laptops worth replacing yours for. Compared on the specs and owner reviews that matter, not the launch hype.',
  },
  {
    id: 'home',
    name: 'Home',
    slug: 'home',
    blurb: 'Kitchens, desks, the long, quiet half of the house.',
    intro:
      'Kettles, desks, lighting, and the practical infrastructure of a home. Compared through published specifications, owner reports and expert coverage.',
  },
  {
    id: 'fashion',
    name: 'Fashion',
    slug: 'fashion',
    blurb: 'Wardrobe staples, materials and construction.',
    intro:
      'Coats, knits, denim, and considered wardrobe purchases. We compare materials, construction details, care requirements and long-term owner reports.',
  },
  {
    id: 'health',
    name: 'Health',
    slug: 'health',
    blurb: 'Wearables, sleep, and the data behind the claims.',
    intro:
      'Sleep rings, watches, scales, and the evidence behind their claims. We compare published research, specifications and owner reports.',
  },
  {
    id: 'finance',
    name: 'Finance',
    slug: 'finance',
    blurb: 'Cards, accounts, and the spreadsheets behind the picks.',
    intro:
      'Cashback cards, savings accounts, and the terms behind the headline rate. We show the assumptions and arithmetic behind each comparison.',
  },
  {
    id: 'travel',
    name: 'Travel',
    slug: 'travel',
    blurb: 'Bags, gear, and the routines of frequent flyers.',
    intro:
      'Carry-on bags, packing cubes, and practical travel gear compared through specifications, owner reports and established expert coverage.',
  },
];

export function getCategory(name: string): Category | undefined {
  return categories.find((c) => c.name.toLowerCase() === name.toLowerCase());
}

export function getCategoryBySlug(slug: string): Category | undefined {
  return categories.find((c) => c.slug === slug);
}
