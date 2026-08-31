import assert from 'node:assert/strict';
import test from 'node:test';
import { materialsThumbUrl } from './materials-thumb';

test('materialsThumbUrl points local Disk files at the thumbs folder', () => {
  assert.equal(
    materialsThumbUrl('/files/yandex/%D0%97%D0%9E%D0%A0%D0%93%D0%95%209/1.jpg'),
    '/files/yandex-thumbs/%D0%97%D0%9E%D0%A0%D0%93%D0%95%209/1.jpg.thumb.jpg',
  );
});

test('materialsThumbUrl keeps S3 files on the marketing imgproxy', () => {
  const src = 'https://storage.yandexcloud.net/bucket/a.jpg';
  assert.equal(
    materialsThumbUrl(src),
    `https://stmichael.ru/proxy/insecure/w:280/q:40/plain/${src}@webp`,
  );
});
