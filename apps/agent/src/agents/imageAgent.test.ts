import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { heroKey, resizeToHero } from './imageAgent.js';
import { r2Configured, uploadPublicImage } from '../tools/r2.js';

test('heroKey uses the spec path posts/{YYYY}/{MM}/{slug}/hero.jpg', () => {
  assert.equal(heroKey('cozy-blanket', '2026-07-18'), 'posts/2026/07/cozy-blanket/hero.jpg');
  // Full ISO timestamps (only YYYY-MM are consumed) still yield the right key.
  assert.equal(heroKey('a-b', '2025-01-09T12:34:56Z'), 'posts/2025/01/a-b/hero.jpg');
});

test('resizeToHero produces a 1600x900 JPEG with metadata stripped', async () => {
  // A tall source that must be cropped to 16:9, carrying an EXIF orientation tag.
  const source = await sharp({
    create: { width: 1200, height: 2000, channels: 3, background: { r: 12, g: 80, b: 160 } },
  })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();

  const hero = await resizeToHero(source);
  const meta = await sharp(hero).metadata();

  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, 1600);
  assert.equal(meta.height, 900);
  // EXIF is dropped and orientation applied, so no residual orientation tag.
  assert.equal(meta.exif, undefined);
  assert.equal(meta.orientation, undefined);
});

test('R2 is unconfigured in tests, so uploads are gated', async () => {
  assert.equal(r2Configured(), false);
  await assert.rejects(
    uploadPublicImage('posts/2026/07/x/hero.jpg', Buffer.from('x'), 'image/jpeg'),
    /Cloudflare R2 is not configured/,
  );
});
