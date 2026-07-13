/**
 * Pure-функции для импорта брокеров из табличного источника
 * (XLSX через админку, Google Sheets через workflow, и т.д.).
 *
 * Все pure — никаких Prisma/HTTP/FS зависимостей.
 * TZ v3 §2.11 (нормализация телефонов), §3 (импорт), §5 (схема Broker/CallLog).
 *
 * Зеркало scripts/_lib/brokers-import.js — пока намеренно дублирую логику
 * (TS-источник истины здесь, JS остаётся для CLI-скриптов). При изменении
 * правил — синхронизировать оба файла.
 */

export type BrokerCategoryCode =
  | 'COLD'
  | 'WARM'
  | 'HOT'
  | 'CONVERTED'
  | 'ON_BOT_REVIEW'
  | 'BLACKLIST';

export type CallResultCode =
  | 'NDZ'
  | 'DOUBLE_NDZ'
  | 'INFORMED'
  | 'ALREADY_KNOWS'
  | 'WRONG_NUMBER'
  | 'REFUSED_COMMUNICATION'
  | 'NOT_A_BROKER'
  | 'SCHEDULED_TOUR'
  | 'ONLY_SEND_INFO'
  | 'IN_PROGRESS'
  | 'REFUSED_TOUR'
  | 'HUNG_UP'
  | 'NOT_RELEVANT'
  | 'NOT_BROKER_ANYMORE'
  | 'ASKED_NOT_TO_CALL'
  | 'NEGATIVE';

export const VALID_CATEGORIES: BrokerCategoryCode[] = [
  'COLD', 'WARM', 'HOT', 'CONVERTED', 'ON_BOT_REVIEW', 'BLACKLIST',
];
export const VALID_CALL_FLAGS = ['да', 'в работе', 'обработан'] as const;
export type CallFlag = (typeof VALID_CALL_FLAGS)[number];

export interface NormalizedPhone {
  ok: boolean;
  phone?: string;
  reason?: 'empty' | 'too_short' | 'truncated_77';
  raw?: string;
  foreign?: boolean;
}

export function normalizePhone(input: unknown): NormalizedPhone {
  if (input === null || input === undefined || input === '') {
    return { ok: false, reason: 'empty' };
  }
  const digits = String(input).replace(/\D/g, '');
  const n = digits.length;
  if (n < 10) return { ok: false, reason: 'too_short', raw: digits };
  if (n === 10) return { ok: true, phone: '+7' + digits };
  if (n === 11) {
    if (digits[0] === '7' && digits[1] === '7') {
      return { ok: false, reason: 'truncated_77', raw: digits };
    }
    if (digits[0] === '7') return { ok: true, phone: '+' + digits };
    if (digits[0] === '8') return { ok: true, phone: '+7' + digits.slice(1) };
    return { ok: true, phone: '+' + digits, foreign: true };
  }
  if (n === 12) {
    if (digits.startsWith('77')) return { ok: true, phone: '+' + digits.slice(1) };
    return { ok: true, phone: '+' + digits, foreign: true };
  }
  return { ok: true, phone: '+' + digits, foreign: true };
}

// 2026-06-29: helper для поиска по телефону в Prisma where-OR.
// Принимает search-строку, возвращает массив условий для добавления в OR.
// Логика:
//   - Если в search есть цифры → нормализуем до +7XXX и добавляем точное
//     совпадение. Это покрывает кейсы "8925...", "+7925...", "7 925..."
//     — все находят брокера с phone "+79255724188".
//   - Дополнительно — частичный поиск по цифровой части (на случай если
//     ввели только последние 7+ цифр номера без префикса, например
//     "5724188" — должен найти "+79255724188").
// Если в search цифр нет (или их меньше 4) — возвращает пустой массив.
export function buildPhoneSearchConditions(search: string): Array<{ phone: string | { contains: string } }> {
  const trimmed = String(search || '').trim();
  if (!trimmed) return [];
  const hasDigit = /\d/.test(trimmed);
  if (!hasDigit) return [];
  const conditions: Array<{ phone: string | { contains: string } }> = [];
  const norm = normalizePhone(trimmed);
  if (norm.ok && norm.phone) {
    conditions.push({ phone: norm.phone });
  }
  const digitsOnly = trimmed.replace(/\D/g, '');
  if (digitsOnly.length >= 4) {
    conditions.push({ phone: { contains: digitsOnly } });
    // 2026-06-29 patch: частичный ввод с префиксом 8 (например «8912»).
    // normalizePhone не нормализует короткие строки (<10 цифр), а в БД
    // номер хранится как +79XXX — `contains "8912"` не найдёт `+79124557274`.
    // Поэтому если ввод начинается с 8 и длина < 11 — добавляем поиск с
    // префиксом 7 (заменив первую цифру). Это покрывает кейс «начал
    // вводить с привычной восьмёрки».
    if (digitsOnly[0] === '8' && digitsOnly.length < 11) {
      conditions.push({ phone: { contains: '7' + digitsOnly.slice(1) } });
    }
  }
  return conditions;
}

export const RESULT_MAP: Record<string, { category: BrokerCategoryCode; result: CallResultCode | null }> = {
  'НДЗ': { category: 'COLD', result: 'NDZ' },
  '2 НДЗ': { category: 'ON_BOT_REVIEW', result: 'DOUBLE_NDZ' },
  'Проинформирован о новых условиях': { category: 'WARM', result: 'INFORMED' },
  'Уже был, на ТГ подписан': { category: 'WARM', result: 'ALREADY_KNOWS' },
  'Некорректный номер': { category: 'BLACKLIST', result: 'WRONG_NUMBER' },
  'Отказ от коммуникации': { category: 'ON_BOT_REVIEW', result: 'REFUSED_COMMUNICATION' },
  'НЕ брокер': { category: 'BLACKLIST', result: 'NOT_A_BROKER' },
  'Запись на БТ': { category: 'HOT', result: 'SCHEDULED_TOUR' },
  'Только отправить инфо': { category: 'WARM', result: 'ONLY_SEND_INFO' },
  'В работе': { category: 'HOT', result: 'IN_PROGRESS' },
  'Отказ от БТ': { category: 'WARM', result: 'REFUSED_TOUR' },
};

export const ZORGE_MAP: Record<string, CallResultCode> = {
  'НДЗ': 'NDZ',
  'Проинформирован': 'INFORMED',
  'Бросил трубку': 'HUNG_UP',
  'неактуально/не интересно': 'NOT_RELEVANT',
  'Только отправить инфо': 'ONLY_SEND_INFO',
  'Запись на БТ': 'SCHEDULED_TOUR',
  'Некорректный номер': 'WRONG_NUMBER',
  'уже не брокер': 'NOT_BROKER_ANYMORE',
  'Просил не звонить': 'ASKED_NOT_TO_CALL',
  'Негатив на звонок': 'NEGATIVE',
};

export interface MappedRow {
  name: string;
  phoneRaw: unknown;
  callFlag: string;
  category: BrokerCategoryCode;
  callResult: CallResultCode | null;
  zorgeResult: CallResultCode | null;
  comment: string | null;
  doNotCall: boolean;
  resultStr: string;
  zorgeStr: string;
  // 2026-07-06: специализация из комментария. Если в комментарии
  // (или в поле «Результат», или в имени) встречается коммерческий
  // маркер — ставим 'COMM'. Иначе null (residential/both уточним позже).
  specialization: 'COMM' | 'RESIDENTIAL' | 'BOTH' | null;
  // 2026-07-09: региональный признак — КЦ в комментариях пишет что
  // брокер из региона. Отдельно от specialization: региональный может
  // быть коммерческим или жилым — это разные оси.
  isRegional: boolean;
}

// 2026-07-06: паттерн для распознавания «коммерческого» брокера в тексте.
// Проверяется на комментарии, имени, поле «Результат». Одного вхождения
// достаточно чтобы пометить брокера как COMM. Слова в нижнем регистре
// (мы приводим текст к lower перед проверкой).
const COMM_KEYWORDS = /(комм(?:ерц|\.|ерческ)|komm|commercial|офис|склад|торгов|нежил|ритейл|retail)/i;
// 2026-07-09: региональный брокер. Ключевые слова: «региональ», «регион»,
// «из региона», «регионал». Плюс — фразы про конкретный город часто
// сопровождаются словом «регион», поэтому названия городов НЕ парсим —
// оставляем это как отдельный признак без географической детализации.
const REGIONAL_KEYWORDS = /(регион(?:аль|ы|а|)?|из\s+регион|региональ)/i;

export function detectSpecialization(...sources: (string | null | undefined)[]): 'COMM' | null {
  for (const s of sources) {
    if (s && COMM_KEYWORDS.test(String(s))) return 'COMM';
  }
  return null;
}

export function detectRegional(...sources: (string | null | undefined)[]): boolean {
  for (const s of sources) {
    if (s && REGIONAL_KEYWORDS.test(String(s))) return true;
  }
  return false;
}

export function mapRow(row: Record<string, unknown>): MappedRow {
  const name = (row['Имя'] ?? '').toString().trim();
  const phoneRaw = (row as any)['Телефон брокера'] ?? (row as any)['Телефон'];
  const meetings = Number((row as any)['Встречи'] || 0);
  const deals = Number((row as any)['Сделки'] || 0);
  const callFlag = ((row as any)['ЗВОНОК'] || '').toString().trim().toLowerCase();
  const resultStr = ((row as any)['Результат звонка'] || '').toString().trim();
  const zorgeStr = ((row as any)['Обзвон по Зорге '] || (row as any)['Обзвон по Зорге'] || '').toString().trim();
  const comment = ((row as any)['Комментарий'] || '').toString().trim() || null;

  const mapped = RESULT_MAP[resultStr] || { category: 'COLD' as BrokerCategoryCode, result: null };
  const zorgeResult = ZORGE_MAP[zorgeStr] || null;

  let category: BrokerCategoryCode = mapped.category;
  if (deals > 0 || meetings > 0) category = 'CONVERTED';

  const doNotCall =
    (['BLACKLIST', 'ON_BOT_REVIEW'] as BrokerCategoryCode[]).includes(category) ||
    resultStr === 'Отказ от коммуникации' ||
    zorgeStr === 'Просил не звонить';

  const specialization = detectSpecialization(comment, name, resultStr, zorgeStr);
  const isRegional = detectRegional(comment, name, resultStr, zorgeStr);

  return { name, phoneRaw, callFlag, category, callResult: mapped.result, zorgeResult, comment, doNotCall, resultStr, zorgeStr, specialization, isRegional };
}

export interface Candidate extends MappedRow {
  phone: string;
  foreign: boolean;
}

export interface ParseStats {
  total: number;
  invalidPhone: number;
  duplicatesInSheet: number;
  duplicatesMerged: number;
  byCategory: Record<string, number>;
  byCallFlag: Record<string, number>;
  unknownResults: Record<string, number>;
  unknownZorge: Record<string, number>;
}

export interface ParseResult {
  candidates: Candidate[];
  stats: ParseStats;
}

// Ранг категорий для мерджа дублей: чем выше — тем ценнее, побеждает в мердже.
// CONVERTED самый ценный (был на встрече/сделке — факт),
// HOT > WARM > COLD — по активности воронки,
// ON_BOT_REVIEW > BLACKLIST в самом низу (проблемные).
const CATEGORY_RANK: Record<BrokerCategoryCode, number> = {
  CONVERTED: 6,
  HOT: 5,
  WARM: 4,
  COLD: 3,
  ON_BOT_REVIEW: 2,
  BLACKLIST: 1,
};

function pickBetterCategory(a: BrokerCategoryCode, b: BrokerCategoryCode): BrokerCategoryCode {
  return CATEGORY_RANK[a] >= CATEGORY_RANK[b] ? a : b;
}

function mergeCandidates(a: Candidate, b: Candidate): Candidate {
  // Текстовые поля: первое непустое выигрывает.
  // doNotCall: OR — если ХОТЯ БЫ в одной строке указано "не звонить", не звоним
  //   (безопаснее терять одну попытку, чем нарушить запрет).
  // category: по рангу — берём более ценную.
  // resultStr/callResult/zorgeStr/zorgeResult: берём ту строку, где они заполнены.
  const merge = <T,>(x: T, y: T): T => (x ? x : y);
  return {
    name: merge(a.name, b.name),
    phoneRaw: a.phoneRaw,
    phone: a.phone,
    foreign: a.foreign || b.foreign,
    callFlag: merge(a.callFlag, b.callFlag),
    category: pickBetterCategory(a.category, b.category),
    callResult: a.callResult || b.callResult,
    zorgeResult: a.zorgeResult || b.zorgeResult,
    comment: a.comment && b.comment && a.comment !== b.comment
      ? `${a.comment} | ${b.comment}`
      : (a.comment || b.comment),
    doNotCall: a.doNotCall || b.doNotCall,
    resultStr: merge(a.resultStr, b.resultStr),
    zorgeStr: merge(a.zorgeStr, b.zorgeStr),
    // 2026-07-06: специализация — если хотя бы одна из строк дубля COMM, ставим COMM.
    specialization: a.specialization || b.specialization,
    // 2026-07-09: региональный — OR по дублям (одна строка сказала регион → регионал).
    isRegional: a.isRegional || b.isRegional,
  };
}

export function parseAndFilter(
  rows: Record<string, unknown>[],
  opts: {
    filter: Set<BrokerCategoryCode>;
    callFlagFilter: Set<string> | null;
    limit: number | null;
  },
): ParseResult {
  const stats: ParseStats = {
    total: rows.length,
    invalidPhone: 0,
    duplicatesInSheet: 0,
    duplicatesMerged: 0,
    byCategory: {},
    byCallFlag: {},
    unknownResults: {},
    unknownZorge: {},
  };
  const phoneIndex = new Map<string, number>(); // phone → index в allValid
  const allValid: Candidate[] = [];

  for (const row of rows) {
    const m = mapRow(row);
    const norm = normalizePhone(m.phoneRaw);
    if (!norm.ok) {
      stats.invalidPhone++;
      continue;
    }
    // Собираем нераспознанные значения, чтобы пользователь увидел опечатки
    // в исходной таблице и понял почему часть данных уехала в дефолтный COLD.
    if (m.resultStr && !RESULT_MAP[m.resultStr]) {
      stats.unknownResults[m.resultStr] = (stats.unknownResults[m.resultStr] || 0) + 1;
    }
    if (m.zorgeStr && !ZORGE_MAP[m.zorgeStr]) {
      stats.unknownZorge[m.zorgeStr] = (stats.unknownZorge[m.zorgeStr] || 0) + 1;
    }

    stats.byCategory[m.category] = (stats.byCategory[m.category] || 0) + 1;
    const cfKey = m.callFlag || '(пусто)';
    stats.byCallFlag[cfKey] = (stats.byCallFlag[cfKey] || 0) + 1;

    const newCand: Candidate = { ...m, phone: norm.phone!, foreign: !!norm.foreign };

    if (phoneIndex.has(norm.phone!)) {
      stats.duplicatesInSheet++;
      // Мердж — не отбрасываем, склеиваем лучшую информацию из обеих строк
      const idx = phoneIndex.get(norm.phone!)!;
      const before = allValid[idx];
      const merged = mergeCandidates(before, newCand);
      // Если мердж реально изменил данные — считаем это полезным мерджем
      if (
        merged.category !== before.category ||
        merged.callResult !== before.callResult ||
        merged.zorgeResult !== before.zorgeResult ||
        merged.comment !== before.comment
      ) {
        stats.duplicatesMerged++;
      }
      allValid[idx] = merged;
      continue;
    }
    phoneIndex.set(norm.phone!, allValid.length);
    allValid.push(newCand);
  }

  let candidates = allValid.filter((c) => opts.filter.has(c.category));
  if (opts.callFlagFilter) {
    candidates = candidates.filter((c) => opts.callFlagFilter!.has(c.callFlag));
  }
  if (opts.limit) candidates = candidates.slice(0, opts.limit);

  return { candidates, stats };
}

export interface CoordRow {
  phoneRaw: unknown;
  name: string;
  agency: string | null;
}

export function mapCoordRow(row: Record<string, unknown>): CoordRow {
  const phoneRaw = (row as any)['Номер '] ?? (row as any)['Номер'];
  const name = ((row as any)['Имя'] || '').toString().trim() || '(координатор)';
  const agency = ((row as any)['Агенство'] || '').toString().trim() || null;
  return { phoneRaw, name, agency };
}
