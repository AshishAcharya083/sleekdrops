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
    blurb: 'Headphones, speakers, the gadgets we keep on the desk.',
    intro:
      'Headphones, e-readers, smart-home gear, and the laptops worth replacing yours for. Compared on the specs and owner reviews that matter, not the launch hype.',
  },
  {
    id: 'home',
    name: 'Home',
    slug: 'home',
    blurb: 'Kitchens, desks, the long, quiet half of the house.',
    intro:
      'Kettles, desks, lighting, and the unglamorous infrastructure that makes a room better. Picked for real rooms, not studio sets.',
  },
  {
    id: 'fashion',
    name: 'Fashion',
    slug: 'fashion',
    blurb: 'Wardrobe staples and the third-wash test.',
    intro:
      'Coats, knits, denim, and the considered purchases that earn closet space. Pilling, hand-feel, and the hem that hangs without break-in.',
  },
  {
    id: 'health',
    name: 'Health',
    slug: 'health',
    blurb: 'Wearables, sleep, and the data behind the claims.',
    intro:
      'Sleep rings, watches, scales, and the kind of measurement that actually changes behavior. We log the data so you don’t have to.',
  },
  {
    id: 'finance',
    name: 'Finance',
    slug: 'finance',
    blurb: 'Cards, accounts, and the spreadsheets behind the picks.',
    intro:
      'Cashback cards, high-yield accounts, and the math nobody else runs. We model real spend profiles, not the marketing rate.',
  },
  {
    id: 'travel',
    name: 'Travel',
    slug: 'travel',
    blurb: 'Bags, gear, and the routines of frequent flyers.',
    intro:
      'Carry-on bags, packing cubes, and the gear that survives forty flights a year. Chosen for real airports, not for a kitchen scale.',
  },
];

export function getCategory(name: string): Category | undefined {
  return categories.find((c) => c.name.toLowerCase() === name.toLowerCase());
}

export function getCategoryBySlug(slug: string): Category | undefined {
  return categories.find((c) => c.slug === slug);
}
