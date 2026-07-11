/**
 * Shared category-slug union, extracted to avoid a circular import between
 * categories.ts and other data files that reference category by slug.
 */

export type CategorySlug =
  | 'tech'
  | 'home'
  | 'fashion'
  | 'health'
  | 'finance'
  | 'travel';

export type CategoryName =
  | 'Tech'
  | 'Home'
  | 'Fashion'
  | 'Health'
  | 'Finance'
  | 'Travel';
