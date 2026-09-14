/**
 * 2026-09-14: разбор колонки «выплачено» из Google-листа сделок.
 *
 * В ячейку писали руками и по-разному: 29 написаний на 297 заполненных
 * строк. Чаще всего «да», но встречается «оплачено», «нет», «Да», и —
 * самое ценное — строки вида «669 138 да» и «743 477,94 да», где рядом со
 * словом дописана фактически выплаченная сумма. Бывает и несколько сумм:
 * «оплачен 623360,72 648804,2».
 *
 * Правила:
 *   - признак выплаты берём по слову: «да», «оплачен(о/а)», «выплач…» → да;
 *     «нет», «не оплач…» → нет; ничего не распознали → null (не знаем);
 *   - сумму берём, если в ячейке есть число; при нескольких числах берём
 *     наибольшее — практика листа: сначала пишут начисленное, потом итог;
 *   - исходный текст всегда сохраняем как есть, ничего не «чиним».
 */
export interface CommissionPaidParsed {
  /** true — выплачено, false — явно не выплачено, null — не понять */
  paid: boolean | null;
  /** сумма из ячейки, если она там есть */
  amount: number | null;
  /** исходный текст без изменений */
  raw: string | null;
}

// ВАЖНО: \w в JavaScript — это только латиница и цифры, кириллицу он не
// ловит. Поэтому окончания слов описываем через \p{L}.
const YES = /(^|[\s,;])(да|оплач\p{L}*|выплач\p{L}*|перечисл\p{L}*)([\s,;]|$)/iu;
const NO = /(^|[\s,;])(нет|не\s+оплач\p{L}*|не\s+выплач\p{L}*)([\s,;]|$)/iu;

export function parseCommissionPaid(raw: unknown): CommissionPaidParsed {
  const text = raw === null || raw === undefined ? "" : String(raw).trim();
  if (!text) return { paid: null, amount: null, raw: null };

  // «нет» проверяем первым: «не оплачено» содержит и «оплач…»
  const paid = NO.test(text) ? false : YES.test(text) ? true : null;

  // числа: «669 138», «743 477,94», «623360.72»
  const numbers: number[] = [];
  for (const m of text.matchAll(/\d[\d\s ]*(?:[.,]\d+)?/g)) {
    const value = Number(m[0].replace(/[\s ]/g, "").replace(",", "."));
    if (Number.isFinite(value) && value > 0) numbers.push(value);
  }
  const amount = numbers.length ? Math.max(...numbers) : null;

  return { paid, amount, raw: text };
}
