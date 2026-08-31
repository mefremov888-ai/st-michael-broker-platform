/** Grid preview for local Yandex materials. Originals stay at /files/yandex/... */
export function materialsThumbUrl(fileUrl: string | null | undefined): string {
  const url = String(fileUrl || '');
  if (
    url.includes('storage.yandexcloud.net') ||
    url.includes('yandexcloud') ||
    url.includes('s3.ru-central1') ||
    url.includes('stmichael.ru/storage')
  ) {
    return `https://stmichael.ru/proxy/insecure/w:280/q:40/plain/${url}@webp`;
  }
  if (url.startsWith('/files/yandex/')) {
    return `${url.replace('/files/yandex/', '/files/yandex-thumbs/')}.thumb.jpg`;
  }
  return url;
}
