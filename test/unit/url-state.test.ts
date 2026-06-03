// Verify `getUrlJsonParam` reads from the fragment first and falls
// back to the search string so links generated before the fragment
// migration still load. Mocks `window.location` minimally; both
// fields use the same shape the runtime DOM exposes.

import { test } from 'node:test';
import assert from 'node:assert/strict';

interface MockLocation { search: string; hash: string }
type GlobalWithWindow = { window?: { location?: MockLocation } };
function withMockLocation(loc: MockLocation, fn: () => void): void {
  const g = globalThis as GlobalWithWindow;
  const prev = g.window;
  g.window = { location: loc };
  try { fn(); }
  finally {
    if (prev === undefined) delete g.window;
    else g.window = prev;
  }
}

test('getUrlJsonParam: reads from fragment when present', async () => {
  const { getUrlJsonParam } = await import('../../src/editor/url-state.js');
  withMockLocation({ search: '', hash: '#json=fragment-payload' }, () => {
    assert.equal(getUrlJsonParam(), 'fragment-payload');
  });
});

test('getUrlJsonParam: falls back to search when fragment lacks json (legacy URLs)', async () => {
  const { getUrlJsonParam } = await import('../../src/editor/url-state.js');
  withMockLocation({ search: '?json=legacy-payload', hash: '' }, () => {
    assert.equal(getUrlJsonParam(), 'legacy-payload');
  });
});

test('getUrlJsonParam: fragment wins when both present (new format takes precedence)', async () => {
  const { getUrlJsonParam } = await import('../../src/editor/url-state.js');
  withMockLocation({ search: '?json=legacy', hash: '#json=current' }, () => {
    assert.equal(getUrlJsonParam(), 'current');
  });
});

test('getUrlJsonParam: returns null when neither is set', async () => {
  const { getUrlJsonParam } = await import('../../src/editor/url-state.js');
  withMockLocation({ search: '', hash: '' }, () => {
    assert.equal(getUrlJsonParam(), null);
  });
});

test('getUrlJsonParam: fragment alongside other hash params still picks json', async () => {
  const { getUrlJsonParam } = await import('../../src/editor/url-state.js');
  withMockLocation({ search: '', hash: '#anim=1&json=multi&scene=basic' }, () => {
    assert.equal(getUrlJsonParam(), 'multi');
  });
});
