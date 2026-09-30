/**
 * 2026-09-30: выбор и проверка обложки новости stmichael.ru.
 *
 * Как устроена разметка сайта (снято с живого HTML 30.09.2026):
 *  - карточка в /news: `<img src="…w:960…">` у первых карточек, а ниже
 *    первого экрана — ленивая: `src="data:image/gif…"`, `data-src` —
 *    размытая заглушка (`w:400/…/bl:40`, ~1.5 КБ), настоящий кадр —
 *    в `data-lazy-srcset` (w:744/1023/640/960);
 *  - страница новости: og:image у ВСЕХ новостей один и тот же —
 *    https://stmichael.ru/images/logo.jpg (537×240, 4 КБ, на самом деле PNG),
 *    поэтому og:image берём только если это не логотип/заглушка и файл
 *    проходит проверку; фото лежат в слайдере MediaHeroSlider: `data-src`
 *    (`w:400/q:40/bl:60` — заглушка), `data-lazy-srcset` (прокси-варианты),
 *    `data-lazy-src` (оригинал на s3.twcstorage.ru — до 16 МБ, его не
 *    качаем, а строим прокси-адрес w:960). Ниже слайдера — карточки «другие
 *    новости» (`class="NewsCard_…"`) — их отрезаем.
 *
 * Почему у старых новостей были заглушки: до 14.09 парсер брал `data-src`
 * (размытая заглушка), 18.09 «зеркалирование» скачало эти заглушки к нам как
 * /files/landing/<hash>.webp (400×267, ~1 КБ), а где исходник умер — взяло
 * og:image со страницы новости, то есть логотип 537×240. Новости, ушедшие
 * с первой страницы /news, ежедневный синк больше не трогает, и заглушки
 * остались навсегда.
 */

/** Минимальный размер файла обложки; заглушки — 1–4 КБ, настоящие — от ~30 КБ. */
export const MIN_COVER_BYTES = 8 * 1024;
/** Минимальная ширина обложки; заглушки — 400 (bl:40) и 537 (логотип). */
export const MIN_COVER_WIDTH = 600;
/** Ширина, до которой кандидат считается «маленьким» и уходит в конец очереди. */
export const SMALL_WIDTH = 400;
/** Больше этого не скачиваем: оригиналы на s3 бывают по 16 МБ. */
export const MAX_COVER_BYTES = 6 * 1024 * 1024;

export const STM_PROXY = "https://stmichael.ru/proxy/";
const ALLOWED_HOSTS = ["stmichael.ru", "s3.twcstorage.ru", "storage.yandexcloud.net"];

export type CoverCandidate = {
  url: string;
  /** Ширина по srcset (`960w`) или по пути прокси (`/w:960/`); null — неизвестна. */
  width: number | null;
  /** Откуда взят адрес — для отчёта. */
  origin: "og" | "srcset" | "lazy-src" | "src" | "data-src" | "proxy-of-original";
  /** Признак заглушки: data:, bl:NN, placeholder/lqip/blur/thumb, логотип. */
  placeholder: boolean;
};

/** Заглушка ли это по адресу (без скачивания). */
export function isPlaceholderImageUrl(url: string): boolean {
  if (!url) return true;
  if (/^data:/i.test(url)) return true;
  if (/\/bl:\d+\//.test(url)) return true; // imgproxy blur
  if (/placeholder|lqip|blur|thumb/i.test(url)) return true;
  if (/\/images\/logo\.(?:jpe?g|png|webp|svg)(?:[?#]|$)/i.test(url)) return true;
  if (/logo\.(?:jpe?g|png|webp|svg)(?:[?#]|$)/i.test(url)) return true;
  return false;
}

export function widthFromUrl(url: string): number | null {
  const m = url.match(/\/w:(\d+)\//);
  return m ? Number(m[1]) : null;
}

function allowedHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return ALLOWED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

function isRawOriginal(url: string): boolean {
  return /^https:\/\/(?:s3\.twcstorage\.ru|storage\.yandexcloud\.net)\//i.test(url) && !url.startsWith(STM_PROXY);
}

/** Прокси-адрес w:960 для оригинала на s3 — так же строит сам сайт. */
export function proxyForOriginal(original: string, width = 960): string {
  return `${STM_PROXY}insecure/w:${width}/q:80/plain/${original}@webp`;
}

function decodeAttr(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

function parseSrcset(value: string): Array<{ url: string; width: number | null }> {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [url, descriptor] = part.split(/\s+/);
      const w = descriptor && /^\d+w$/.test(descriptor) ? Number(descriptor.slice(0, -1)) : null;
      return { url: decodeAttr(url || ""), width: w ?? widthFromUrl(url || "") };
    })
    .filter((c) => c.url);
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    out[m[1].toLowerCase()] = decodeAttr(m[2] ?? m[3] ?? "");
  }
  return out;
}

/**
 * Все кандидаты обложки из куска HTML (карточка списка или страница новости)
 * в порядке предпочтения: og:image страницы → самый широкий из
 * srcset/data-lazy-srcset → data-lazy-src/src/data-src → прокси для
 * оригинала s3. Маленькие (≤ 400) — в конце, заглушки — самыми последними.
 * Карточки «другие новости» (`class="NewsCard_…"`) на странице новости
 * не учитываются.
 */
export function collectStmCoverCandidates(html: string): CoverCandidate[] {
  const scope = html.split(/class="NewsCard_/)[0] || "";
  const seen = new Set<string>();
  const good: CoverCandidate[] = [];
  const small: CoverCandidate[] = [];
  const placeholders: CoverCandidate[] = [];

  const push = (url: string, width: number | null, origin: CoverCandidate["origin"]) => {
    if (!url || seen.has(url)) return;
    if (/^data:/i.test(url)) return; // 1-пиксельный gif ленивой загрузки — не картинка
    const placeholder = isPlaceholderImageUrl(url);
    if (!placeholder && !allowedHost(url)) return;
    seen.add(url);
    const candidate: CoverCandidate = { url, width: width ?? widthFromUrl(url), origin, placeholder };
    if (placeholder) placeholders.push(candidate);
    else if (candidate.width !== null && candidate.width <= SMALL_WIDTH) small.push(candidate);
    else good.push(candidate);
  };

  // 1) og:image — только со страницы новости (в карточке его нет)
  for (const m of html.matchAll(/<meta\s[^>]*property=["']og:image["'][^>]*>/gi)) {
    const a = attrs(m[0]);
    if (a.content) push(a.content, null, "og");
  }

  // 2) картинки по порядку тегов (первый слайд/карточка — главный), внутри
  //    тега — по ширине: srcset и src/data-src вместе, неизвестная ширина — после известных
  const tags = [...scope.matchAll(/<(?:img|source)\s[^>]*>/gi)].map((m) => m[0]);
  for (const tag of tags) {
    const a = attrs(tag);
    const entries: Array<{ url: string; width: number | null; origin: CoverCandidate["origin"] }> = [];
    const sets = [a["data-lazy-srcset"], a["srcset"], a["data-srcset"]].filter(Boolean) as string[];
    for (const c of sets.flatMap(parseSrcset)) entries.push({ ...c, origin: "srcset" });
    const singles: Array<[string | undefined, CoverCandidate["origin"]]> = [
      [a["data-lazy-src"], "lazy-src"],
      [a["src"], "src"],
      [a["data-src"], "data-src"],
    ];
    for (const [url, origin] of singles) {
      if (!url) continue;
      if (isRawOriginal(url)) {
        // оригинал на s3 бывает 16 МБ — сначала его прокси-копия w:960, сам оригинал — на крайний случай
        entries.push({ url: proxyForOriginal(url), width: 960, origin: "proxy-of-original" });
      }
      entries.push({ url, width: widthFromUrl(url), origin });
    }
    const known = entries.filter((e) => e.width !== null).sort((x, y) => (y.width as number) - (x.width as number));
    const unknown = entries.filter((e) => e.width === null);
    for (const e of [...known, ...unknown]) push(e.url, e.width, e.origin);
  }

  return [...good, ...small, ...placeholders];
}

/** Первый адрес обложки без скачивания (заглушка — только если больше ничего нет). */
export function pickStmCoverUrl(html: string): string | null {
  const candidates = collectStmCoverCandidates(html);
  return candidates[0]?.url ?? null;
}

export type ImageInfo = { width: number; height: number; format: "jpg" | "png" | "webp" | "gif" };

/** Размер картинки по заголовку файла (jpeg/png/webp/gif); null — не картинка/не разобрали. */
export function imageDimensions(buf: Buffer): ImageInfo | null {
  if (!buf || buf.length < 12) return null;
  // PNG
  if (buf[0] === 0x89 && buf.slice(1, 4).toString("latin1") === "PNG" && buf.length >= 24) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), format: "png" };
  }
  // GIF
  if (buf.slice(0, 3).toString("latin1") === "GIF" && buf.length >= 10) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), format: "gif" };
  }
  // WebP
  if (buf.slice(0, 4).toString("latin1") === "RIFF" && buf.slice(8, 12).toString("latin1") === "WEBP") {
    const chunk = buf.slice(12, 16).toString("latin1");
    if (chunk === "VP8X" && buf.length >= 30) {
      return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3), format: "webp" };
    }
    if (chunk === "VP8L" && buf.length >= 25) {
      const bits = buf.readUInt32LE(21);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff), format: "webp" };
    }
    if (chunk === "VP8 " && buf.length >= 30) {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, format: "webp" };
    }
    return null;
  }
  // JPEG: ищем SOFn
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), format: "jpg" };
      }
      if (marker === 0xd9 || marker === 0xda) break;
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) break;
      i += 2 + len;
    }
    return null;
  }
  return null;
}

export type CoverCheck = {
  ok: boolean;
  reason: string | null;
  bytes: number;
  width: number | null;
  height: number | null;
  format: ImageInfo["format"] | null;
};

/** Проверка скачанного файла: настоящая обложка или заглушка. */
export function checkCoverFile(buf: Buffer | null | undefined): CoverCheck {
  const bytes = buf?.length ?? 0;
  if (!buf || !bytes) return { ok: false, reason: "пустой файл", bytes: 0, width: null, height: null, format: null };
  const info = imageDimensions(buf);
  if (!info) return { ok: false, reason: "не картинка", bytes, width: null, height: null, format: null };
  const base = { bytes, width: info.width, height: info.height, format: info.format };
  if (bytes < MIN_COVER_BYTES) return { ok: false, reason: `файл ${Math.round(bytes / 1024)} КБ < ${MIN_COVER_BYTES / 1024} КБ`, ...base };
  if (info.width < MIN_COVER_WIDTH) return { ok: false, reason: `ширина ${info.width} < ${MIN_COVER_WIDTH}`, ...base };
  if (bytes > MAX_COVER_BYTES) return { ok: false, reason: `файл ${Math.round(bytes / 1024 / 1024)} МБ — слишком большой`, ...base };
  return { ok: true, reason: null, ...base };
}

export function extensionFor(format: ImageInfo["format"] | null): string {
  return format === "png" ? ".png" : format === "webp" ? ".webp" : format === "gif" ? ".gif" : ".jpg";
}

export type ResolvedCover = {
  url: string;
  buf: Buffer;
  ext: string;
  check: CoverCheck;
  origin: CoverCandidate["origin"];
  tried: Array<{ url: string; reason: string }>;
};

/**
 * Идём по кандидатам, качаем и проверяем; заглушки по адресу пропускаем.
 * Возвращает первый прошедший проверку файл либо null (в `tried` — почему
 * отвергли остальных).
 */
export async function resolveStmCover(
  candidates: CoverCandidate[],
  download: (url: string) => Promise<Buffer>,
  maxTries = 6,
): Promise<ResolvedCover | null> {
  const tried: Array<{ url: string; reason: string }> = [];
  let attempts = 0;
  for (const c of candidates) {
    if (c.placeholder) {
      tried.push({ url: c.url, reason: "заглушка по адресу" });
      continue;
    }
    if (attempts >= maxTries) break;
    attempts++;
    let buf: Buffer;
    try {
      buf = await download(c.url);
    } catch (e: any) {
      tried.push({ url: c.url, reason: `не скачалось: ${e?.message || e}` });
      continue;
    }
    const check = checkCoverFile(buf);
    if (!check.ok) {
      tried.push({ url: c.url, reason: check.reason || "не прошла проверку" });
      continue;
    }
    return { url: c.url, buf, ext: extensionFor(check.format), check, origin: c.origin, tried };
  }
  return null;
}
