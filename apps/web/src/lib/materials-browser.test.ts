import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MATERIALS_CATALOG_HREF,
  MATERIALS_CONDITIONS_HREF,
  MATERIALS_CONTACT_EMAIL,
  isMaterialImage,
  isMaterialPdf,
  isMaterialVideo,
  materialsFolderCover,
  materialsParentHref,
  materialsProjectCover,
  standaloneMaterials,
  uniqueMaterials,
  currentMaterials,
  type MaterialDocument,
} from './materials-browser';
import { materialHref } from './materials-folder-tree';
import type { MaterialsFolderLayout } from '../../../../packages/shared/src/materials-folder-layout';

function document(overrides: Partial<MaterialDocument> = {}): MaterialDocument {
  return {
    id: 'doc-1',
    name: 'material.pdf',
    type: 'PDF',
    category: 'materials',
    subcategory: 'Условия сотрудничества',
    fileUrl: '/files/material.pdf',
    ...overrides,
  };
}
test('explicitly archived cooperation material is hidden without hiding legitimate private documents', () => {
  const rows = [
    {...document({id:'old',description:'[archived:cooperation-current] superseded'}),isPublic:false},
    {...document({id:'private',description:'Внутренние материалы для брокеров'}),isPublic:false},
    {...document({id:'current',description:'Текущие условия'}),isPublic:true},
    document({id:'other-archive',description:'[archived:other-scope]'}),
  ];
  assert.deepEqual(currentMaterials(rows).map(d => d.id), ['private','current','other-archive']);
  assert.equal(rows.length,4);
});

function layout(overrides: Partial<MaterialsFolderLayout> = {}): MaterialsFolderLayout {
  return {
    version: 1,
    groups: [
      { id: 'zorge', title: 'Зорге 9', visibleOnLanding: true, visibleInCabinet: true, sortOrder: 10 },
      { id: 'silver-bor', title: 'Квартал Серебряный бор', visibleOnLanding: true, visibleInCabinet: true, sortOrder: 20 },
    ],
    rules: [],
    covers: {},
    ...overrides,
  };
}

test('both project presentation folders use the supplied presentation cover', () => {
  for (const project of ['Зорге 9', 'Квартал Серебряный бор', 'Квартал Серебряный Бор']) {
    const configured = layout({ covers: { [`${project}/Презентации`]: '/files/old-cover.jpg' } });
    assert.deepEqual(materialsFolderCover(configured, [], [project, 'Презентации']), {
      kind: 'image', src: '/v2/materials/presentations.webp',
    });
  }
});

test('the Silver Bor video folder uses the supplied MP4 with a separate poster', () => {
  assert.deepEqual(materialsFolderCover(layout(), [], ['Квартал Серебряный бор', 'Видео']), {
    kind: 'video',
    src: '/v2/materials/silver-bor-video.mp4',
    poster: '/v2/materials/silver-bor-video-poster.webp',
  });
});

test('the supplied Silver Bor video does not replace the Zorge video cover', () => {
  const path = 'Зорге 9/Видео';
  assert.deepEqual(materialsFolderCover(layout({ covers: { [path]: '/files/yandex/zorge.MOV' } }), [], path.split('/')), {
    kind: 'image',
    src: '/files/yandex-thumbs/zorge.MOV.thumb.jpg',
  });
});

test('nested video and presentation albums retain their own configured covers', () => {
  for (const path of [
    'Зорге 9/Видео/Теплый период — весна, лето, осень',
    'Квартал Серебряный бор/Видео/Архив',
    'Зорге 9/Презентации/Апартаменты',
    'Квартал Серебряный бор/Презентации/Пентхаусы',
  ]) {
    assert.deepEqual(materialsFolderCover(layout({ covers: { [path]: '/files/yandex/album.jpg' } }), [], path.split('/')), {
      kind: 'image', src: '/files/yandex-thumbs/album.jpg.thumb.jpg',
    });
  }
});

test('unrelated presentation folders do not receive a project-specific override', () => {
  const path = 'Другой проект/Презентации';
  assert.deepEqual(materialsFolderCover(layout({ covers: { [path]: '/files/custom.jpg' } }), [], path.split('/')), {
    kind: 'image', src: '/files/custom.jpg',
  });
});

test('ordinary album covers fall back to the existing CMS resolution rules', () => {
  const docs = [document({ subcategory: 'Зорге 9/Фото/Лобби', type: 'JPG', fileUrl: '/files/yandex/lobby.jpg' })];
  assert.deepEqual(materialsFolderCover(layout(), docs, ['Зорге 9', 'Фото', 'Лобби']), {
    kind: 'image', src: '/files/yandex-thumbs/lobby.jpg.thumb.jpg',
  });
  assert.equal(materialsFolderCover(layout(), [], ['Другой проект', 'Пустая папка']), null);
});

test('project catalog cards retain the landing page project images', () => {
  assert.deepEqual(materialsProjectCover('Зорге 9'), { kind: 'image', src: '/v2/img/materials-zorge9.webp' });
  assert.deepEqual(materialsProjectCover('Квартал Серебряный бор'), { kind: 'image', src: '/v2/img/materials-silver-bor.webp' });
});
test('approved Victoria root and album covers override legacy images without changing other covers', () => {
  const path = 'Зорге 9/Звездные резиденты/Фото';
  const root = '/files/materials-covers/victoria-20261012/root.jpg';
  const portrait = '/files/materials-covers/victoria-20261012/portrait.jpg';
  const configured = layout({ covers: { 'Зорге 9': root, [path]: portrait } });
  assert.deepEqual(materialsProjectCover('Зорге 9', configured), { kind: 'image', src: root });
  assert.deepEqual(materialsFolderCover(configured, [], path.split('/')), { kind: 'image', src: portrait, objectPosition: '50% 33%' });
  assert.deepEqual(materialsProjectCover('Квартал Серебряный бор', configured), materialsProjectCover('Квартал Серебряный бор'));
});

test('public catalog and conditions have explicit routes distinct from authenticated materials', () => {
  assert.equal(MATERIALS_CATALOG_HREF, '/materials/catalog');
  assert.notEqual(MATERIALS_CATALOG_HREF, '/materials');
  assert.equal(MATERIALS_CONDITIONS_HREF, '/materials/conditions');
});

test('top-level back links stay inside the public materials catalog', () => {
  assert.equal(materialsParentHref([], materialHref), MATERIALS_CATALOG_HREF);
  assert.equal(materialsParentHref(['Зорге 9'], materialHref), MATERIALS_CATALOG_HREF);
  assert.equal(materialsParentHref(['Квартал Серебряный бор'], materialHref), MATERIALS_CATALOG_HREF);
  assert.equal(materialsParentHref(['conditions'], materialHref), MATERIALS_CATALOG_HREF);
});

test('nested back links encode the immediate parent rather than the site home', () => {
  assert.equal(materialsParentHref(['Зорге 9', 'Фото', 'Апартаменты и виды'], materialHref), materialHref(['Зорге 9', 'Фото']));
  assert.equal(materialsParentHref(['Квартал Серебряный бор', 'Видео'], materialHref), materialHref(['Квартал Серебряный бор']));
  assert.equal(materialsParentHref(['Зорге 9', 'Фото', 'Лобби/СПА', 'Альбом'], materialHref),
    '/materials/%D0%97%D0%BE%D1%80%D0%B3%D0%B5%209/%D0%A4%D0%BE%D1%82%D0%BE/%D0%9B%D0%BE%D0%B1%D0%B1%D0%B8%2F%D0%A1%D0%9F%D0%90');
});

test('standalone materials preserve legacy documents, including ungrouped files', () => {
  const docs = [
    document({ id: 'terms', subcategory: 'Условия сотрудничества' }),
    document({ id: 'calculator', subcategory: 'Актуальные условия рассрочки', type: 'HTML', fileUrl: '/files/calculator.html' }),
    document({ id: 'legacy', subcategory: 'Презентации проектов/Архив' }),
    document({ id: 'ungrouped', subcategory: null }),
    document({ id: 'zorge-root', subcategory: 'Зорге 9' }),
    document({ id: 'zorge-leaf', subcategory: 'Зорге 9/Презентации' }),
    document({ id: 'silver-leaf', subcategory: 'Квартал Серебряный бор/Фото/Двор' }),
    document({ id: 'similar-name', subcategory: 'Зорге 9 — архив' }),
  ];
  assert.deepEqual(standaloneMaterials(docs, layout()).map(d => d.id), ['terms', 'calculator', 'legacy', 'ungrouped', 'similar-name']);
  assert.equal(docs.length, 8, 'filter must not mutate the caller array');
});

test('standalone filtering follows CMS group titles, not hardcoded project names', () => {
  const configured = layout({ groups: [
    { id: 'custom', title: 'ЖК Новый', visibleOnLanding: false, visibleInCabinet: true, sortOrder: 10 },
  ] });
  const docs = [document({ id: 'grouped', subcategory: 'ЖК Новый/Видео' }), document({ id: 'old', subcategory: 'Зорге 9/Фото' })];
  assert.deepEqual(standaloneMaterials(docs, configured).map(d => d.id), ['old']);
});

test('duplicate URLs are rendered once while separate URLs and original order are retained', () => {
  const docs = [
    document({ id: 'first', fileUrl: '/files/terms.pdf' }),
    document({ id: 'duplicate', fileUrl: '/files/terms.pdf' }),
    document({ id: 'second', fileUrl: '/files/calculator.html' }),
    document({ id: 'missing-url', fileUrl: '' }),
    document({ id: 'missing-url', fileUrl: '' }),
    document({ id: 'another-missing-url', fileUrl: '' }),
  ];
  assert.deepEqual(uniqueMaterials(docs).map(d => d.id), ['first', 'second', 'missing-url', 'another-missing-url']);
  assert.equal(docs.length, 6, 'deduplication must not mutate source data');
});

test('materials contact address is the broker mailbox requested by the owner', () => {
  assert.equal(MATERIALS_CONTACT_EMAIL, 'broker@stmichael.ru');
});

test('image extension detection handles uppercase names, query strings, and fragments', () => {
  for (const fileUrl of ['/files/COVER.JPG?download=1', '/files/render.WEBP#preview', '/files/image.HEIC', '/files/panorama.AVIF?token=x#cover']) {
    assert.equal(isMaterialImage(document({ fileUrl, type: 'FILE' })), true, fileUrl);
  }
  assert.equal(isMaterialImage(document({ fileUrl: '/files/opaque', type: 'image/jpeg' })), true);
  assert.equal(isMaterialImage(document({ fileUrl: '', name: 'Фото.PNG', type: 'FILE' })), true);
  assert.equal(isMaterialImage(document({ fileUrl: '/files/opaque', name: 'Фото.PNG', type: 'FILE' })), true);
  assert.equal(isMaterialImage(document({ fileUrl: '/files/report.pdf', type: 'FILE' })), false);
});

test('video extension detection handles uppercase names, query strings, and fragments', () => {
  for (const fileUrl of ['/files/TOUR.MOV?download=1', '/files/movie.MP4#preview', '/files/video.WEBM', '/files/video.M4V?token=x']) {
    assert.equal(isMaterialVideo(document({ fileUrl, type: 'FILE' })), true, fileUrl);
  }
  assert.equal(isMaterialVideo(document({ fileUrl: '/files/opaque', type: 'video/mp4' })), true);
  assert.equal(isMaterialVideo(document({ fileUrl: '', name: 'Видео.MKV', type: 'FILE' })), true);
  assert.equal(isMaterialVideo(document({ fileUrl: '/files/opaque', name: 'Видео.MKV', type: 'FILE' })), true);
  assert.equal(isMaterialVideo(document({ fileUrl: '/files/report.pdf', type: 'FILE' })), false);
});

test('PDF detection handles uppercase names, query strings, fragments, and MIME types', () => {
  for (const fileUrl of ['/files/OFFER.PDF?download=1', '/files/terms.pdf#page=2']) {
    assert.equal(isMaterialPdf(document({ fileUrl, type: 'FILE' })), true, fileUrl);
  }
  assert.equal(isMaterialPdf(document({ fileUrl: '/files/opaque', type: 'application/pdf' })), true);
  assert.equal(isMaterialPdf(document({ fileUrl: '', name: 'Презентация.PDF', type: 'FILE' })), true);
  assert.equal(isMaterialPdf(document({ fileUrl: '/files/opaque', name: 'Презентация.PDF', type: 'FILE' })), true);
  assert.equal(isMaterialPdf(document({ fileUrl: '/files/photo.jpg', type: 'FILE' })), false);
});
