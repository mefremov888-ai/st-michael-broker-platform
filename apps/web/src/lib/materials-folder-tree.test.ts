import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeMaterialsSegments,
  fileCountUnder,
  foldersAndFilesAt,
  materialHref,
  splitMaterialPath,
} from './materials-folder-tree';

const docs = [
  { subcategory: 'ЗОРГЕ 9/1. Фото/01. Двор' },
  { subcategory: 'ЗОРГЕ 9/1. Фото/01. Двор' },
  { subcategory: 'ЗОРГЕ 9/2. Видео' },
  { subcategory: 'КСБ/3. Reels' },
];

test('splitMaterialPath keeps nested Disk folders', () => {
  assert.deepEqual(splitMaterialPath('ЗОРГЕ 9/1. Фото/01. Двор'), ['ЗОРГЕ 9', '1. Фото', '01. Двор']);
});

test('foldersAndFilesAt lists first-level Disk projects', () => {
  const { folders, files } = foldersAndFilesAt(docs, []);
  assert.deepEqual(folders, ['ЗОРГЕ 9', 'КСБ']);
  assert.equal(files.length, 0);
});

test('foldersAndFilesAt lists albums inside a project', () => {
  const { folders, files } = foldersAndFilesAt(docs, ['ЗОРГЕ 9']);
  assert.deepEqual(folders, ['1. Фото', '2. Видео']);
  assert.equal(files.length, 0);
});

test('foldersAndFilesAt returns files at the leaf folder', () => {
  const { folders, files } = foldersAndFilesAt(docs, ['ЗОРГЕ 9', '2. Видео']);
  assert.deepEqual(folders, []);
  assert.equal(files.length, 1);
});

test('fileCountUnder includes nested files', () => {
  assert.equal(fileCountUnder(docs, ['ЗОРГЕ 9']), 3);
  assert.equal(fileCountUnder(docs, ['ЗОРГЕ 9', '1. Фото']), 2);
});

test('materialHref encodes each path segment', () => {
  assert.equal(
    materialHref(['ЗОРГЕ 9', '1. Фото']),
    '/materials/%D0%97%D0%9E%D0%A0%D0%93%D0%95%209/1.%20%D0%A4%D0%BE%D1%82%D0%BE',
  );
});

test('decodeMaterialsSegments accepts catch-all params', () => {
  assert.deepEqual(decodeMaterialsSegments(['%D0%9A%D0%A1%D0%91', '3.%20Reels']), ['КСБ', '3. Reels']);
});
