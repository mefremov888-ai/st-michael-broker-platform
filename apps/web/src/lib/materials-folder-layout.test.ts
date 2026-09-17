import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_MATERIALS_LAYOUT,
  classifyMaterialsMedia,
  discoverDiskPrefixes,
  mergeMaterialsLayout,
  parseMaterialsLayout,
  sortMaterialsRootFolders,
  withDisplaySubcategory,
} from '../../../../packages/shared/src/materials-folder-layout';
import { foldersAndFilesAt, fileCountUnder } from './materials-folder-tree';

const docs = [
  { subcategory: 'Актуальные условия рассрочки', name: 'rassrochka.pdf', type: 'PDF' },
  { subcategory: 'Условия вознаграждения', name: 'условия.pdf', type: 'PDF' },
  { subcategory: 'ЗОРГЕ 9/1. Фото/01. Двор', name: 'yard.jpg', type: 'image/jpeg' },
  { subcategory: 'ЗОРГЕ 9/2. Видео', name: 'tour.mp4', type: 'video/mp4' },
  { subcategory: 'Зорге9 (фото)/Альбом', name: 'lobby.jpg', type: 'image/jpeg' },
  { subcategory: 'Видеоконтент/Зорге 9/Reels', name: 'reel.mp4', type: 'video/mp4' },
  { subcategory: 'ЗОРГЕ 9/2. Видео/reels/мобильные', name: 'mobile-reel.mp4', type: 'video/mp4' },
  { subcategory: 'Презентации/Зорге 9', name: 'zorge-pres.pdf', type: 'PDF' },
  { subcategory: 'Презентации проектов/_Квартал Серебряный бор_', name: 'ksb-pres.pdf', type: 'PDF' },
  { subcategory: 'КСБ/1. Фото', name: 'ksb.jpg', type: 'image/jpeg' },
  { subcategory: 'КСБ/3. Reels', name: 'ksb.mp4', type: 'video/mp4' },
  { subcategory: 'Квартал Серебряный Бор рендеры', name: 'render.jpg', type: 'image/jpeg' },
  { subcategory: 'Видеоконтент/Квартал Серебряный Бор/Reels', name: 'ksb-reel.mp4', type: 'video/mp4' },
  { subcategory: 'Видеоконтент/Для роликов сторис reels', name: 'misc.mp4', type: 'video/mp4' },
];

// 2026-09-17 (владелец): отдельной карточки «Презентации» наверху больше нет —
// презентации лежат внутри проектов.
test('landing roots are standalone terms plus two residential complexes', () => {
  const mapped = withDisplaySubcategory(docs, DEFAULT_MATERIALS_LAYOUT, 'landing');
  const { folders } = foldersAndFilesAt(mapped, []);
  assert.deepEqual(sortMaterialsRootFolders(folders, DEFAULT_MATERIALS_LAYOUT), [
    'Актуальные условия рассрочки',
    'Условия вознаграждения',
    'Зорге 9',
    'Квартал Серебряный Бор',
  ]);
});

test('Зорге 9 contains photo and video, not raw Disk names', () => {
  const mapped = withDisplaySubcategory(docs, DEFAULT_MATERIALS_LAYOUT, 'landing');
  const { folders } = foldersAndFilesAt(mapped, ['Зорге 9']);
  // 2026-09-17: Reels вынесены из «Видео» в отдельную папку проекта.
  assert.deepEqual(folders, ['Видео', 'Презентации', 'Фото', 'Reels']);
  assert.equal(fileCountUnder(mapped, ['Зорге 9', 'Фото']), 2);
  // «Видео» осталось без рилсов: они теперь в своей папке.
  assert.equal(fileCountUnder(mapped, ['Зорге 9', 'Видео']), 1);
  assert.equal(fileCountUnder(mapped, ['Зорге 9', 'Reels']), 2);
});

// 2026-09-17 (владелец): презентации переехали внутрь проектов.
test('презентации лежат внутри проектов, а не отдельной карточкой', () => {
  const mapped = withDisplaySubcategory(docs, DEFAULT_MATERIALS_LAYOUT, 'cabinet');
  assert.equal(fileCountUnder(mapped, ['Зорге 9', 'Презентации']), 1);
  assert.equal(fileCountUnder(mapped, ['Квартал Серебряный Бор', 'Презентации']), 1);
  const { folders } = foldersAndFilesAt(mapped, []);
  assert.equal(folders.includes('Презентации'), false);
  assert.equal(folders.includes('Презентации проектов'), false);
});

test('Квартал Серебряный Бор contains photo and video from КСБ, renders and video pack', () => {
  const mapped = withDisplaySubcategory(docs, DEFAULT_MATERIALS_LAYOUT, 'landing');
  const { folders } = foldersAndFilesAt(mapped, ['Квартал Серебряный Бор']);
  assert.deepEqual(folders, ['Видео', 'Презентации', 'Фото']);
  assert.equal(fileCountUnder(mapped, ['Квартал Серебряный Бор', 'Фото']), 2);
  assert.equal(fileCountUnder(mapped, ['Квартал Серебряный Бор', 'Видео']), 2);
});

test('raw Видеоконтент is hidden on landing and kept in cabinet leftovers', () => {
  const landing = withDisplaySubcategory(docs, DEFAULT_MATERIALS_LAYOUT, 'landing');
  const cabinet = withDisplaySubcategory(docs, DEFAULT_MATERIALS_LAYOUT, 'cabinet');
  assert.equal(foldersAndFilesAt(landing, ['Видеоконтент']).files.length, 0);
  assert.ok(fileCountUnder(cabinet, ['Видеоконтент']) >= 1);
});

test('hiding a group in admin removes it from landing', () => {
  const layout = structuredClone(DEFAULT_MATERIALS_LAYOUT);
  const zorge = layout.groups.find((group) => group.id === 'zorge');
  if (!zorge) throw new Error('missing zorge group');
  zorge.visibleOnLanding = false;
  const mapped = withDisplaySubcategory(docs, layout, 'landing');
  assert.equal(foldersAndFilesAt(mapped, []).folders.includes('Зорге 9'), false);
  assert.equal(foldersAndFilesAt(mapped, []).folders.includes('Квартал Серебряный Бор'), true);
});

test('classifyMaterialsMedia uses folder names and file types', () => {
  assert.equal(classifyMaterialsMedia({ subcategory: 'КСБ/3. Reels', type: 'MP4', name: 'x.mp4' }), 'video');
  assert.equal(classifyMaterialsMedia({ subcategory: 'ЗОРГЕ 9/1. Фото', type: 'JPG', name: 'x.jpg' }), 'photo');
});

test('parseMaterialsLayout falls back to default on garbage', () => {
  assert.equal(parseMaterialsLayout('nope').groups[0]?.title, 'Зорге 9');
  assert.equal(parseMaterialsLayout({ version: 1, groups: [], rules: [] }).groups.length, 0);
});

test('saved layout still showing Зорге / Берарина is renamed on parse', () => {
  const stale = structuredClone(DEFAULT_MATERIALS_LAYOUT);
  stale.groups[0].title = 'Зорге';
  stale.groups[1].title = 'Берарина';
  const parsed = parseMaterialsLayout(stale);
  assert.equal(parsed.groups[0]?.title, 'Зорге 9');
  assert.equal(parsed.groups[1]?.title, 'Квартал Серебряный Бор');
});

test('mergeMaterialsLayout adds unknown Disk folders without fighting grouped prefixes', () => {
  const extra = [...docs, { subcategory: 'Новая папка/файл', name: 'x.pdf' }];
  const merged = mergeMaterialsLayout(DEFAULT_MATERIALS_LAYOUT, extra);
  assert.ok(merged.rules.some((rule) => rule.prefix === 'Новая папка'));
  assert.equal(merged.rules.filter((rule) => rule.prefix === 'Видеоконтент').length, 1);
  assert.deepEqual(
    discoverDiskPrefixes(extra).includes('Видеоконтент/Зорге 9'),
    true,
  );
});
