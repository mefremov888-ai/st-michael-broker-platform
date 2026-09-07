import {
  ID_FOLDER_RE,
  APT_LEAF_RE,
  SOHO_BUILDING_RE,
  buildSohoKey,
  computePhotoOrder,
  isImageItem,
  sanitizeName,
} from './yandex-disk-photos.service';

// Regex/matching examples below are real folder names observed live on the
// two public Yandex.Disk folders documented in
// docs/yandex-disk-photos-feed.md (fetched 2026-08-21).

describe('ID_FOLDER_RE (Source 1 — personal photos by externalId)', () => {
  it('extracts the numeric id from a real lot folder name', () => {
    expect('А3 (5) - 198.1_id: 5069059'.match(ID_FOLDER_RE)?.[1]).toBe('5069059');
    expect('Б4 (20) - 205.2_id: 17468944'.match(ID_FOLDER_RE)?.[1]).toBe('17468944');
  });

  it('does not match a plain floor/intermediate folder', () => {
    expect('16 эт'.match(ID_FOLDER_RE)).toBeNull();
  });
});

describe('APT_LEAF_RE (Source 2 — Soho leaf folder by apartment number)', () => {
  it('extracts apartment number and subIndex from a real leaf folder name', () => {
    const m = 'А3 (5) - 22.1'.match(APT_LEAF_RE);
    expect(m?.[1]).toBe('22');
    expect(m?.[2]).toBe('1');
  });

  it('does not match a floor or section folder', () => {
    expect('02'.match(APT_LEAF_RE)).toBeNull();
    expect('А3'.match(APT_LEAF_RE)).toBeNull();
  });
});

describe('SOHO_BUILDING_RE', () => {
  it('matches known Soho building labels', () => {
    expect(SOHO_BUILDING_RE.test('Корпус 3. Soho')).toBe(true);
    expect(SOHO_BUILDING_RE.test('корпус 3')).toBe(true);
  });

  it('does not match other buildings', () => {
    expect(SOHO_BUILDING_RE.test('Корпус 1')).toBe(false);
    expect(SOHO_BUILDING_RE.test('Корпус 31')).toBe(false); // \b guards against corpus 31/32...
  });
});

describe('buildSohoKey', () => {
  it('builds the key from the last dash-segment of the lot number, per docs example', () => {
    expect(buildSohoKey('ЗГ3-2-3-22/1', 2)).toBe('2-22-1');
  });

  it('falls back to subIndex "0" when the number has no "/<n>" part', () => {
    expect(buildSohoKey('ЗГ3-2-3-22', 2)).toBe('2-22-0');
  });

  it('supports an explicit subIndex override for the fallback lookup', () => {
    expect(buildSohoKey('ЗГ3-2-3-22/1', 2, '0')).toBe('2-22-0');
  });

  it('returns null when the lot number is empty', () => {
    expect(buildSohoKey('', 2)).toBeNull();
  });
});

describe('isImageItem', () => {
  it('accepts image mime types', () => {
    expect(isImageItem({ name: '01.jpg', mime_type: 'image/png' })).toBe(true);
  });

  it('falls back to extension when mime_type is missing', () => {
    expect(isImageItem({ name: 'photo.webp' })).toBe(true);
    expect(isImageItem({ name: 'notes.txt' })).toBe(false);
  });
});

describe('sanitizeName', () => {
  it('keeps a plain filename untouched', () => {
    expect(sanitizeName('01.jpg')).toBe('01.jpg');
  });

  it('collapses whitespace and strips unsafe characters', () => {
    // \w is non-unicode here (matches sync-yandex-files.js convention), so
    // Cyrillic letters are replaced — only ASCII/digits/punctuation survive.
    expect(sanitizeName('ChatGPT Image 14 мая 2026 г., 11_27_34.png')).toBe(
      'ChatGPT Image 14 ___ 2026 _., 11_27_34.png',
    );
  });
});

describe('computePhotoOrder', () => {
  // Real offers (fetched live 2026-08-21 from the ZORGE9 feed) tag images
  // type="plan" (apartment plan, 2-3 per offer) then type="plan floor" (one
  // per floor, shared across every unit on it) then house/facade/building —
  // see docs/yandex-disk-photos-feed.md for the confirmed final order.
  it('orders plan, floor plan, then personal Yandex photos, then remaining feed photos — always', () => {
    const result = computePhotoOrder(
      'https://feed/plan.jpg',
      'https://feed/plan-floor.jpg',
      ['https://files/yandex/lot/01.jpg', 'https://files/yandex/lot/02.jpg'],
      ['https://feed/plan.jpg', 'https://feed/plan-floor.jpg', 'https://feed/extra1.jpg', 'https://feed/extra2.jpg'],
    );
    expect(result).toEqual([
      'https://feed/plan.jpg',
      'https://feed/plan-floor.jpg',
      'https://files/yandex/lot/01.jpg',
      'https://files/yandex/lot/02.jpg',
      'https://feed/extra1.jpg',
      'https://feed/extra2.jpg',
    ]);
  });

  it('still appends remaining feed photos when no personal photos were found', () => {
    const result = computePhotoOrder(
      'https://feed/plan.jpg',
      'https://feed/plan-floor.jpg',
      [],
      ['https://feed/plan.jpg', 'https://feed/plan-floor.jpg', 'https://feed/extra1.jpg'],
    );
    expect(result).toEqual(['https://feed/plan.jpg', 'https://feed/plan-floor.jpg', 'https://feed/extra1.jpg']);
  });

  it('drops falsy entries, a null plan, and a null floor plan', () => {
    const result = computePhotoOrder(null, null, ['https://y/1.jpg'], ['', 'https://feed/extra.jpg']);
    expect(result).toEqual(['https://y/1.jpg', 'https://feed/extra.jpg']);
  });

  it('handles a lot with no floor plan in the feed (layoutUrl null) without dropping other photos', () => {
    const result = computePhotoOrder(
      'https://feed/plan.jpg',
      null,
      ['https://y/1.jpg'],
      ['https://feed/plan.jpg', 'https://feed/extra1.jpg'],
    );
    expect(result).toEqual(['https://feed/plan.jpg', 'https://y/1.jpg', 'https://feed/extra1.jpg']);
  });
});
