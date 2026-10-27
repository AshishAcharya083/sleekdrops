import { test } from 'node:test';
import assert from 'node:assert/strict';

import { contactHref } from './site.ts';

test('a contact link is a plain mailto, with an encoded subject only when one is given', () => {
  assert.equal(contactHref('corrections'), 'mailto:corrections@sleekdrops.com');
  assert.equal(contactHref('desk', 'Score & method?'), 'mailto:desk@sleekdrops.com?subject=Score%20%26%20method%3F');
});
