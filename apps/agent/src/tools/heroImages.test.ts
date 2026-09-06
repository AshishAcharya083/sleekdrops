// The gate every operator-dropped hero image passes before it gets a public
// URL. These are the checks that keep a mislabeled or hostile file from being
// served off our own bucket and rendered as a hero by the website.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_HERO_IMAGE_BYTES,
  heroImageObjectName,
  readHeroImageUpload,
  sniffImageMime,
} from './heroImages.js';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64),
]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.from([0x40, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP', 'latin1'),
  Buffer.alloc(64),
]);

test('sniffs the three formats the site renders', () => {
  assert.equal(sniffImageMime(JPEG), 'image/jpeg');
  assert.equal(sniffImageMime(PNG), 'image/png');
  assert.equal(sniffImageMime(WEBP), 'image/webp');
});

test('accepts a real image and reports the sniffed type', () => {
  const result = readHeroImageUpload('image/jpeg', JPEG);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value.mimeType, 'image/jpeg');
});

test('the sniffed format wins over a wrong browser-declared one', () => {
  // A PNG saved as "photo.jpg" is a normal operator mistake, not an attack:
  // it publishes fine, it just gets the type and extension it really is.
  const result = readHeroImageUpload('image/jpeg', PNG);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value.mimeType, 'image/png');
});

test('rejects a non-image wearing an image content type', () => {
  const result = readHeroImageUpload('image/png', Buffer.from('<html>not an image</html>'));
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error, /JPEG, PNG or WebP/);
});

test('rejects SVG — it can carry script and would be served from our own origin', () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
  const result = readHeroImageUpload('image/svg+xml', svg);
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error, /image\/svg\+xml/);
});

test('rejects an empty file', () => {
  const result = readHeroImageUpload('image/png', Buffer.alloc(0));
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error, /empty/);
});

test('rejects an image over the size cap and says how big it was', () => {
  const huge = Buffer.concat([PNG, Buffer.alloc(MAX_HERO_IMAGE_BYTES)]);
  const result = readHeroImageUpload('image/png', huge);
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error, /MB — the limit is 10 MB/);
});

test('object names are unique per upload, so a replacement is never cached over', () => {
  const id = '0d1c8f5a-3c2b-4a5e-9f10-2b3c4d5e6f70';
  const first = heroImageObjectName('article', id, 'image/jpeg');
  const second = heroImageObjectName('article', id, 'image/jpeg');

  assert.notEqual(first, second);
  assert.match(first, /^heroes\/uploads\/article-0d1c8f5a-3c2b-4a5e-9f10-2b3c4d5e6f70-[0-9a-f]{8}\.jpg$/);
});

test('object names carry the scope and the right extension', () => {
  assert.match(heroImageObjectName('topic', 'abc', 'image/webp'), /^heroes\/uploads\/topic-abc-\w+\.webp$/);
  assert.match(heroImageObjectName('article', 'abc', 'image/png'), /\.png$/);
});

test('a hostile owner id cannot escape the uploads prefix', () => {
  const name = heroImageObjectName('article', '../../public/index', 'image/png');
  assert.equal(name.includes('..'), false);
  assert.match(name, /^heroes\/uploads\/article-/);
});
