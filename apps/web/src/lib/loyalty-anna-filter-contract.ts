/**
 * Filter contract copied from Anna Skibitskaya's live Broker Loyalty CRM
 * (broker-loyalty-crm.agentsstmichael.chatgpt.site) and her dashboard package
 * `current-dashboard/app/page.tsx`. Cabinet «База Анны» must not add fields she
 * does not have and must not drop fields she does.
 */
export const ANNA_SEARCH_PLACEHOLDER = "Имя, агентство или телефон";

export const ANNA_FILTER_BAR_LABELS = [
  "Поиск",
  "Период звонков",
  "Обзвон",
  "Последний результат звонка",
  "Сценарий",
  "Ответственный",
  "Направление",
  "Статус брокера",
  "Уровень партнёрства",
  "Количество сделок",
] as const;

export const ANNA_BROKER_ONLY_FILTER_LABELS = [
  "География",
  "Данные и amoCRM",
  "Формат работы",
  "Стадия отношений",
] as const;

export const ANNA_FORBIDDEN_FILTER_LABELS = [
  "Город",
  "Связь с amoCRM",
  "Встречи и сделки с",
  "Размер агентства",
  "Есть сайт",
  "Индивидуальные условия",
  "Предложены специальные условия",
  "Награждены",
  "Давно не связывались",
  "Только архив",
  "Сортировка",
  "Конфликт",
] as const;

export const ANNA_SPECIALIZATIONS = [
  "Бизнес / премиум",
  "Коммерция — аренда",
  "Коммерция — продажа",
  "Вторичка",
] as const;

export const ANNA_WORK_FORMATS = [
  "Агентство",
  "Частный брокер",
  "Координатор",
] as const;

export const ANNA_RELATIONSHIP_STAGES = [
  "Новый",
  "Звонили",
  "Приглашён на БТ",
  "Был на БТ",
  "Фиксация",
  "Встреча",
  "Сделка",
  "Повторные сделки / VIP",
] as const;

export const ANNA_BROKER_CALL_RESULT_LABELS = [
  "Проинформирован",
  "Просил не звонить",
  "Неинтересно",
  "НДЗ",
  "Просил отправить информацию",
  "Запись на БТ",
  "Отказ от БТ",
  "Некорректный номер",
  "Уже не брокер",
] as const;

export const ANNA_AGENCY_CALL_RESULT_LABELS = [
  "НДЗ",
  "Отказ от сотрудничества",
  "Назначен БТ",
  "Перезвонить",
  "Отправить информацию",
  "Есть договорённости",
  "Договорились о сотрудничестве",
] as const;

export const ANNA_BROKER_SCENARIO_LABELS = [
  "Не звонили в период",
  "Звонили в период",
  "Был БТ",
  "Не было БТ",
  "Есть встречи",
  "Нет встреч",
  "Был на БТ → пропал",
  "БТ + фиксация, без встречи",
  "БТ + встреча, без сделки",
  "Новый, не был на БТ",
  "Есть сделки / топ",
  "Не назначен",
] as const;

export const ANNA_AGENCY_SCENARIO_LABELS = [
  "Не звонили в период",
  "Звонили в период",
  "Был БТ",
  "Не было БТ",
  "Есть встречи",
  "Нет встреч",
  "Размещены на сайте",
  "Не размещены на сайте",
  "Индивидуальные условия",
  "Нет индивидуальных условий",
  "Есть сделки / топ",
  "Не назначен",
] as const;

export const ANNA_BROKER_STATUS_OPTIONS = [
  { value: "TOP_SELLER", label: "Топ-продавец" },
  { value: "SELLER", label: "Продавец" },
  { value: "OFFERING", label: "Предлагающий" },
  { value: "FIXATING", label: "Фиксирующий" },
  { value: "BROKER_TOUR", label: "Был на брокер-туре" },
  { value: "DORMANT", label: "Спящий" },
  { value: "NEW", label: "Новый" },
] as const;

export const ANNA_AGENCY_PARTNERSHIP_OPTIONS = [
  { value: "VIP_PARTNER", label: "VIP-партнёр" },
  { value: "SELLING_PARTNER", label: "Продающий партнёр" },
  { value: "ACTIVE_PARTNER", label: "Активный партнёр" },
  { value: "FIXATING_PARTNER", label: "Фиксирующий партнёр" },
  { value: "WARM_PARTNER", label: "Тёплый партнёр" },
  { value: "STARTING_PARTNER", label: "Начинающий партнёр" },
  { value: "DORMANT_PARTNER", label: "Спящий партнёр" },
  { value: "NEW_AGENCY", label: "Новое агентство" },
] as const;

export const ANNA_GEOGRAPHY_OPTIONS = [
  { value: "", label: "Вся география" },
  { value: "MOSCOW", label: "Москва" },
  { value: "REGION", label: "Регион" },
] as const;

export const ANNA_DATA_AND_AMO_OPTIONS = [
  { value: "", label: "Все контакты" },
  { value: "FOUND_AMO", label: "Найден в amoCRM" },
  { value: "NOT_FOUND_AMO", label: "Не найден в amoCRM" },
  { value: "FULL", label: "Данные заполнены" },
  { value: "NEEDS_COMPLETION", label: "Требует заполнения" },
] as const;

export const ANNA_DEAL_FILTER_OPTIONS = {
  empty: "Все сделки",
  common: ["Есть сделки", "Нет сделок"] as const,
  brokers: ["3+ сделки", "5+ сделок"] as const,
  agencies: ["1–2 сделки", "3–4 сделки", "5–9 сделок", "10+ сделок"] as const,
  period: [
    "Сделка в выбранном периоде",
    "Нет сделок в выбранном периоде",
  ] as const,
};

export const ANNA_COLUMN_CONTACT_OPTIONS = [
  "Все контакты",
  "С телефоном",
  "Без телефона",
] as const;

export const ANNA_COLUMN_ACTIVITY_OPTIONS = [
  "Вся активность",
  "Был БТ",
  "Не было БТ",
  "Есть фиксации",
  "Нет фиксаций",
  "Есть встречи",
  "Нет встреч",
] as const;

export const ANNA_COLUMN_CALL_OPTIONS = [
  "Все звонки",
  "Звонили в период",
  "Не звонили в период",
] as const;

export const ANNA_COLUMN_DEAL_OPTIONS = {
  common: ["Все сделки", "Есть сделки", "Нет сделок"] as const,
  brokers: ["1–2 сделки", "3+ сделки"] as const,
  agencies: ["1–4 сделки", "5+ сделок"] as const,
};

export const ANNA_COLUMN_ARIA_LABELS = {
  contact: "Фильтр по контактам",
  status: "Фильтр по статусу",
  activity: "Фильтр по активности",
  calls: "Фильтр по звонкам",
  assignee: "Фильтр по ответственному",
  deals: "Фильтр по сделкам",
} as const;

export const ANNA_EMPTY_OPTIONS = {
  campaigns: "Все обзвоны",
  callResults: "Все результаты",
  scenarios: "Все стадии",
  assignees: "Все сотрудники",
  specializations: "Все направления",
  statuses: "Все статусы",
  workFormats: "Все форматы",
  relationshipStages: "Все стадии отношений",
  unassigned: "Не назначен",
  columnAssignees: "Все ответственные",
} as const;

export const ANNA_ENTITY_TAB_LABELS = {
  brokers: "Все брокеры",
  agencies: "Все агентства",
} as const;

export const ANNA_APPLY_FILTERS_LABEL = "Применить фильтры";
export const ANNA_RESET_FILTERS_LABEL = "Сбросить фильтры";
export const ANNA_SHOW_ALL_LABEL = "Показать всех";

export const ANNA_KPI_CHIP_LABELS = [
  "Не звонили в текущем месяце",
  "Новые брокеры",
  "Посетил БТ и нет фиксации",
  "Дни рождения",
] as const;

export const ANNA_RANKING_PERIOD_OPTIONS = [
  { value: "month", label: "Текущий месяц" },
  { value: "quarter", label: "Текущий квартал" },
  { value: "custom", label: "Произвольные даты" },
] as const;

export function annaSpecializationOptions(current = ""): string[] {
  const options: string[] = [...ANNA_SPECIALIZATIONS];
  if (current && !options.includes(current)) {
    options.push(current);
  }
  return options;
}
