import { pickStmNewsImage } from "./cms.service";

/**
 * 2026-09-14 (жалоба владельца «не загружаются картинки»): карточки новостей
 * ниже первого экрана грузятся на stmichael.ru лениво. В теге картинки два
 * адреса: data-src — размытая заглушка на ~1 КБ (в пути bl:40), а настоящее
 * фото — в data-lazy-srcset. Парсер брал первый попавшийся и сохранял
 * заглушку: первые карточки выглядели нормально, остальные — размытыми.
 */
describe("картинка новости: берём фото, а не размытую заглушку", () => {
  const blurred = "https://stmichael.ru/proxy/bl:40/w:32/q:30/aHR0cHM6Lz.jpg";
  const small = "https://stmichael.ru/proxy/w:320/q:80/aHR0cHM6Lz.jpg";
  const big = "https://stmichael.ru/proxy/w:960/q:80/aHR0cHM6Lz.jpg";

  it("ленивая карточка: берём полноразмерный кадр, а не заглушку", () => {
    const body = `<img data-src="${blurred}" data-lazy-srcset="${small} 320w, ${big} 960w" />`;
    expect(pickStmNewsImage(body)).toBe(big);
  });

  it("обычная карточка без ленивой загрузки: берём src", () => {
    const body = `<img src="${big}" />`;
    expect(pickStmNewsImage(body)).toBe(big);
  });

  it("в ленивом наборе только размытое — берём чёткое из data-src", () => {
    const body = `<img data-src="${big}" data-lazy-srcset="${blurred} 32w" />`;
    expect(pickStmNewsImage(body)).toBe(big);
  });

  it("ничего чёткого нет — лучше заглушка, чем пустое место", () => {
    const body = `<img data-src="${blurred}" />`;
    expect(pickStmNewsImage(body)).toBe(blurred);
  });

  it("картинки нет вовсе", () => {
    expect(pickStmNewsImage("<div>без картинки</div>")).toBeNull();
  });

  it("чужие домены не подходят", () => {
    const body = `<img src="https://example.com/proxy/w:960/q:80/x.jpg" />`;
    expect(pickStmNewsImage(body)).toBeNull();
  });
});
