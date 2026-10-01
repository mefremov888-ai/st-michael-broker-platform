import { BadRequestException, Injectable, Inject, Logger, NotFoundException, Optional, ServiceUnavailableException } from "@nestjs/common";
import { PrismaClient } from "@st-michael/database";
import {
  AmoCrmAdapter,
  MorekitAdapter,
  morekitPhone,
  morekitLeadDate,
} from "@st-michael/integrations";
import { getSystemSetting } from "../common/system-setting";
import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import {
  CoverCandidate,
  checkCoverFile,
  collectStmCoverCandidates,
  pickStmCoverUrl,
  resolveStmCover,
} from "./stm-news-cover";
import { TelegramNewsService } from "../telegram-news/telegram-news.service";
import { OpsAlertService, opsAlertTime } from "../ops-alert/ops-alert.service";
import {
  acquireAmoBrokerContactAdvisoryXactLock,
  armDurableAmoBrokerContactCreateGate,
  getUnresolvedAmoBrokerContactCreateGate,
  isAmoBrokerContact,
  isDefinitiveAmoContactCreateRejection,
  normalizeAmoBrokerContactLockPhone,
  reconcileExactAmoBrokerContact,
  recordResolvedAmoBrokerContactCreate,
} from "../common/amo-broker-contact-lock";
import {
  COMMISSION_RATES,
  LEVEL_THRESHOLDS_BY_PROJECT,
  paymentTermsForPolicy,
  rateFor,
} from "../commission/commission.service";

const KNOWN_KEYS = [
  "hero",
  "advantages",
  "commission",
  "contact",
  "howto",
  "projectsSection",
  "cooperation",
] as const;

const DEFAULT_CONTENT: Record<string, any> = {
  hero: {
    tag: "Партнёрская программа",
    title: "Доход растёт вместе с объёмом продаж агентства",
    titleAccent: "продаж агентства",
    description:
      "Актуальная комиссия: {{commission.ZORGE9.range}} по Зорге 9 и {{commission.SILVER_BOR.range}} по Серебряному Бору.",
    stats: [
      {
        number: "{{commission.ZORGE9.max}}",
        label: "Максимальная ставка по Зорге 9",
      },
      { number: "7 дней", label: "Выплата вознаграждения" },
      { number: "30 дней", label: "Срок уникальности клиента" },
      { number: "2", label: "Активных проекта" },
    ],
  },
  advantages: {
    tag: "Преимущества",
    title: "Шесть причин, ради которых брокеры остаются с St Michael",
    titleAccent: "St Michael",
    subtitle:
      "Мы выстроили сотрудничество так, чтобы вы могли начать работать сразу — с первой сделки и с первого дня существования вашего ИП. Без дополнительных условий.",
    items: [
      {
        icon: "headphones",
        title: "Выделенный отдел партнёров",
        description: "Сопровождение на всех этапах сделки.",
      },
      {
        icon: "shield",
        title: "Защищаем брокера от увода клиента",
        description:
          "С клиентами, которые пришли через вас, мы не работаем напрямую.",
      },
      {
        icon: "wallet",
        title: "Быстрые выплаты",
        description: "Вознаграждение — до 7 рабочих дней.",
      },
      {
        icon: "trending-up",
        title: "Высокая комиссия",
        description:
          "По КСБ — {{commission.SILVER_BOR.range}} за сделку, по Зорге 9 — {{commission.ZORGE9.range}}. Плюс квартальный и годовой бонусы.",
      },
      {
        icon: "sparkles",
        title: "Не цепляемся за формальности",
        description:
          "Регламент уникальности у нас гибче, чем у большинства застройщиков. Подтверждаем работу с клиентом, даже когда другие отказали бы.",
      },
      {
        icon: "graduation-cap",
        title: "Обучение",
        description: "Брокер-туры для быстрого старта продаж.",
      },
    ],
  },
  howto: {
    tag: "Старт",
    title: "Как начать сотрудничать с ST Michael",
    titleAccent: "ST Michael",
    subtitle:
      "Начать можно с первой же сделки — даже если ваше ИП открыто вчера. Никаких дополнительных условий.",
    steps: [
      {
        num: "01",
        title: "Проверка на уникальность",
        description: "Проверьте клиента в кабинете перед сделкой.",
      },
      {
        num: "02",
        title: "Встреча в офисе продаж",
        description: "Запишите клиента на встречу в офис продаж.",
      },
      {
        num: "03",
        title: "Фиксация клиента",
        description:
          "После встречи клиент закреплён за вами на 30 дней — при необходимости можем продлить.",
      },
      {
        num: "04",
        title: "Сделка и выплата",
        description:
          "После оплаты клиентом — вознаграждение приходит за 7 рабочих дней.",
      },
    ],
    footer: "Агентский договор оформляется при первой сделке",
    ctaText: "Стать партнёром",
  },
  projectsSection: {
    tag: "Проекты",
    title: "Наши проекты",
    titleAccent: "Наши проекты",
    subtitle: "",
  },
  // 2026-06-01: блок «Условия сотрудничества» — раньше был захардкожен в LandingClient.tsx
  cooperation: {
    tag: "Условия сотрудничества",
    title: "Всё прозрачно — документы",
    titleAccent: "документы",
    subtitle:
      "Брокер может заранее ознакомиться с условиями партнёрства до регистрации",
    description:
      "Мы рассматриваем сотрудничество с позиции «выиграл-выиграл». Все условия зафиксированы в документах и доступны в личном кабинете.",
    ctaText: "Стать партнёром",
  },
  commission: {
    tag: "Комиссия и условия выплаты",
    title: "Условия вознаграждения",
    titleAccent: "вознаграждения",
    subtitle:
      "Актуальная ставка, шкала и условия оплаты задаются одной политикой для каждого проекта.",
    // 2026-05-26: возвращён «Квартальный бонус» (был ксенин текст КБ4).
    cards: [
      {
        title: "Условия выплаты",
        text: "Вознаграждение выплачивается в течение 7 рабочих дней после оплаты клиентом. ПВ ≥ 50% (Зорге 9) или ≥ 30% (Серебряный Бор) — единовременно.",
      },
      {
        title: "Квартальный бонус",
        text: "При уровне Strong+ несколько кварталов подряд: +0,1% → +0,15% → +0,2% → +0,25% (максимум). Обнуляется при отсутствии продаж в квартале.",
      },
      {
        title: "Бонус за скорость",
        text: "+0,1% к ставке, если от заявки клиента до платной брони проходит не более 10 рабочих дней. Действует на оба проекта.",
      },
      {
        title: "Годовой бонус",
        text: "100 000 ₽ + памятный кубок за минимум одну сделку раз в 2 месяца в течение года.",
      },
      {
        title: "Коммерческие помещения",
        text: "Продажа: помещения и фитнес — 3%, отдельно стоящие здания — 2%. Аренда: ритейл — 100% мес. платежа, фитнес/офис — 50%.",
      },
      {
        title: "Реферальная программа",
        text: "Дополнительное вознаграждение за привлечение новых партнёров в программу.",
      },
    ],
  },
  contact: {
    tag: "Команда",
    title: "Всегда на связи",
    titleAccent: "на связи",
    description:
      "В наши бизнес-процессы заложена тесная коммуникация с партнёрами. Горячая линия по работе с партнёрами работает каждый день с 9:00 до 21:00.",
    blockTitle: "Горячая линия по работе с партнёрами",
    phone: "+7 (499) 226-22-49",
    phoneHours: "Ежедневно с 9:00 до 21:00",
    email: "info@zorge9.com",
    telegram: "https://t.me/stmichaelBroker",
    // 2026-09-17 (владелец): Ксения Цепляева больше не работает. Персональный
    // контакт — Дарья Великанова; общий телефон отдела остаётся прежним.
    manager: {
      name: "Дарья Великанова",
      role: "Менеджер по работе с брокерами",
      phone: "+7 (930) 012-94-52",
    },
    managers: [
      {
        name: "Дарья Великанова",
        role: "Менеджер по работе с брокерами",
        phone: "+7 (930) 012-94-52",
      },
    ],
  },
};


/**
 * 2026-09-14: выбирает НАСТОЯЩУЮ фотографию новости из разметки
 * stmichael.ru. Возвращает null, если картинки нет вовсе.
 *
 * 2026-09-30: логика вынесена в ./stm-news-cover (og:image → самый широкий
 * srcset → src; заглушки bl:NN/placeholder/логотип — в самом конце).
 */
export function pickStmNewsImage(body: string): string | null {
  return pickStmCoverUrl(body);
}

/** RSA-цепочка для обхода просроченного ECDSA-сертификата stmichael.ru (см. fetchStmNewsHtml). */
const STM_RSA_SIGALGS =
  "rsa_pss_rsae_sha256:rsa_pkcs1_sha256:rsa_pss_rsae_sha384:rsa_pkcs1_sha384:rsa_pss_rsae_sha512:rsa_pkcs1_sha512";

/** Папка загрузок (читается при вызове, чтобы тесты могли подменить). */
export function uploadsRoot(): string {
  return process.env.UPLOADS_DIR || "/app/uploads";
}
/** Обложки новостей сайта лежат в /app/uploads/landing и раздаются как /files/landing/… */
export const LANDING_COVER_DIR = "landing";
export const LANDING_COVER_PUBLIC_PREFIX = "/files/landing";

/** Локальный путь к файлу обложки по публичной ссылке; null — ссылка не наша. */
export function localCoverPath(imageUrl: string | null | undefined): string | null {
  if (!imageUrl) return null;
  const m = String(imageUrl).match(/^\/(?:files|uploads)\/landing\/([^/?#]+)$/);
  if (!m) return null;
  return join(uploadsRoot(), LANDING_COVER_DIR, m[1]);
}

/** Имя файла по содержимому — одинаковая картинка не скачивается дважды. */
export function coverFileName(buf: Buffer, ext: string): string {
  return createHash("sha1").update(buf).digest("hex").slice(0, 16) + ext;
}

/** Сколько новостей отдаёт публичный endpoint по умолчанию и максимум (?limit=). */
export const PUBLIC_NEWS_LIMIT = 20;
/** Сколько карточек снимаем со страницы stmichael.ru/news за один синк. */
export const STM_NEWS_PARSE_LIMIT = 20;

export function clampPublicNewsLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return PUBLIC_NEWS_LIMIT;
  return Math.min(Math.floor(n), PUBLIC_NEWS_LIMIT);
}

export const NEWS_MODERATION_STATUSES = ["PENDING", "APPROVED", "REJECTED"] as const;
export type NewsModerationStatus = (typeof NEWS_MODERATION_STATUSES)[number];

/**
 * 2026-09-30: единая лента публичных новостей — Telegram-посты и карточки
 * сайта вместе, по дате (свежие выше). В один и тот же день Telegram идёт
 * первым, дальше — по точному времени, затем sortOrder. Правило «≥ 4 Telegram
 * → сайт не показываем» (29.09) убрано по решению владельца.
 */
export function orderPublicNews<T extends { source?: string | null; telegramChatId?: string | null; publishedAt: Date | string; sortOrder?: number }>(rows: T[]): T[] {
  const isTelegram = (row: T) => Boolean(row.telegramChatId) || row.source === "Telegram";
  const dayKey = (value: Date | string) => {
    const d = new Date(value);
    return d.getFullYear() * 10_000 + (d.getMonth() + 1) * 100 + d.getDate();
  };
  return [...rows].sort((a, b) => {
    const dayDiff = dayKey(b.publishedAt) - dayKey(a.publishedAt);
    if (dayDiff !== 0) return dayDiff;
    const tgDiff = Number(isTelegram(b)) - Number(isTelegram(a));
    if (tgDiff !== 0) return tgDiff;
    const timeDiff = new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
    if (timeDiff !== 0) return timeDiff;
    return (a.sortOrder || 0) - (b.sortOrder || 0);
  });
}

// 2026-10-01: входные данные заявки с лендинга для карточки брокера / amoCRM.
type LandingLeadInput = {
  fullName: string;
  phone: string;
  email: string | null;
  note: string | null;
  source: string;
  // id только что сохранённой ContactRequest — исключаем её из проверки дублей
  contactRequestId?: string;
};

// Источники лендинга, по которым известному брокеру ставим задачу + заметку
// на контакте в amoCRM (без лида). 'landing-contact' (старая форма «Связаться
// с нами») сюда намеренно не входит — решение владельца 01.10 касается
// записи на брокер-тур и «перезвоним за 1 час».
const LANDING_KNOWN_BROKER_SOURCES: Record<
  string,
  "LANDING_BROKER_TOUR" | "LANDING_CALLBACK" | undefined
> = {
  "broker-tour": "LANDING_BROKER_TOUR",
  "landing-callback": "LANDING_CALLBACK",
};
const LANDING_DUPLICATE_WINDOW_MIN = 10;
const LANDING_AMO_FAILURE_WINDOW_MS = 30 * 60_000;

@Injectable()
export class CmsService {
  private readonly logger = new Logger(CmsService.name);
  // 2026-05-26: AmoCrmAdapter не зарегистрирован в DI этого модуля, создаём
  // напрямую. Использует env AMO_ACCESS_TOKEN.
  private amo = new AmoCrmAdapter();
  private morekit = new MorekitAdapter();
  // 2026-09-30: TelegramNewsService — решение по Telegram-новости из админки
  // (тот же путь, что кнопки в боте: статус + правка сообщений модераторам).
  // @Optional — часть spec-ов создаёт CmsService(prisma) без него.
  // 2026-10-01: OpsAlertService (глобальный модуль) — алерт в ops-чат, когда
  // заявки с лендинга повторно не доходят до amoCRM.
  constructor(
    @Inject("PrismaClient") private prisma: PrismaClient,
    @Optional() private readonly telegramNews?: TelegramNewsService,
    @Optional() private readonly opsAlerts?: OpsAlertService,
  ) {}

  // Метки времени последних сбоев передачи заявок лендинга в amoCRM —
  // алерт шлём только при повторной ошибке за окно (см. recordLandingAmoFailure).
  private landingAmoFailureTimes: number[] = [];

  async getAllContent() {
    const rows = await this.prisma.siteContent.findMany();
    const map: Record<string, any> = { ...DEFAULT_CONTENT };
    for (const r of rows) map[r.key] = r.value;
    return map;
  }

  async getContent(key: string) {
    const row = await this.prisma.siteContent.findUnique({ where: { key } });
    return row?.value ?? DEFAULT_CONTENT[key] ?? null;
  }

  // КБ6 #45 (2026-05-25): на каждое сохранение CMS-блока пишем revision
  // в site_content_revisions. История доступна в /admin/content/history.
  async upsertContent(key: string, value: any, updatedBy?: string) {
    let editorName: string | null = null;
    if (updatedBy) {
      const editor = await this.prisma.broker
        .findUnique({
          where: { id: updatedBy },
          select: { fullName: true },
        })
        .catch(() => null);
      editorName = editor?.fullName || null;
    }
    const result = await this.prisma.siteContent.upsert({
      where: { key },
      update: { value, updatedBy },
      create: { key, value, updatedBy },
    });
    // Revision пишем после upsert — если upsert упал, revision не появится.
    await this.prisma.siteContentRevision
      .create({
        data: { key, value, editorId: updatedBy || null, editorName },
      })
      .catch((e) => {
        // Если таблицы ещё нет (миграция не прошла) — не валим запрос.
        console.error(
          "[upsertContent] revision write failed:",
          e?.message || e,
        );
      });
    return result;
  }

  // Список revisions для блока (ограничение — последние 50).
  async listRevisions(key: string) {
    return this.prisma.siteContentRevision.findMany({
      where: { key },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
  }

  // Восстановить значение из revision. Создаёт ещё одну revision-запись
  // с пометкой что это restore (через editorName='restore from <id>').
  async restoreRevision(revisionId: string, updatedBy?: string) {
    const rev = await this.prisma.siteContentRevision.findUnique({
      where: { id: revisionId },
    });
    if (!rev) throw new NotFoundException("Revision not found");
    return this.upsertContent(rev.key, rev.value, updatedBy);
  }

  // ─── Events ─────────────────────────────────────

  async listEvents(opts: { onlyActive?: boolean; onlyFuture?: boolean } = {}) {
    const where: any = {};
    if (opts.onlyActive) where.isActive = true;
    if (opts.onlyFuture) where.date = { gte: new Date() };
    return this.prisma.landingEvent.findMany({
      where,
      orderBy: [{ date: "asc" }, { sortOrder: "asc" }],
    });
  }

  // Парсим datetime-local строку (без TZ-маркера) как Europe/Moscow.
  // Браузерный <input type="datetime-local"> отдаёт "2026-05-22T11:00" —
  // без часового пояса. Если new Date(...) парсит её в локали сервера
  // (UTC в Docker), теряем +3 часа и админ удивляется что введённое
  // "12:00" показывается как "15:00" на лендинге.
  private parseDateAsMoscow(input: string): Date {
    if (!input) return new Date(NaN);
    const hasTz = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(input);
    if (hasTz) return new Date(input);
    const hasSeconds = /T\d{2}:\d{2}:\d{2}/.test(input);
    return new Date(hasSeconds ? input + "+03:00" : input + ":00+03:00");
  }

  async createEvent(data: any) {
    return this.prisma.landingEvent.create({
      data: {
        date: this.parseDateAsMoscow(data.date),
        title: data.title,
        location: data.location || null,
        isOnline: !!data.isOnline,
        description: data.description || null,
        sortOrder: Number(data.sortOrder) || 0,
        isActive: data.isActive !== false,
      },
    });
  }

  async updateEvent(id: string, data: any) {
    const patch: any = {};
    if (data.date !== undefined) patch.date = this.parseDateAsMoscow(data.date);
    if (data.title !== undefined) patch.title = data.title;
    if (data.location !== undefined) patch.location = data.location || null;
    if (data.isOnline !== undefined) patch.isOnline = !!data.isOnline;
    if (data.description !== undefined)
      patch.description = data.description || null;
    if (data.sortOrder !== undefined)
      patch.sortOrder = Number(data.sortOrder) || 0;
    if (data.isActive !== undefined) patch.isActive = !!data.isActive;
    return this.prisma.landingEvent.update({ where: { id }, data: patch });
  }

  async deleteEvent(id: string) {
    await this.prisma.landingEvent.delete({ where: { id } });
    return { deleted: true };
  }

  // ─── Projects ───────────────────────────────────

  async listProjects(onlyActive = false) {
    const where: any = {};
    if (onlyActive) where.isActive = true;
    return this.prisma.landingProject.findMany({
      where,
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
  }

  async createProject(data: any) {
    if (!data.slug || !data.name || !data.description) {
      throw new NotFoundException("slug, name, description обязательны");
    }
    return this.prisma.landingProject.create({
      data: {
        slug: data.slug,
        tag: data.tag || null,
        name: data.name,
        subtitle: data.subtitle || null,
        description: data.description,
        ctaText: data.ctaText || null,
        ctaHref: data.ctaHref || null,
        sortOrder: Number(data.sortOrder) || 0,
        isActive: data.isActive !== false,
      },
    });
  }

  async getProjectBySlug(slug: string) {
    return this.prisma.landingProject.findUnique({ where: { slug } });
  }

  async updateProject(id: string, data: any) {
    const patch: any = {};
    for (const k of [
      "slug",
      "tag",
      "name",
      "subtitle",
      "description",
      "ctaText",
      "ctaHref",
      "imageUrl",
      "classType",
      "address",
      "district",
    ] as const) {
      if (data[k] !== undefined) patch[k] = data[k] || null;
    }
    if (patch.name === null) delete patch.name;
    if (patch.description === null) delete patch.description;
    for (const k of [
      "totalUnits",
      "floorsTotal",
      "buildingsCount",
      "readyQuarter",
      "readyYear",
    ] as const) {
      if (data[k] !== undefined)
        patch[k] = data[k] === null ? null : Number(data[k]);
    }
    // commissionFrom/commissionTo — legacy-колонки. Новые ставки меняются
    // только через CommissionPolicy и здесь намеренно больше не записываются.
    for (const k of ["pricePerSqmFrom"] as const) {
      if (data[k] !== undefined)
        patch[k] = data[k] === null ? null : Number(data[k]);
    }
    if (data.gallery !== undefined) patch.gallery = data.gallery;
    if (data.characteristics !== undefined)
      patch.characteristics = data.characteristics;
    if (data.sortOrder !== undefined)
      patch.sortOrder = Number(data.sortOrder) || 0;
    if (data.isActive !== undefined) patch.isActive = !!data.isActive;
    return this.prisma.landingProject.update({ where: { id }, data: patch });
  }

  async deleteProject(id: string) {
    await this.prisma.landingProject.delete({ where: { id } });
    return { deleted: true };
  }

  // ─── News (нижний блок страницы — медиа/упоминания) ────────────

  async listNews(onlyActive = false, moderationStatus?: string | null) {
    const where: any = {};
    if (onlyActive) where.isActive = true;
    // 2026-09-30: фильтр админки по статусу согласования (PENDING/APPROVED/REJECTED).
    if (moderationStatus && (NEWS_MODERATION_STATUSES as readonly string[]).includes(moderationStatus)) {
      where.moderationStatus = moderationStatus;
    }
    return this.prisma.landingNews.findMany({
      where,
      orderBy: [{ publishedAt: "desc" }, { sortOrder: "asc" }],
    });
  }

  // 2026-09-30 (владелец): единая лента — Telegram-посты и карточки сайта
  // вместе по дате (Telegram первым в один день), до 20 штук (?limit=).
  // На лендинг попадают только активные и согласованные (APPROVED): пост
  // канала до решения модераторов (PENDING) и отклонённый (REJECTED) не отдаём.
  async listPublicNews(limit?: unknown) {
    const take = clampPublicNewsLimit(limit);
    const rows = await this.prisma.landingNews.findMany({
      where: { isActive: true, moderationStatus: "APPROVED" },
      orderBy: [{ publishedAt: "desc" }, { sortOrder: "asc" }],
      // Берём с запасом: порядок внутри одного дня (Telegram первым)
      // определяется в orderPublicNews, а не в SQL.
      take: take * 3,
    });
    return orderPublicNews(rows).slice(0, take);
  }

  /**
   * 2026-09-30: решение админа по новости. Делегируем в TelegramNewsService —
   * он меняет статус (идемпотентно) и правит сообщения «На согласование» у
   * модераторов в боте. Из админки решение можно менять и после: «Скрыть»
   * опубликованную (→ REJECTED) или «Опубликовать» скрытую (→ APPROVED);
   * тот же статус повторно — result: already.
   */
  async moderateNews(id: string, status: string, byName: string) {
    const wanted = String(status || "").toUpperCase();
    if (wanted !== "APPROVED" && wanted !== "REJECTED") {
      throw new BadRequestException("status должен быть APPROVED или REJECTED");
    }
    if (!this.telegramNews) throw new ServiceUnavailableException("Согласование новостей недоступно");
    const outcome = await this.telegramNews.moderate(id, wanted, byName || "админ", undefined, { allowChange: true });
    if (outcome.result === "not_found") throw new NotFoundException("Новость не найдена");
    const fresh = await this.prisma.landingNews.findUnique({ where: { id } });
    return { result: outcome.result, status: outcome.status, news: fresh };
  }

  async createNews(data: any) {
    return this.prisma.landingNews.create({
      data: {
        title: data.title,
        source: data.source || null,
        publishedAt: data.publishedAt ? new Date(data.publishedAt) : new Date(),
        excerpt: data.excerpt || null,
        imageUrl: data.imageUrl || null,
        url: data.url,
        sortOrder: Number(data.sortOrder) || 0,
        isActive: data.isActive !== false,
      },
    });
  }

  async updateNews(id: string, data: any) {
    const patch: any = {};
    for (const k of [
      "title",
      "source",
      "excerpt",
      "imageUrl",
      "url",
    ] as const) {
      if (data[k] !== undefined) patch[k] = data[k] || null;
    }
    if (data.publishedAt !== undefined)
      patch.publishedAt = data.publishedAt
        ? new Date(data.publishedAt)
        : new Date();
    if (data.sortOrder !== undefined)
      patch.sortOrder = Number(data.sortOrder) || 0;
    if (data.isActive !== undefined) patch.isActive = !!data.isActive;
    return this.prisma.landingNews.update({ where: { id }, data: patch });
  }

  async deleteNews(id: string) {
    await this.prisma.landingNews.delete({ where: { id } });
    return { deleted: true };
  }

  // 2026-08-12: ручной/плановый синк новостей с stmichael.ru/news.
  // Та же логика, что в SchedulerService.handleStmNewsSync, вынесена сюда
  // чтобы не создавать циклическую зависимость CmsModule ↔ SchedulerModule.
  //
  // 2026-09-30 (решение владельца): новости сайта тоже согласуются. Новая
  // карточка создаётся PENDING (на лендинг не попадает) и модераторам уходит
  // то же «На согласование» с кнопками, что и для Telegram-постов (заголовок,
  // обложка по ссылке сайта, ссылка на новость; анонса у карточек сайта нет).
  // Повторный парсинг статус существующих карточек не трогает: обновляются
  // только заголовок/обложка/дата, у PENDING — ещё и текст у модераторов.
  async syncNewsFromStm(): Promise<{
    created: number;
    updated: number;
    total: number;
  }> {
    const html = await this.fetchStmNewsHtml();
    const parsed = this.parseStmNewsHtml(html);
    let created = 0;
    let updated = 0;
    for (const { imageCandidates, ...item } of parsed) {
      const existing = await this.prisma.landingNews.findFirst({
        where: { url: item.url },
      });
      // 2026-09-30: обложку скачиваем к себе и проверяем (файлы < 8 КБ или
      // шириной < 600 отбрасываем); в базе — /files/landing/<hash>.<ext>. Если
      // у существующей карточки наш файл уже хороший — не перекачиваем.
      const cover = await this.prepareStmNewsCover(imageCandidates, existing?.imageUrl ?? null, item.title);
      item.imageUrl = cover.imageUrl;
      if (!existing) {
        const row = await this.prisma.landingNews.create({
          data: { ...item, moderationStatus: "PENDING" },
        });
        created++;
        this.logger.log(`[stm-news] новость создана (на согласовании): ${row.id} ← ${row.url}`);
        await this.requestNewsModeration(row, cover.photo);
      } else if (
        existing.title !== item.title ||
        existing.imageUrl !== item.imageUrl
      ) {
        const row = await this.prisma.landingNews.update({
          where: { id: existing.id },
          data: {
            title: item.title,
            imageUrl: item.imageUrl,
            publishedAt: item.publishedAt,
          },
        });
        updated++;
        if (row?.moderationStatus === "PENDING" && this.telegramNews) {
          await this.telegramNews.refreshModeration(row).catch((e: any) =>
            this.logger.warn(`[stm-news] не удалось обновить «На согласование» для ${row.id}: ${e?.message || e}`),
          );
        }
      }
    }
    return { created, updated, total: parsed.length };
  }

  /**
   * Уведомление модераторам о новой карточке сайта; ошибка Telegram синк не
   * роняет. `photo` — https-ссылка на кадр с сайта (наш /files/… Telegram по
   * ссылке не заберёт — сервис отправит текстом).
   */
  private async requestNewsModeration(row: any, photo: string | null = null): Promise<void> {
    if (!this.telegramNews) {
      this.logger.warn(`[stm-news] TelegramNewsService недоступен — новость ${row?.id} ждёт решения в /admin/news`);
      return;
    }
    try {
      await this.telegramNews.requestModeration(row, photo || row?.imageUrl || null);
    } catch (e: any) {
      this.logger.warn(`[stm-news] «На согласование» для ${row?.id} не отправлено: ${e?.message || e}`);
    }
  }

  /**
   * 2026-09-30: обложка для карточки сайта. Кандидаты (см. stm-news-cover)
   * качаются по очереди и проверяются; первый хороший сохраняется в
   * /app/uploads/landing/<hash>.<ext>, в базу идёт /files/landing/<hash>.<ext>.
   * Если у карточки уже есть наш файл и он хороший — оставляем как есть.
   * Если ни один кандидат не прошёл — оставляем ссылку на сайт (как раньше),
   * чтобы карточка не осталась без картинки.
   */
  async prepareStmNewsCover(
    candidates: CoverCandidate[],
    currentImageUrl: string | null,
    label = "",
  ): Promise<{ imageUrl: string | null; photo: string | null }> {
    const remote = candidates.find((c) => !c.placeholder)?.url || candidates[0]?.url || null;
    const photo = remote && /^https?:\/\//i.test(remote) ? remote : null;
    if (await this.localCoverIsGood(currentImageUrl)) {
      return { imageUrl: currentImageUrl, photo };
    }
    if (!candidates.length) return { imageUrl: null, photo: null };
    try {
      const resolved = await resolveStmCover(candidates, (url) => this.fetchStmBinary(url));
      if (resolved) {
        const imageUrl = await this.saveStmCover(resolved.buf, resolved.ext);
        if (resolved.tried.length) {
          this.logger.log(
            `[stm-news] обложка «${label}»: взят ${resolved.origin} ${resolved.check.width}×${resolved.check.height}, отвергнуто ${resolved.tried.length}`,
          );
        }
        return { imageUrl, photo: resolved.url };
      }
      this.logger.warn(`[stm-news] обложка «${label}»: ни один из ${candidates.length} кандидатов не прошёл проверку — оставляю ссылку на сайт`);
    } catch (e: any) {
      this.logger.warn(`[stm-news] обложка «${label}»: не удалось скачать (${e?.message || e}) — оставляю ссылку на сайт`);
    }
    return { imageUrl: remote, photo };
  }

  /** Наш файл обложки на месте и проходит проверку (≥ 8 КБ, ширина ≥ 600). */
  async localCoverIsGood(imageUrl: string | null | undefined): Promise<boolean> {
    const file = localCoverPath(imageUrl);
    if (!file) return false;
    try {
      const buf = await fsp.readFile(file);
      return checkCoverFile(buf).ok;
    } catch {
      return false;
    }
  }

  /** Кладёт файл в uploads/landing (имя — по содержимому) и возвращает публичную ссылку. */
  async saveStmCover(buf: Buffer, ext: string): Promise<string> {
    const name = coverFileName(buf, ext);
    const dir = join(uploadsRoot(), LANDING_COVER_DIR);
    await fsp.mkdir(dir, { recursive: true });
    const file = join(dir, name);
    try {
      await fsp.access(file);
    } catch {
      await fsp.writeFile(file, buf);
    }
    return `${LANDING_COVER_PUBLIC_PREFIX}/${name}`;
  }

  /** Скачивает картинку с stmichael.ru (с тем же обходом просроченного ECDSA-сертификата). */
  async fetchStmBinary(url: string): Promise<Buffer> {
    try {
      return await this.requestStm(url);
    } catch (error: any) {
      if (error?.code !== "CERT_HAS_EXPIRED") throw error;
      return this.requestStm(url, { sigalgs: STM_RSA_SIGALGS });
    }
  }

  private requestStmNewsHtml(extraOptions: Record<string, unknown> = {}): Promise<string> {
    return this.requestStm("https://stmichael.ru/news", extraOptions).then((buf) => buf.toString("utf-8"));
  }

  private requestStm(url: string, extraOptions: Record<string, unknown> = {}): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const https = require("https");
      const req = https.get(
        url,
        {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; STMBrokerBot/1.0)",
          },
          timeout: 20000,
          ...extraOptions,
        },
        (res: any) => {
          if (res.statusCode && res.statusCode >= 400) {
            res.resume();
            reject(new Error(`stm: HTTP ${res.statusCode} ${url.slice(0, 120)}`));
            return;
          }
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks)));
          res.on("error", reject);
        },
      );
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("stm-news: request timeout"));
      });
      req.on("error", reject);
    });
  }

  /**
   * 2026-09-12: синк новостей падал каждый день в 08:00 с «certificate has
   * expired». Разбор: у stmichael.ru два сертификата — RSA (действует до
   * 15.11.2026) и ECDSA, истёкший 03.09.2026. Клиент, который предпочитает
   * ECDSA (наш node на сервере), получает просроченный и законно отказывает.
   * Корень — на стороне сайта: просроченный ECDSA-сертификат надо обновить
   * или убрать, часть посетителей тоже может видеть предупреждение.
   *
   * Пока это не сделано — повторяем запрос, прямо попросив RSA-цепочку.
   * Проверку сертификата НЕ отключаем: сертификат по-прежнему сверяется,
   * просто выбираем ту из двух цепочек, которая действительна.
   */
  private async fetchStmNewsHtml(): Promise<string> {
    try {
      return await this.requestStmNewsHtml();
    } catch (error: any) {
      if (error?.code !== "CERT_HAS_EXPIRED") throw error;
      this.logger.warn(
        "[stm-news] сайт отдал просроченный сертификат (ECDSA истёк 03.09.2026) — повторяю запрос по RSA-цепочке; корень надо починить на стороне stmichael.ru",
      );
      return this.requestStmNewsHtml({ sigalgs: STM_RSA_SIGALGS });
    }
  }

  private parseStmNewsHtml(html: string): any[] {
    const MONTHS: Record<string, number> = {
      января: 1,
      февраля: 2,
      марта: 3,
      апреля: 4,
      мая: 5,
      июня: 6,
      июля: 7,
      августа: 8,
      сентября: 9,
      октября: 10,
      ноября: 11,
      декабря: 12,
    };
    const cardRe =
      /<a\s[^>]*href="(\/news\/[^"]+)"[^>]*class="NewsCard_\w+">([\s\S]*?)(?=<a\s[^>]*href="\/news\/|<\/ul>|<\/section>|$)/g;
    const items: any[] = [];
    let m: RegExpExecArray | null;
    while ((m = cardRe.exec(html)) !== null && items.length < STM_NEWS_PARSE_LIMIT) {
      const slug = m[1];
      const body = m[2];
      const url = `https://stmichael.ru${slug}`;
      // 2026-09-14 (жалоба владельца «не загружаются картинки»): на
      // stmichael.ru карточки ниже первого экрана грузятся лениво, и в
      // теге картинки лежат ДВА адреса: data-src — намеренно размытая
      // заглушка на ~1 КБ (в пути bl:40 — «размытие 40»), а настоящая
      // фотография — в data-lazy-srcset (w:960/q:80). Парсер брал первый
      // попавшийся адрес, то есть заглушку: у первых карточек ленивой
      // загрузки нет и они выглядели нормально, остальные — размытыми.
      // Порядок: сначала настоящий кадр, заглушка — только на крайний случай.
      // 2026-09-30: все кандидаты сохраняем — синк скачает и проверит их по очереди.
      const imageCandidates = collectStmCoverCandidates(body);
      const imageUrl = imageCandidates[0]?.url ?? null;
      const dateM = body.match(
        /class="date_\w+"[^>]*>\s*(\d{1,2})\s+([а-яёА-ЯЁ]+)\s+(\d{4})/u,
      );
      let publishedAt: Date = new Date();
      if (dateM) {
        const day = parseInt(dateM[1], 10);
        const monthNum = MONTHS[dateM[2].toLowerCase()] ?? 1;
        const year = parseInt(dateM[3], 10);
        publishedAt = new Date(year, monthNum - 1, day);
      }
      const titleM = body.match(/class="title_\w+"[^>]*>([\s\S]*?)<\/div>/);
      const title = titleM
        ? titleM[1].replace(/<[^>]+>/g, "").trim()
        : slug.replace(/^\/news\//, "").replace(/-/g, " ");
      if (!title) continue;
      items.push({
        title,
        source: "stmichael.ru",
        publishedAt,
        imageUrl,
        imageCandidates,
        url,
        isActive: true,
        sortOrder: 0,
      });
    }
    return items;
  }

  // ─── Promos (slider — block 3) ──────────────────

  async listPromos(onlyActive = false) {
    const where: any = {};
    if (onlyActive) {
      where.isActive = true;
      where.OR = [{ expiresAt: null }, { expiresAt: { gt: new Date() } }];
    }
    return this.prisma.landingPromo.findMany({
      where,
      orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
    });
  }

  async createPromo(data: any) {
    return this.prisma.landingPromo.create({
      data: {
        title: data.title,
        subtitle: data.subtitle || null,
        description: data.description || null,
        tag: data.tag || null,
        imageUrl: data.imageUrl || null,
        imagePosition: data.imagePosition || "center",
        ctaText: data.ctaText || null,
        ctaHref: data.ctaHref || null,
        project: data.project || null,
        sortOrder: Number(data.sortOrder) || 0,
        isActive: data.isActive !== false,
        expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
      },
    });
  }

  async updatePromo(id: string, data: any) {
    const patch: any = {};
    for (const k of [
      "title",
      "subtitle",
      "description",
      "tag",
      "imageUrl",
      "imagePosition",
      "ctaText",
      "ctaHref",
      "project",
    ] as const) {
      if (data[k] !== undefined) patch[k] = data[k] || null;
    }
    if (data.sortOrder !== undefined)
      patch.sortOrder = Number(data.sortOrder) || 0;
    if (data.isActive !== undefined) patch.isActive = !!data.isActive;
    if (data.expiresAt !== undefined)
      patch.expiresAt = data.expiresAt ? new Date(data.expiresAt) : null;
    return this.prisma.landingPromo.update({ where: { id }, data: patch });
  }

  async deletePromo(id: string) {
    await this.prisma.landingPromo.delete({ where: { id } });
    return { deleted: true };
  }

  // ─── Contact requests / event signups ────────────

  async createContactRequest(
    data: {
      name: string;
      phone: string;
      email?: string;
      message?: string;
      source?: string;
      eventId?: string;
    },
    ip: string | null,
    userAgent: string | null,
  ) {
    if (!data.name || data.name.trim().length < 2)
      throw new NotFoundException("name required");
    if (!data.phone || data.phone.trim().length < 5)
      throw new NotFoundException("phone required");

    const phone = data.phone.trim();
    const created = await this.prisma.contactRequest.create({
      data: {
        name: data.name.trim(),
        phone,
        email: data.email?.trim() || null,
        message: data.message?.trim() || null,
        source: data.source || "landing-contact",
        eventId: data.eventId || null,
        ip,
        userAgent,
      },
    });

    // 2026-05-26: если заявка с лендинга — заводим/обновляем Broker
    // карточку и кладём в очередь колл-центра (isInBase=true), чтобы
    // оператор перезвонил. Сейчас включаем для broker-tour и
    // landing-contact (обе подразумевают что человек хочет общаться).
    // 2026-09-28: landing-callback — кнопка «Стать партнёром / перезвоним за
    // 1 час» на новом лендинге: та же карточка брокера, но лид и задача в
    // amoCRM уходят в воронку КЦ (решение владельца 28.09).
    const callCenterSources = new Set(["broker-tour", "landing-contact", "landing-callback"]);
    if (callCenterSources.has(data.source || "")) {
      try {
        await this.upsertBrokerFromLandingLead({
          fullName: data.name.trim(),
          phone,
          email: data.email?.trim() || null,
          note: data.message?.trim() || null,
          source: data.source || "landing-contact",
          contactRequestId: created.id,
        });
      } catch (e: any) {
        console.error(
          "[createContactRequest] upsertBrokerFromLandingLead failed:",
          e?.message || e,
        );
      }
    }

    return created;
  }

  // 2026-05-26: создаёт или обновляет Broker, который оставил заявку с лендинга.
  // Лояльно к существующему: если phone уже есть — обновляет category/isInBase
  // и не трогает password/auth-поля. Новых ставит в очередь КЦ (isInBase=true,
  // status=PENDING, category=WARM, funnelStage=NEW_BROKER).
  private async upsertBrokerFromLandingLead(data: LandingLeadInput) {
    // Нормализуем телефон до +7XXXXXXXXXX (как в основной БД).
    const digits = (data.phone || "").replace(/\D/g, "");
    let phone = data.phone;
    if (digits.length === 11 && digits[0] === "8")
      phone = "+7" + digits.slice(1);
    else if (digits.length === 11 && digits[0] === "7") phone = "+" + digits;
    else if (digits.length === 10) phone = "+7" + digits;

    const existing = await this.prisma.broker.findUnique({ where: { phone } });
    if (existing) {
      // Уже есть. Не перетираем имя/роль/email, только метим что заявил
      // через лендинг и пробуждаем для КЦ если был спящий.
      await this.prisma.broker.update({
        where: { id: existing.id },
        data: {
          isInBase: true,
          // Если он отказывался от звонков — заявка с лендинга это снимает
          doNotCall: false,
          // Если в кэше отложили звонок — забываем (он сам написал, надо звонить сейчас)
          nextCallAt: null,
        },
      });
      // 2026-10-01: раньше на этом всё заканчивалось — в amoCRM ничего не
      // появлялось, менеджер не видел повторную запись на тур. Теперь —
      // задача + заметка на контакте брокера (решение владельца 01.10).
      try {
        await this.notifyAmoAboutKnownBrokerLanding(existing, phone, data);
      } catch (e: any) {
        console.error(
          "[upsertBrokerFromLandingLead] known-broker amo notify failed:",
          e?.message || e,
        );
      }
      return existing.id;
    }

    const created = await this.prisma.broker.create({
      data: {
        fullName: data.fullName,
        phone,
        email: data.email,
        role: "BROKER",
        status: "PENDING",
        funnelStage: "NEW_BROKER",
        source: (data.source === "broker-tour"
          ? "LANDING_BROKER_TOUR"
          : "LANDING_FORM") as any,
        category: "WARM" as any, // явная заявка — точно тёплый
        isInBase: true,
        baseSource: "manual",
        // первое касание — сразу в очередь, оператор увидит сегодня
        nextCallAt: null,
      },
    });

    await this.pushLandingLeadToAmo(created.id, phone, data);
    return created.id;
  }

  // 2026-05-26: параллельно создаём карточку в amoCRM (пайплайн БРОКЕРЫ)
  // — контакт с IS_BROKER + лид + задача КЦ. Если amo упал — не валим:
  // brokerId в нашей БД создан, синк может пройти позже.
  // 2026-10-01: вынесено из upsertBrokerFromLandingLead — тот же путь нужен
  // известному брокеру, у которого в amoCRM не нашли контакт.
  private async pushLandingLeadToAmo(
    brokerId: string,
    phone: string,
    data: LandingLeadInput,
  ): Promise<void> {
    let amoLeadId: number | undefined;
    let amoContactId: number | undefined;
    let durableCreateGateId: string | null = null;
    let observedGateId: string | null = null;
    try {
      amoContactId = await this.prisma.$transaction(
        async (tx) => {
          await acquireAmoBrokerContactAdvisoryXactLock(tx, brokerId, phone);
          const lockedBroker = await tx.broker.findUnique({
            where: { id: brokerId },
            select: { amoContactId: true, phone: true, mergedIntoId: true },
          });
          if (!lockedBroker)
            throw new Error("AMO_BROKER_CONTACT_LOCK_BROKER_MISSING");
          if (
            lockedBroker.mergedIntoId ||
            normalizeAmoBrokerContactLockPhone(lockedBroker.phone) !==
              normalizeAmoBrokerContactLockPhone(phone)
          ) {
            throw new Error("AMO_BROKER_CONTACT_LOCK_PHONE_DRIFT");
          }
          observedGateId = await getUnresolvedAmoBrokerContactCreateGate(
            this.prisma,
            lockedBroker.phone,
          );
          if (lockedBroker.amoContactId) {
            if (observedGateId) {
              const confirmed = await (this.amo as any).findContactByPhone(
                phone,
                { strict: true },
              );
              if (
                !confirmed ||
                Number(confirmed.id) !== Number(lockedBroker.amoContactId) ||
                !isAmoBrokerContact(confirmed)
              ) {
                throw new Error("AMO_BROKER_CONTACT_GATE_NOT_CONFIRMED");
              }
            }
            return Number(lockedBroker.amoContactId);
          }

          let contact = await (this.amo as any).findContactByPhone(phone, {
            strict: true,
          });
          if (contact) {
            if (observedGateId && !isAmoBrokerContact(contact)) {
              throw new Error("AMO_BROKER_CONTACT_GATE_NOT_CONFIRMED");
            }
            if (!isAmoBrokerContact(contact)) {
              await this.amo.promoteContactToBroker(contact.id);
              contact = await reconcileExactAmoBrokerContact({
                expectedContactId: Number(contact.id),
                lookup: () =>
                  (this.amo as any).findContactByPhone(phone, {
                    strict: true,
                  }),
              });
              if (!contact) {
                throw new Error("AMO_BROKER_CONTACT_PROMOTION_NOT_RECONCILED");
              }
            }
          } else {
            if (observedGateId) return null;
            durableCreateGateId = await armDurableAmoBrokerContactCreateGate(
              this.prisma,
              lockedBroker.phone,
            );
            let createError: unknown = null;
            try {
              contact = await this.amo.createContact({
                name: data.fullName,
                custom_fields_values: [
                  {
                    field_code: "PHONE",
                    values: [{ value: phone, enum_code: "WORK" }],
                  },
                  ...(data.email
                    ? [
                        {
                          field_code: "EMAIL" as const,
                          values: [{ value: data.email, enum_code: "WORK" }],
                        },
                      ]
                    : []),
                  { field_id: 835415, values: [{ value: true }] },
                ],
              });
            } catch (error) {
              createError = error;
            }
            if (
              createError &&
              isDefinitiveAmoContactCreateRejection(createError)
            ) {
              await recordResolvedAmoBrokerContactCreate(
                this.prisma,
                lockedBroker.phone,
                durableCreateGateId!,
              );
              durableCreateGateId = null;
              throw createError;
            }
            const expectedContactId = Number.isSafeInteger(Number(contact?.id))
              ? Number(contact.id)
              : null;
            try {
              contact = await reconcileExactAmoBrokerContact({
                expectedContactId,
                lookup: () =>
                  (this.amo as any).findContactByPhone(phone, {
                    strict: true,
                  }),
              });
            } catch {
              contact = null;
            }
            if (!contact) {
              return null;
            }
          }
          if (!contact?.id) {
            throw new Error("AMO_BROKER_CONTACT_CREATE_NOT_RECONCILED");
          }
          if (!lockedBroker.amoContactId) {
            const linked = await tx.broker.updateMany({
              where: {
                id: brokerId,
                amoContactId: null,
                mergedIntoId: null,
              },
              data: { amoContactId: BigInt(contact.id) as any },
            });
            if (linked.count !== 1) {
              throw new Error("AMO_BROKER_CONTACT_LINK_CAS_MISSED");
            }
          }
          return Number(contact.id);
        },
        {
          isolationLevel: "Serializable",
          maxWait: 5_000,
          timeout: 120_000,
        },
      );
      if (!amoContactId) {
        throw new Error("AMO_BROKER_CONTACT_RECONCILIATION_REQUIRED");
      }
      const gateToResolve = durableCreateGateId || observedGateId;
      if (gateToResolve) {
        await recordResolvedAmoBrokerContactCreate(
          this.prisma,
          phone,
          gateToResolve,
        );
      }
      const amo = await this.amo.createBrokerLeadFromLanding({
        brokerName: data.fullName,
        brokerPhone: phone,
        brokerEmail: data.email,
        source:
          data.source === "broker-tour"
            ? "LANDING_BROKER_TOUR"
            : data.source === "landing-callback"
              ? "LANDING_CALLBACK"
              : "LANDING_FORM",
        note: data.note,
        existingContactId: amoContactId,
        // 2026-09-28: «перезвоним за 1 час» — в воронку КЦ, задача на час.
        pipeline: data.source === "landing-callback" ? "KC" : "BROKERS",
      });
      amoLeadId = amo?.leadId;
      if (amo?.contactId && amo.contactId !== amoContactId) {
        throw new Error("AMO_BROKER_CONTACT_LEAD_LINK_MISMATCH");
      }
    } catch (e: any) {
      console.error(
        "[upsertBrokerFromLandingLead] amo create failed:",
        e?.message || e,
      );
      await this.recordLandingAmoFailure(data.source, "контакт и лид");
    }

    // 2026-06-17: дублируем уведомление в Морикит — он создаст вторую задачу
    // на КЦ-менеджере по графику смен (Ксения как руководитель направления
    // может пропустить — нужен явный обзвон от КЦ-оператора). Лид остаётся
    // на Ксении (PR #165), а задача Морикита уйдёт на текущего оператора КЦ.
    // 2026-09-28: для «перезвоним за 1 час» лид уже в воронке КЦ — Морикит
    // подхватывает его сам по правилам amoCRM, второй раз не дёргаем.
    if (amoLeadId && data.source !== "landing-callback") {
      try {
        const morekitUrl = await getSystemSetting(
          this.prisma,
          "MOREKIT_WEBHOOK_URL",
        );
        if (morekitUrl) {
          this.morekit
            .notifyFixation(
              {
                id: String(amoLeadId),
                agency: "",
                broker_id: amoContactId ? String(amoContactId) : "",
                agent_name: data.fullName, // новый брокер сам же «агент»
                agent_phone: morekitPhone(phone),
                agent_mail: data.email || "",
                budget: "0",
                clients: [{ name: data.fullName, phone: morekitPhone(phone) }],
                type: "Брокер-тур",
                lead_date: morekitLeadDate(),
                project:
                  data.source === "broker-tour"
                    ? "Брокер-тур"
                    : "Заявка с лендинга",
              },
              morekitUrl,
            )
            .catch((e) =>
              console.error(
                "[upsertBrokerFromLandingLead] morekit notify error:",
                e?.message || e,
              ),
            );
        }
      } catch (e: any) {
        console.error(
          "[upsertBrokerFromLandingLead] morekit setup failed:",
          e?.message || e,
        );
      }
    }

  }

  // 2026-10-01: заявка с лендинга от известного брокера (решение владельца
  // 01.10). Лид НЕ создаём: задача «звонок» ответственному + заметка на
  // контакте брокера в amoCRM. Контакт — Broker.amoContactId, иначе строгий
  // поиск по телефону (и привязка при однозначном совпадении); если контакта
  // нет — создаём лид как для нового брокера, чтобы заявка точно дошла.
  private async notifyAmoAboutKnownBrokerLanding(
    existing: {
      id: string;
      amoContactId: bigint | number | null;
      assignedManagerId?: string | null;
    },
    phone: string,
    data: LandingLeadInput,
  ): Promise<void> {
    const amoSource = LANDING_KNOWN_BROKER_SOURCES[data.source];
    if (!amoSource) return;

    if (await this.isRecentDuplicateLandingRequest(phone, data)) {
      console.log(
        `[upsertBrokerFromLandingLead] duplicate landing request within ${LANDING_DUPLICATE_WINDOW_MIN} min, amo task skipped (broker ${existing.id}, source ${data.source})`,
      );
      return;
    }

    let contactId = Number(existing.amoContactId) || null;
    if (!contactId) {
      try {
        const found = await this.amo.findBrokerContactByPhone(phone, {
          strict: true,
        });
        const foundId = Number(found?.id);
        if (Number.isSafeInteger(foundId) && foundId > 0) {
          contactId = foundId;
          try {
            await this.prisma.broker.updateMany({
              where: { id: existing.id, amoContactId: null, mergedIntoId: null },
              data: { amoContactId: BigInt(foundId) as any },
            });
          } catch (e: any) {
            // Контакт может быть уже привязан к другой карточке (unique) —
            // задачу всё равно ставим на найденный контакт.
            console.error(
              "[upsertBrokerFromLandingLead] amoContactId link failed:",
              e?.message || e,
            );
          }
        }
      } catch (e: any) {
        console.error(
          "[upsertBrokerFromLandingLead] broker contact lookup failed:",
          e?.message || e,
        );
      }
    }

    if (!contactId) {
      // Контакта в amo нет (или поиск неоднозначен) — идём путём нового
      // брокера: контакт + лид + задача, под общим замком.
      await this.pushLandingLeadToAmo(existing.id, phone, data);
      return;
    }

    const responsibleUserId =
      await this.resolveKnownBrokerTaskResponsible(existing);
    try {
      const result = await this.amo.createLandingFollowUpForKnownBroker({
        contactId,
        brokerName: data.fullName,
        brokerPhone: phone,
        source: amoSource,
        note: data.note,
        responsibleUserId,
      });
      console.log(
        `[upsertBrokerFromLandingLead] known broker ${existing.id}: amo task on contact ${contactId}, responsible ${result.responsibleUserId ?? "token owner"}, note ${result.noteCreated ? "ok" : "failed"}`,
      );
    } catch (e: any) {
      console.error(
        "[upsertBrokerFromLandingLead] known-broker amo task failed:",
        e?.message || e,
      );
      await this.recordLandingAmoFailure(data.source, "задача на контакте брокера");
    }
  }

  // Идемпотентность: та же форма (телефон + источник + текст) за последние
  // 10 минут — вторую задачу в amo не ставим. Сравниваем и сырой, и
  // нормализованный телефон: ContactRequest хранит номер как прислала форма.
  private async isRecentDuplicateLandingRequest(
    normalizedPhone: string,
    data: LandingLeadInput,
  ): Promise<boolean> {
    const since = new Date(Date.now() - LANDING_DUPLICATE_WINDOW_MIN * 60_000);
    const phones = [...new Set([data.phone, normalizedPhone].filter(Boolean))];
    try {
      const dup = await this.prisma.contactRequest.findFirst({
        where: {
          ...(data.contactRequestId
            ? { id: { not: data.contactRequestId } }
            : {}),
          source: data.source,
          phone: { in: phones },
          message: data.note,
          createdAt: { gte: since },
        },
        select: { id: true },
      });
      return !!dup;
    } catch (e: any) {
      console.error(
        "[upsertBrokerFromLandingLead] duplicate check failed:",
        e?.message || e,
      );
      return false;
    }
  }

  // Ответственный за задачу: ответственный последнего лида КЦ
  // (BrokerAmoContactSync.kcResponsibleUserId) → amo-пользователь
  // закреплённого менеджера (Broker.assignedManager → AmoUser) → undefined
  // (адаптер возьмёт env AMO_KC_CALLBACK_RESPONSIBLE_USER_ID / AMO_ADMIN_USER_ID).
  private async resolveKnownBrokerTaskResponsible(existing: {
    id: string;
    assignedManagerId?: string | null;
  }): Promise<number | undefined> {
    try {
      const sync = await this.prisma.brokerAmoContactSync.findUnique({
        where: { brokerId: existing.id },
        select: { kcResponsibleUserId: true },
      });
      const kc = Number(sync?.kcResponsibleUserId);
      if (Number.isSafeInteger(kc) && kc > 0) return kc;
    } catch (e: any) {
      console.error(
        "[upsertBrokerFromLandingLead] kc responsible lookup failed:",
        e?.message || e,
      );
    }
    if (existing.assignedManagerId) {
      try {
        const amoUser = await this.prisma.amoUser.findUnique({
          where: { brokerId: existing.assignedManagerId },
          select: { id: true, isActive: true },
        });
        const id = Number(amoUser?.id);
        if (amoUser?.isActive !== false && Number.isSafeInteger(id) && id > 0)
          return id;
      } catch (e: any) {
        console.error(
          "[upsertBrokerFromLandingLead] assigned manager amo user lookup failed:",
          e?.message || e,
        );
      }
    }
    return undefined;
  }

  // Ops-алерт при ПОВТОРНЫХ сбоях передачи заявок лендинга в amoCRM: второй
  // сбой за 30 минут → сообщение в ops-чат (дедуп 15 минут по источнику).
  // Без имён и телефонов — только источник и время.
  private async recordLandingAmoFailure(source: string, step: string) {
    const now = Date.now();
    this.landingAmoFailureTimes = this.landingAmoFailureTimes.filter(
      (t) => now - t < LANDING_AMO_FAILURE_WINDOW_MS,
    );
    this.landingAmoFailureTimes.push(now);
    if (this.landingAmoFailureTimes.length < 2 || !this.opsAlerts) return;
    const safeSource = String(source || "unknown").replace(/[^a-z0-9_-]/gi, "");
    try {
      await this.opsAlerts.sendSafely(
        [
          "🔴 Рабочий сайт: заявка с лендинга не передана в amoCRM",
          `Источник: ${safeSource}`,
          `Шаг: ${step}`,
          `Повторных сбоев за 30 минут: ${this.landingAmoFailureTimes.length}`,
          `Время: ${opsAlertTime()}`,
          "Заявка сохранена в кабинете («Админка → Заявки с лендинга»), в amoCRM её нужно завести вручную.",
        ].join("\n"),
        {
          dedupKey: `landing-amo:${safeSource}`,
          cooldownMs: 15 * 60_000,
        },
      );
    } catch (e: any) {
      console.error(
        "[recordLandingAmoFailure] ops alert failed:",
        e?.message || e,
      );
    }
  }

  async listContactRequests(query: {
    page?: number;
    limit?: number;
    source?: string;
    processed?: string;
  }) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (query.source) where.source = query.source;
    if (query.processed === "true") where.processedAt = { not: null };
    else if (query.processed === "false") where.processedAt = null;

    const [items, total] = await Promise.all([
      this.prisma.contactRequest.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      this.prisma.contactRequest.count({ where }),
    ]);

    return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async markContactProcessed(id: string, userId: string) {
    return this.prisma.contactRequest.update({
      where: { id },
      data: { processedAt: new Date(), processedBy: userId },
    });
  }

  // ─── Bootstrap ─────────────────────────────────

  // Активные политики комиссии по проектам — для динамического блока на лендинге
  // (по последнему bug-репорту 2026-05-22: если админ убрал прогрессивную шкалу
  // для Зорге через /admin/commission-policies, лендинг должен это отразить).
  async getActiveCommissionPolicies() {
    const now = new Date();
    const [rows, commissionContent] = await Promise.all([
      this.prisma.commissionPolicy.findMany({
        where: {
          isActive: true,
          startDate: { lte: now },
          endDate: { gte: now },
        },
        orderBy: [{ project: "asc" }, { startDate: "desc" }],
      }),
      this.getContent("commission"),
    ]);
    const byProject: Record<string, any> = {};
    for (const r of rows) {
      if (!byProject[r.project]) {
        const levels = Array.isArray(r.levels) ? (r.levels as any[]) : null;
        const rates =
          r.mode === "FLAT"
            ? [Number(r.flatRate || 0)]
            : (levels || []).map((level: any) => Number(level.rate));
        byProject[r.project] = {
          id: r.id,
          project: r.project,
          mode: r.mode,
          flatRate: r.flatRate != null ? Number(r.flatRate) : null,
          levels,
          minRate: rates.length ? Math.min(...rates) : null,
          maxRate: rates.length ? Math.max(...rates) : null,
          ...paymentTermsForPolicy(r, r.project, commissionContent),
          displayNote: r.displayNote || null,
          startDate: r.startDate,
          endDate: r.endDate,
          source: "POLICY",
        };
      }
    }

    // Один и тот же fallback используется всеми публичными отображениями.
    // Он нужен только для чистой БД/аварийного случая, когда админ ещё не
    // создал политику; старые CMS-шкалы и LandingProject-комиссии не читаем.
    for (const project of ["ZORGE9", "SILVER_BOR"]) {
      if (byProject[project]) continue;
      const thresholds = [...(LEVEL_THRESHOLDS_BY_PROJECT[project] || [])].sort(
        (a, b) => a.minSqm - b.minSqm,
      );
      const levels = thresholds.map((threshold) => ({
        level: threshold.level,
        minSqm: threshold.minSqm,
        rate: rateFor(project, threshold.level),
      }));
      const rates = Object.values(COMMISSION_RATES[project] || {}).map(Number);
      byProject[project] = {
        id: null,
        project,
        mode: "PROGRESSIVE",
        flatRate: null,
        levels,
        minRate: rates.length ? Math.min(...rates) : null,
        maxRate: rates.length ? Math.max(...rates) : null,
        ...paymentTermsForPolicy(null, project, commissionContent),
        displayNote: null,
        startDate: null,
        endDate: null,
        source: "FALLBACK",
      };
    }

    return ["ZORGE9", "SILVER_BOR"].map((project) => byProject[project]);
  }

  // Seeds default content (idempotent — only inserts if missing)
  async seedDefaults() {
    // 2026-06-11: УДАЛЕНЫ две одноразовые миграции (2026-05-22-bis КБ4-fix
    // и 2026-05-26 КБ5-rollback), которые удаляли админские записи
    // hero/advantages/howto/projectsSection/commission по «маркерам старого
    // содержимого». Эти миграции работали как ловушка: Ксения убрала
    // прогрессивную шкалу + карточку «Квартальный бонус» через /admin/content,
    // а на каждом рестарте API код видел «нет карточки Квартальный бонус» →
    // удалял её запись → пересоздавал из DEFAULT_CONTENT с прогрессивной
    // шкалой обратно. Каждый деплой откатывал её правки.
    //
    // Миграции свою задачу выполнили ещё в мае 2026 — на проде уже нет
    // записей с этими «маркерами», условия больше не срабатывают на
    // легитимные данные. Оставлять их не нужно.

    for (const key of KNOWN_KEYS) {
      const exists = await this.prisma.siteContent.findUnique({
        where: { key },
      });
      if (!exists) {
        await this.prisma.siteContent.create({
          data: { key, value: DEFAULT_CONTENT[key] },
        });
      }
    }

    // 2026-09-17 (владелец): Ксения Цепляева больше не работает — в сохранённом
    // блоке контактов её карточку заменяем на Дарью Великанову.
    // Идемпотентно: срабатывает, только пока в БД стоит прежняя фамилия.
    try {
      const contactRow = await this.prisma.siteContent.findUnique({
        where: { key: "contact" },
      });
      const contactValue = contactRow?.value as any;
      const staleManager = /Цепляева/i.test(
        String(contactValue?.manager?.name || ""),
      );
      const staleList = Array.isArray(contactValue?.managers)
        ? contactValue.managers.some((item: any) =>
            /Цепляева/i.test(String(item?.name || "")),
          )
        : false;
      if (contactValue && (staleManager || staleList)) {
        const darya = {
          name: "Дарья Великанова",
          role: "Менеджер по работе с брокерами",
          phone: "+7 (930) 012-94-52",
        };
        const keptManagers = (
          Array.isArray(contactValue.managers) ? contactValue.managers : []
        ).filter((item: any) => !/Цепляева/i.test(String(item?.name || "")));
        await this.prisma.siteContent.update({
          where: { key: "contact" },
          data: {
            value: {
              ...contactValue,
              manager: staleManager ? darya : contactValue.manager,
              managers: keptManagers.length ? keptManagers : [darya],
            },
          },
        });
        console.log("[CMS migration] контакт Ксении заменён на Дарью");
      }
    } catch (error) {
      console.warn("[CMS migration] не удалось обновить блок контактов", error);
    }

    // 2026-07-01: миграция телефона менеджера с личного мобильного Ксении
    // (+7 906 061-78-00) на общий телефон отдела (+7 499 226-22-49).
    // Идемпотентно: срабатывает только если старый номер до сих пор в БД.
    try {
      const contactRow = await this.prisma.siteContent.findUnique({
        where: { key: "contact" },
      });
      const contactValue = contactRow?.value as any;
      const currentPhone = contactValue?.manager?.phone;
      const OLD_PHONE = "+7 (906) 061-78-00";
      const NEW_PHONE = "+7 (499) 226-22-49";
      if (contactValue && currentPhone === OLD_PHONE) {
        const nextValue = {
          ...contactValue,
          manager: { ...(contactValue.manager || {}), phone: NEW_PHONE },
        };
        await this.prisma.siteContent.update({
          where: { key: "contact" },
          data: { value: nextValue },
        });
        console.log(
          "[CMS migration] contact.manager.phone обновлён на",
          NEW_PHONE,
        );
      }
    } catch (e: any) {
      console.warn(
        "[CMS migration] manager.phone migration failed:",
        e?.message || e,
      );
    }

    const projectsCount = await this.prisma.landingProject.count();
    if (projectsCount === 0) {
      await this.prisma.landingProject.createMany({
        data: [
          {
            slug: "zorge9",
            tag: "Приоритетный проект",
            name: "Зорге",
            subtitle: "9",
            description:
              "Апартаменты бизнес-класса у метро Полежаевская. 3 корпуса, архитектура в стиле Арт-Москва. От 270 000 р/м2.",
            ctaText: "Смотреть каталог",
            sortOrder: 0,
          },
          {
            slug: "silver-bor",
            tag: "Новый проект",
            name: "Квартал",
            subtitle: "Серебряный Бор",
            description:
              "Жилой комплекс премиум-класса рядом с Серебряным Бором. Уникальная локация и инфраструктура.",
            ctaText: "Смотреть каталог",
            sortOrder: 1,
          },
        ],
      });
    }

    return { seeded: true };
  }
}
