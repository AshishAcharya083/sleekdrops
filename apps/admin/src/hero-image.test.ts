import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_HERO_IMAGE_BYTES, formatBytes, validateHeroImage } from './hero-image.ts';

const jpeg = { name: 'kettle.jpg', type: 'image/jpeg', size: 400_000 };

test('accepts the formats the website renders', () => {
  assert.equal(validateHeroImage(jpeg), null);
  assert.equal(validateHeroImage({ name: 'a.png', type: 'image/png', size: 10 }), null);
  assert.equal(validateHeroImage({ name: 'a.webp', type: 'image/webp', size: 10 }), null);
});

test('accepts a drag-and-drop that arrives without a MIME type, on its extension', () => {
  assert.equal(validateHeroImage({ name: 'Kettle Hero.JPEG', type: '', size: 1000 }), null);
});

test('names the file in every rejection, so a multi-file drop is diagnosable', () => {
  const problem = validateHeroImage({ name: 'notes.pdf', type: 'application/pdf', size: 1000 });
  assert.match(problem ?? '', /^notes\.pdf: /);
});

test('rejects SVG even though it is an image', () => {
  assert.match(
    validateHeroImage({ name: 'logo.svg', type: 'image/svg+xml', size: 1000 }) ?? '',
    /JPEG, PNG or WebP/,
  );
});

test('rejects an empty file and one over the cap', () => {
  assert.match(validateHeroImage({ ...jpeg, size: 0 }) ?? '', /empty/);
  assert.match(
    validateHeroImage({ ...jpeg, size: MAX_HERO_IMAGE_BYTES + 1 }) ?? '',
    /10\.0 MB exceeds the 10 MB limit/,
  );
});

test('formatBytes reads like a file manager', () => {
  assert.equal(formatBytes(900), '1 KB');
  assert.equal(formatBytes(820 * 1024), '820 KB');
  assert.equal(formatBytes(1.44 * 1024 * 1024), '1.4 MB');
});
