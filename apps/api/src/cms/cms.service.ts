import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@st-michael/database';
import { AmoCrmAdapter, MorekitAdapter, morekitPhone, morekitLeadDate } from '@st-michael/integrations';
import { getSystemSetting } from '../common/system-setting';

const KNOWN_KEYS = ['hero', 'advantages', 'commission', 'contact', 'howto', 'projectsSection', 'cooperation'] as const;

const DEFAULT_CONTENT: Record<string, any> = {
  hero: {
    tag: 'Партнёрская программа',
    title: 'Доход растёт вместе с объёмом продаж агентства',
    titleAccent: 'продаж агентства',
    // 2026-05-26: возврат к ксениным текстам КБ4 (моя КБ5-правка стёрла их —
    // пользователь сказал откатить). % зашиты в текст осознанно — Ксеня их
    // редактирует руками когда меняются.
    description:
      'Суммируем сделки по Зорге 9 и Кварталу Серебряный Бор — вы быстрее выходите на более высокий уровень комиссии. До 8% по Зорге 9 и до 6,25% по Серебряному Бору.',
    stats: [
      { number: 'до 8%', label: 'Максимальная ставка по Зорге 9' },
      { number: '7 дней', label: 'Выплата вознаграждения' },
      { number: '30 дней', label: 'Срок уникальности клиента' },
      { number: '2', label: 'Активных проекта' },
    ],
  },
  advantages: {
    tag: 'Преимущества',
    title: 'Шесть причин, ради которых брокеры остаются с St Michael',
    titleAccent: 'St Michael',
    subtitle: 'Мы выстроили сотрудничество так, чтобы вы могли начать работать сразу — с первой сделки и с первого дня существования вашего ИП. Без дополнительных условий.',
    items: [
      { icon: 'headphones', title: 'Выделенный отдел партнёров', description: 'Сопровождение на всех этапах сделки.' },
      { icon: 'shield', title: 'Защищаем брокера от увода клиента', description: 'С клиентами, которые пришли через вас, мы не работаем напрямую.' },
      { icon: 'wallet', title: 'Быстрые выплаты', description: 'Вознаграждение — до 7 рабочих дней.' },
      { icon: 'trending-up', title: 'Высокая комиссия', description: 'Прогрессивная шкала по КСБ — до 6,25% за сделку. Фиксированная ставка 5% по Зорге 9. Плюс квартальный и годовой бонусы.' },
      { icon: 'sparkles', title: 'Не цепляемся за формальности', description: 'Регламент уникальности у нас гибче, чем у большинства застройщиков. Подтверждаем работу с клиентом, даже когда другие отказали бы.' },
      { icon: 'graduation-cap', title: 'Обучение', description: 'Брокер-туры для быстрого старта продаж.' },
    ],
  },
  howto: {
    tag: 'Старт',
    title: 'Как начать сотрудничать с ST Michael',
    titleAccent: 'ST Michael',
    subtitle: 'Начать можно с первой же сделки — даже если ваше ИП открыто вчера. Никаких дополнительных условий.',
    steps: [
      { num: '01', title: 'Проверка на уникальность', description: 'Проверьте клиента в кабинете перед сделкой.' },
      { num: '02', title: 'Встреча в офисе продаж', description: 'Запишите клиента на встречу в офис продаж.' },
      { num: '03', title: 'Фиксация клиента', description: 'После встречи клиент закреплён за вами на 30 дней — при необходимости можем продлить.' },
      { num: '04', title: 'Сделка и выплата', description: 'После оплаты клиентом — вознаграждение приходит за 7 рабочих дней.' },
    ],
    footer: 'Агентский договор оформляется при первой сделке',
    ctaText: 'Стать партнёром',
  },
  projectsSection: {
    tag: 'Проекты',
    title: 'Наши проекты',
    titleAccent: 'Наши проекты',
    subtitle: '',
  },
  // 2026-06-01: блок «Условия сотрудничества» — раньше был захардкожен в LandingClient.tsx
  cooperation: {
    tag: 'Условия сотрудничества',
    title: 'Всё прозрачно — документы',
    titleAccent: 'документы',
    subtitle: 'Брокер может заранее ознакомиться с условиями партнёрства до регистрации',
    description: 'Мы рассматриваем сотрудничество с позиции «выиграл-выиграл». Все условия зафиксированы в документах и доступны в личном кабинете.',
    ctaText: 'Стать партнёром',
  },
  commission: {
    tag: 'Комиссия и условия выплаты',
    title: 'Прогрессивная шкала вознаграждения',
    titleAccent: 'шкала',
    subtitle: 'Метраж суммируется по обоим проектам в рамках одного агентства. Действует с 1 января по 30 июня 2026 года.',
    // 2026-07-01: параметры калькулятора комиссии /commission/calculate.
    // *Enabled=false → вариант оплаты скрыт на форме калькулятора.
    installmentDiscount: 0.5,
    installmentEnabled: true,
    subsidizedMortgageRate: 4,
    subsidizedMortgageEnabled: true,
    levelsByProject: {
      ZORGE9: [
        { name: 'Start', range: '0–59 м²', rate: '5,0%', active: false },
        { name: 'Basic', range: '60–119 м²', rate: '5,5%', active: false },
        { name: 'Strong', range: '120–199 м²', rate: '6,0%', active: true },
        { name: 'Premium', range: '200–319 м²', rate: '6,5%', active: false },
        { name: 'Elite', range: '320–499 м²', rate: '7,0%', active: false },
        { name: 'Champion', range: '500–699 м²', rate: '7,5%', active: false },
        { name: 'Legend', range: '700+ м²', rate: '8,0%', active: false },
      ],
      SILVER_BOR: [
        { name: 'Start', range: '0–47 м²', rate: '5,0%', active: false },
        { name: 'Basic', range: '48–95 м²', rate: '5,25%', active: false },
        { name: 'Strong', range: '96–170 м²', rate: '5,5%', active: true },
        { name: 'Premium', range: '171–279 м²', rate: '5,75%', active: false },
        { name: 'Elite', range: '280–399 м²', rate: '6,0%', active: false },
        { name: 'Champion', range: '400+ м²', rate: '6,25%', active: false },
      ],
    },
    levels: [
      { name: 'Start', range: '0–59 м²', rate: '5,0%', active: false },
      { name: 'Basic', range: '60–119 м²', rate: '5,5%', active: false },
      { name: 'Strong', range: '120–199 м²', rate: '6,0%', active: true },
      { name: 'Premium', range: '200–319 м²', rate: '6,5%', active: false },
      { name: 'Elite', range: '320–499 м²', rate: '7,0%', active: false },
      { name: 'Champion', range: '500–699 м²', rate: '7,5%', active: false },
      { name: 'Legend', range: '700+ м²', rate: '8,0%', active: false },
    ],
    // 2026-05-26: возвращён «Квартальный бонус» (был ксенин текст КБ4).
    cards: [
      { title: 'Условия выплаты', text: 'Вознаграждение выплачивается в течение 7 рабочих дней после оплаты клиентом. ПВ ≥ 50% (Зорге 9) или ≥ 30% (Серебряный Бор) — единовременно.' },
      { title: 'Квартальный бонус', text: 'При уровне Strong+ несколько кварталов подряд: +0,1% → +0,15% → +0,2% → +0,25% (максимум). Обнуляется при отсутствии продаж в квартале.' },
      { title: 'Бонус за скорость', text: '+0,1% к ставке, если от заявки клиента до платной брони проходит не более 10 рабочих дней. Действует на оба проекта.' },
      { title: 'Годовой бонус', text: '100 000 ₽ + памятный кубок за минимум одну сделку раз в 2 месяца в течение года.' },
      { title: 'Рассрочка и ипотека', text: 'При рассрочке —0,5% от базовой ставки. Субсидированная ипотека — 4% (м² идут в общий зачёт).' },
      { title: 'Коммерческие помещения', text: 'Продажа: помещения и фитнес — 3%, отдельно стоящие здания — 2%. Аренда: ритейл — 100% мес. платежа, фитнес/офис — 50%.' },
      { title: 'Реферальная программа', text: 'Дополнительное вознаграждение за привлечение новых партнёров в программу.' },
    ],
  },
  contact: {
    tag: 'Команда',
    title: 'Всегда на связи',
    titleAccent: 'на связи',
    description: 'В наши бизнес-процессы заложена тесная коммуникация с партнёрами. Горячая линия по работе с партнёрами работает каждый день с 9:00 до 21:00.',
    blockTitle: 'Горячая линия по работе с партнёрами',
    phone: '+7 (499) 226-22-49',
    phoneHours: 'Ежедневно с 9:00 до 21:00',
    email: 'info@zorge9.com',
    telegram: 'https://t.me/stmichaelBroker',
    manager: {
      name: 'Ксения Цепляева',
      role: 'Руководитель отдела по работе с партнёрами',
      // 2026-07-01: телефон отдела по работе с брокерами (был личный
      // мобильный Ксении +7 906 061-78-00).
      phone: '+7 (499) 226-22-49',
    },
  },
};

@Injectable()
export class CmsService {
  // 2026-05-26: AmoCrmAdapter не зарегистрирован в DI этого модуля, создаём
  // напрямую. Использует env AMO_ACCESS_TOKEN.
  private amo = new AmoCrmAdapter();
  private morekit = new MorekitAdapter();
  constructor(@Inject('PrismaClient') private prisma: PrismaClient) {}

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
      const editor = await this.prisma.broker.findUnique({
        where: { id: updatedBy },
        select: { fullName: true },
      }).catch(() => null);
      editorName = editor?.fullName || null;
    }
    const result = await this.prisma.siteContent.upsert({
      where: { key },
      update: { value, updatedBy },
      create: { key, value, updatedBy },
    });
    // Revision пишем после upsert — если upsert упал, revision не появится.
    await this.prisma.siteContentRevision.create({
      data: { key, value, editorId: updatedBy || null, editorName },
    }).catch((e) => {
      // Если таблицы ещё нет (миграция не прошла) — не валим запрос.
      console.error('[upsertContent] revision write failed:', e?.message || e);
    });
    return result;
  }

  // Список revisions для блока (ограничение — последние 50).
  async listRevisions(key: string) {
    return this.prisma.siteContentRevision.findMany({
      where: { key },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  // Восстановить значение из revision. Создаёт ещё одну revision-запись
  // с пометкой что это restore (через editorName='restore from <id>').
  async restoreRevision(revisionId: string, updatedBy?: string) {
    const rev = await this.prisma.siteContentRevision.findUnique({ where: { id: revisionId } });
    if (!rev) throw new NotFoundException('Revision not found');
    return this.upsertContent(rev.key, rev.value, updatedBy);
  }

  // ─── Events ─────────────────────────────────────

  async listEvents(opts: { onlyActive?: boolean; onlyFuture?: boolean } = {}) {
    const where: any = {};
    if (opts.onlyActive) where.isActive = true;
    if (opts.onlyFuture) where.date = { gte: new Date() };
    return this.prisma.landingEvent.findMany({
      where,
      orderBy: [{ date: 'asc' }, { sortOrder: 'asc' }],
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
    return new Date(hasSeconds ? input + '+03:00' : input + ':00+03:00');
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
    if (data.description !== undefined) patch.description = data.description || null;
    if (data.sortOrder !== undefined) patch.sortOrder = Number(data.sortOrder) || 0;
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
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async createProject(data: any) {
    if (!data.slug || !data.name || !data.description) {
      throw new NotFoundException('slug, name, description обязательны');
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
    for (const k of ['slug', 'tag', 'name', 'subtitle', 'description', 'ctaText', 'ctaHref',
                     'imageUrl', 'classType', 'address', 'district'] as const) {
      if (data[k] !== undefined) patch[k] = data[k] || null;
    }
    if (patch.name === null) delete patch.name;
    if (patch.description === null) delete patch.description;
    for (const k of ['totalUnits', 'floorsTotal', 'buildingsCount', 'readyQuarter', 'readyYear'] as const) {
      if (data[k] !== undefined) patch[k] = data[k] === null ? null : Number(data[k]);
    }
    for (const k of ['pricePerSqmFrom', 'commissionFrom', 'commissionTo'] as const) {
      if (data[k] !== undefined) patch[k] = data[k] === null ? null : Number(data[k]);
    }
    if (data.gallery !== undefined) patch.gallery = data.gallery;
    if (data.characteristics !== undefined) patch.characteristics = data.characteristics;
    if (data.sortOrder !== undefined) patch.sortOrder = Number(data.sortOrder) || 0;
    if (data.isActive !== undefined) patch.isActive = !!data.isActive;
    return this.prisma.landingProject.update({ where: { id }, data: patch });
  }

  async deleteProject(id: string) {
    await this.prisma.landingProject.delete({ where: { id } });
    return { deleted: true };
  }

  // ─── News (нижний блок страницы — медиа/упоминания) ────────────

  async listNews(onlyActive = false) {
    const where: any = {};
    if (onlyActive) where.isActive = true;
    return this.prisma.landingNews.findMany({
      where,
      orderBy: [{ publishedAt: 'desc' }, { sortOrder: 'asc' }],
    });
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
    for (const k of ['title', 'source', 'excerpt', 'imageUrl', 'url'] as const) {
      if (data[k] !== undefined) patch[k] = data[k] || null;
    }
    if (data.publishedAt !== undefined) patch.publishedAt = data.publishedAt ? new Date(data.publishedAt) : new Date();
    if (data.sortOrder !== undefined) patch.sortOrder = Number(data.sortOrder) || 0;
    if (data.isActive !== undefined) patch.isActive = !!data.isActive;
    return this.prisma.landingNews.update({ where: { id }, data: patch });
  }

  async deleteNews(id: string) {
    await this.prisma.landingNews.delete({ where: { id } });
    return { deleted: true };
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
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
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
    for (const k of ['title', 'subtitle', 'description', 'tag', 'imageUrl', 'ctaText', 'ctaHref', 'project'] as const) {
      if (data[k] !== undefined) patch[k] = data[k] || null;
    }
    if (data.sortOrder !== undefined) patch.sortOrder = Number(data.sortOrder) || 0;
    if (data.isActive !== undefined) patch.isActive = !!data.isActive;
    if (data.expiresAt !== undefined) patch.expiresAt = data.expiresAt ? new Date(data.expiresAt) : null;
    return this.prisma.landingPromo.update({ where: { id }, data: patch });
  }

  async deletePromo(id: string) {
    await this.prisma.landingPromo.delete({ where: { id } });
    return { deleted: true };
  }

  // ─── Contact requests / event signups ────────────

  async createContactRequest(
    data: { name: string; phone: string; email?: string; message?: string; source?: string; eventId?: string },
    ip: string | null,
    userAgent: string | null,
  ) {
    if (!data.name || data.name.trim().length < 2) throw new NotFoundException('name required');
    if (!data.phone || data.phone.trim().length < 5) throw new NotFoundException('phone required');

    const phone = data.phone.trim();
    const created = await this.prisma.contactRequest.create({
      data: {
        name: data.name.trim(),
        phone,
        email: data.email?.trim() || null,
        message: data.message?.trim() || null,
        source: data.source || 'landing-contact',
        eventId: data.eventId || null,
        ip,
        userAgent,
      },
    });

    // 2026-05-26: если заявка с лендинга — заводим/обновляем Broker
    // карточку и кладём в очередь колл-центра (isInBase=true), чтобы
    // оператор перезвонил. Сейчас включаем для broker-tour и
    // landing-contact (обе подразумевают что человек хочет общаться).
    const callCenterSources = new Set(['broker-tour', 'landing-contact']);
    if (callCenterSources.has(data.source || '')) {
      try {
        await this.upsertBrokerFromLandingLead({
          fullName: data.name.trim(),
          phone,
          email: data.email?.trim() || null,
          note: data.message?.trim() || null,
          source: data.source || 'landing-contact',
        });
      } catch (e: any) {
        console.error('[createContactRequest] upsertBrokerFromLandingLead failed:', e?.message || e);
      }
    }

    return created;
  }

  // 2026-05-26: создаёт или обновляет Broker, который оставил заявку с лендинга.
  // Лояльно к существующему: если phone уже есть — обновляет category/isInBase
  // и не трогает password/auth-поля. Новых ставит в очередь КЦ (isInBase=true,
  // status=PENDING, category=WARM, funnelStage=NEW_BROKER).
  private async upsertBrokerFromLandingLead(data: {
    fullName: string;
    phone: string;
    email: string | null;
    note: string | null;
    source: string;
  }) {
    // Нормализуем телефон до +7XXXXXXXXXX (как в основной БД).
    const digits = (data.phone || '').replace(/\D/g, '');
    let phone = data.phone;
    if (digits.length === 11 && digits[0] === '8') phone = '+7' + digits.slice(1);
    else if (digits.length === 11 && digits[0] === '7') phone = '+' + digits;
    else if (digits.length === 10) phone = '+7' + digits;

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
      return existing.id;
    }

    const created = await this.prisma.broker.create({
      data: {
        fullName: data.fullName,
        phone,
        email: data.email,
        role: 'BROKER',
        status: 'PENDING',
        funnelStage: 'NEW_BROKER',
        source: (data.source === 'broker-tour' ? 'LANDING_BROKER_TOUR' : 'LANDING_FORM') as any,
        category: 'WARM' as any, // явная заявка — точно тёплый
        isInBase: true,
        baseSource: 'manual',
        // первое касание — сразу в очередь, оператор увидит сегодня
        nextCallAt: null,
      },
    });

    // 2026-05-26: параллельно создаём карточку в amoCRM (пайплайн БРОКЕРЫ)
    // — контакт с IS_BROKER + лид + задача КЦ. Если amo упал — не валим:
    // brokerId в нашей БД создан, синк может пройти позже.
    let amoLeadId: number | undefined;
    let amoContactId: number | undefined;
    try {
      const amo = await this.amo.createBrokerLeadFromLanding({
        brokerName: data.fullName,
        brokerPhone: phone,
        brokerEmail: data.email,
        source: data.source === 'broker-tour' ? 'LANDING_BROKER_TOUR' : 'LANDING_FORM',
        note: data.note,
      });
      amoLeadId = amo?.leadId;
      amoContactId = amo?.contactId;
      if (amoContactId) {
        await this.prisma.broker.update({
          where: { id: created.id },
          data: { amoContactId: BigInt(amoContactId) as any },
        }).catch(() => {});
      }
    } catch (e: any) {
      console.error('[upsertBrokerFromLandingLead] amo create failed:', e?.message || e);
    }

    // 2026-06-17: дублируем уведомление в Морикит — он создаст вторую задачу
    // на КЦ-менеджере по графику смен (Ксения как руководитель направления
    // может пропустить — нужен явный обзвон от КЦ-оператора). Лид остаётся
    // на Ксении (PR #165), а задача Морикита уйдёт на текущего оператора КЦ.
    if (amoLeadId) {
      try {
        const morekitUrl = await getSystemSetting(this.prisma, 'MOREKIT_WEBHOOK_URL');
        if (morekitUrl) {
          this.morekit.notifyFixation({
            id: String(amoLeadId),
            agency: '',
            broker_id: amoContactId ? String(amoContactId) : '',
            agent_name: data.fullName, // новый брокер сам же «агент»
            agent_phone: morekitPhone(phone),
            agent_mail: data.email || '',
            budget: '0',
            clients: [{ name: data.fullName, phone: morekitPhone(phone) }],
            type: 'Брокер-тур',
            lead_date: morekitLeadDate(),
            project: data.source === 'broker-tour' ? 'Брокер-тур' : 'Заявка с лендинга',
          }, morekitUrl).catch((e) => console.error('[upsertBrokerFromLandingLead] morekit notify error:', e?.message || e));
        }
      } catch (e: any) {
        console.error('[upsertBrokerFromLandingLead] morekit setup failed:', e?.message || e);
      }
    }

    return created.id;
  }

  async listContactRequests(query: { page?: number; limit?: number; source?: string; processed?: string }) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (query.source) where.source = query.source;
    if (query.processed === 'true') where.processedAt = { not: null };
    else if (query.processed === 'false') where.processedAt = null;

    const [items, total] = await Promise.all([
      this.prisma.contactRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
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
    const rows = await this.prisma.commissionPolicy.findMany({
      where: {
        isActive: true,
        startDate: { lte: now },
        endDate: { gte: now },
      },
      orderBy: [{ project: 'asc' }, { startDate: 'desc' }],
    });
    const byProject: Record<string, any> = {};
    for (const r of rows) {
      if (!byProject[r.project]) {
        byProject[r.project] = {
          project: r.project,
          mode: r.mode,
          flatRate: r.flatRate ? Number(r.flatRate) : null,
          levels: r.levels || null,
        };
      }
    }
    return Object.values(byProject);
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
      const exists = await this.prisma.siteContent.findUnique({ where: { key } });
      if (!exists) {
        await this.prisma.siteContent.create({
          data: { key, value: DEFAULT_CONTENT[key] },
        });
      }
    }

    // 2026-07-01: миграция телефона менеджера с личного мобильного Ксении
    // (+7 906 061-78-00) на общий телефон отдела (+7 499 226-22-49).
    // Идемпотентно: срабатывает только если старый номер до сих пор в БД.
    try {
      const contactRow = await this.prisma.siteContent.findUnique({ where: { key: 'contact' } });
      const contactValue = contactRow?.value as any;
      const currentPhone = contactValue?.manager?.phone;
      const OLD_PHONE = '+7 (906) 061-78-00';
      const NEW_PHONE = '+7 (499) 226-22-49';
      if (contactValue && currentPhone === OLD_PHONE) {
        const nextValue = {
          ...contactValue,
          manager: { ...(contactValue.manager || {}), phone: NEW_PHONE },
        };
        await this.prisma.siteContent.update({
          where: { key: 'contact' },
          data: { value: nextValue },
        });
        console.log('[CMS migration] contact.manager.phone обновлён на', NEW_PHONE);
      }
    } catch (e: any) {
      console.warn('[CMS migration] manager.phone migration failed:', e?.message || e);
    }

    const projectsCount = await this.prisma.landingProject.count();
    if (projectsCount === 0) {
      await this.prisma.landingProject.createMany({
        data: [
          {
            slug: 'zorge9',
            tag: 'Приоритетный проект',
            name: 'Зорге',
            subtitle: '9',
            description:
              'Апартаменты бизнес-класса у метро Полежаевская. 3 корпуса, архитектура в стиле Арт-Москва. От 270 000 р/м2.',
            ctaText: 'Смотреть каталог',
            sortOrder: 0,
          },
          {
            slug: 'silver-bor',
            tag: 'Новый проект',
            name: 'Квартал',
            subtitle: 'Серебряный Бор',
            description:
              'Жилой комплекс премиум-класса рядом с Серебряным Бором. Уникальная локация и инфраструктура.',
            ctaText: 'Смотреть каталог',
            sortOrder: 1,
          },
        ],
      });
    }

    return { seeded: true };
  }
}
