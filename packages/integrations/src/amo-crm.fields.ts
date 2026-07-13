// amoCRM IDs for stmichael account

export const AMO_PIPELINES = {
  ZORGE9: 7600550,
  BERZARINA: 7600546,         // Серебряный бор
  TOLBUKHINA: 7600554,
  KC: 7600542,                // Колл-центр
  BROKERS: 10787390,          // Воронка брокеров — основной источник данных для ЛК
} as const;

export const AMO_STATUS_FINAL_WON = 142;
export const AMO_STATUS_FINAL_LOST = 143;

// Stages of "Воронка брокеров" (10787390)
export const AMO_BROKER_STAGE = {
  NEW: 84932446,           // Новый брокер
  TOUR: 84932450,          // Брокер-тур
  FIXATION: 84932454,      // Фиксации на уникальность
  MEETING: 84932514,       // Встреча
  DEAL: 84932518,          // Сделка
} as const;

// 2026-06-03: ID стадий воронок для алгоритма уникальности.
// Дампнуты через inspect-amo-fields --entity pipelines.
//
// ВАЖНО: в КЦ статус 142 = «Встреча проведена» (конец КЦ), а в ОП 142 = «Успешно реализовано».
//        Статус 143 везде = «Закрыто и не реализовано».
export const AMO_KC_STATUS = {
  UNSORTED: 62907114,
  NEW_REQUEST: 62907118,       // Новое обращение
  NO_ANSWER: 62907122,
  DEFERRED: 62907126,          // Отложенный спрос
  QUALIFIED: 62907282,         // Классифицировали, выводим на встречу
  MEETING_SCHEDULED: 62907286, // Встреча назначена
  MEETING_HELD: 142,           // Встреча проведена (final КЦ)
  CLOSED_LOST: 143,            // Закрыто и не реализовано
} as const;

export const AMO_BERZARINA_STATUS = {
  UNSORTED: 62907130,
  NEW_LEAD: 62907134,          // Новый Лид (= «Новое обращение» в логике)
  DEFERRED: 64421962,
  QUALIFIED: 62907138,         // Квалификация, выводим на встречу
  MEETING_SCHEDULED: 62907142,
  MEETING_DONE_THINKING: 62907358,
  ORAL_BOOKING: 62907362,
  BOOKING_REMOVED: 62907366,
  PAID_BOOKING: 62907370,
  DEAL_PREP: 62907374,
  DEAL: 62907378,
  DEAL_REGISTERED: 62907382,
  PAYMENT_CONTROL: 62907386,
  SUCCESS: 142,
  CLOSED_LOST: 143,
} as const;

export const AMO_ZORGE_STATUS = {
  UNSORTED: 62907146,
  NEW_LEAD: 62907150,          // Новый Лид
  DEFERRED: 64421046,
  QUALIFIED: 62907154,         // Квалификация, выводим на встречу
  MEETING_SCHEDULED: 62907158,
  MEETING_DONE_THINKING: 62907430,
  ORAL_BOOKING: 62907434,
  BOOKING_REMOVED: 62907438,
  PAID_BOOKING: 62907442,
  DEAL_PREP: 62907446,
  DEAL: 62907450,
  DEAL_REGISTERED: 62907454,
  PAYMENT_CONTROL: 62907458,
  SUCCESS: 142,
  CLOSED_LOST: 143,
} as const;

export const AMO_TOLBUKHINA_STATUS = {
  UNSORTED: 62907162,
  NEW_LEAD: 62907166,
  DEFERRED: 64421050,
  QUALIFIED: 62907170,
  MEETING_SCHEDULED: 62907174,
  MEETING_DONE_THINKING: 62907570,
  ORAL_BOOKING: 62907574,
  BOOKING_REMOVED: 62907578,
  PAID_BOOKING: 62907582,
  DEAL_PREP: 62907586,
  DEAL: 62907590,
  DEAL_REGISTERED: 62907594,
  PAYMENT_CONTROL: 62907598,
  SUCCESS: 142,
  CLOSED_LOST: 143,
} as const;

// ─── Хелперы для алгоритма уникальности ───────────────────────────────

/** Лид в статусе «Новое обращение» / «Новый Лид» (первая активная стадия). */
export function isNewRequestStatus(pipelineId: number, statusId: number): boolean {
  return (
    (pipelineId === AMO_PIPELINES.KC && statusId === AMO_KC_STATUS.NEW_REQUEST) ||
    (pipelineId === AMO_PIPELINES.BERZARINA && statusId === AMO_BERZARINA_STATUS.NEW_LEAD) ||
    (pipelineId === AMO_PIPELINES.ZORGE9 && statusId === AMO_ZORGE_STATUS.NEW_LEAD) ||
    (pipelineId === AMO_PIPELINES.TOLBUKHINA && statusId === AMO_TOLBUKHINA_STATUS.NEW_LEAD)
  );
}

/** Лид в статусе «Квалифицировали выводим на встречу» (в любой из ОП/КЦ воронок). */
export function isQualifiedToMeetingStatus(pipelineId: number, statusId: number): boolean {
  return (
    (pipelineId === AMO_PIPELINES.KC && statusId === AMO_KC_STATUS.QUALIFIED) ||
    (pipelineId === AMO_PIPELINES.BERZARINA && statusId === AMO_BERZARINA_STATUS.QUALIFIED) ||
    (pipelineId === AMO_PIPELINES.ZORGE9 && statusId === AMO_ZORGE_STATUS.QUALIFIED) ||
    (pipelineId === AMO_PIPELINES.TOLBUKHINA && statusId === AMO_TOLBUKHINA_STATUS.QUALIFIED)
  );
}

/**
 * Финальный статус лида: закрыт.
 * - 143 «Закрыто и не реализовано» — везде.
 * - 142 — везде финал: в КЦ это «Встреча проведена» (лид выходит из КЦ),
 *   в воронках продаж это «Успешно реализовано» (клиент купил).
 *
 * 2026-06-14: 142 теперь приравнивается к 143 для uniqueness — если все
 * лиды контакта в финальных статусах, новая фиксация = RULE_3 (УНИКАЛЕН,
 * создаём новый лид). Раньше 142 уходил в RULE_2 («На проверке») —
 * блокировало повторные обращения от того же или другого брокера спустя
 * время. По решению пользователя 142 = клиент завершил предыдущий цикл,
 * можно фиксировать заново.
 */
export function isClosedLostStatus(statusId: number): boolean {
  return statusId === 143 || statusId === 142;
}

/**
 * 2026-06-15: лид в воронке продаж — Зорге9 / Берзарина / Толбухина.
 * После решения пользователя broker-platform НЕ трогает sales-pipeline
 * лиды никак: не attach контактов, не note-ы, не задачи, не статусы.
 * Эти карточки полностью под управлением админа/Морикита/менеджеров продаж.
 *
 * Для uniqueness sales-лиды игнорируем — повторная фиксация создаёт
 * новый КЦ-лид независимо от того, что у клиента есть активная карточка
 * в sales (в т.ч. «Встреча проведена, думают» 62907430/62907358/62907570).
 */
export function isSalesPipeline(pipelineId: number): boolean {
  return (
    pipelineId === AMO_PIPELINES.BERZARINA ||
    pipelineId === AMO_PIPELINES.ZORGE9 ||
    pipelineId === AMO_PIPELINES.TOLBUKHINA
  );
}

/**
 * 2026-06-16: лид в воронке продаж в стадии «Встреча назначена» —
 * это самое начало sales-pipeline (после Морикит-создания вслед за
 * КЦ-«Встреча проведена»). Для новой фиксации B → RULE_2 (UNDER_REVIEW,
 * без новой карточки). Брокер A только-только начал в продажах.
 */
export function isSalesMeetingScheduledStatus(pipelineId: number, statusId: number): boolean {
  return (
    (pipelineId === AMO_PIPELINES.BERZARINA && statusId === AMO_BERZARINA_STATUS.MEETING_SCHEDULED) ||
    (pipelineId === AMO_PIPELINES.ZORGE9 && statusId === AMO_ZORGE_STATUS.MEETING_SCHEDULED) ||
    (pipelineId === AMO_PIPELINES.TOLBUKHINA && statusId === AMO_TOLBUKHINA_STATUS.MEETING_SCHEDULED)
  );
}

/**
 * 2026-06-16: «средние» стадии воронки продаж — встреча уже прошла, но
 * до сделки ещё не дошло. Для новой фиксации B действует ИСКЛЮЧЕНИЕ:
 *   - создаём L2 в КЦ (новая карточка)
 *   - прикрепляем брокера B контактом к L2
 *   - НО Client.uniquenessStatus = UNDER_REVIEW (не Уникален!)
 *   - сниматься будет когда L2 достигнет статуса «Квалифицировали»
 *     (62907282 в КЦ) или когда L1 (старая sales-карточка A) закроется 143.
 *
 * Стадии:
 *   - MEETING_DONE_THINKING «Встреча проведена, думают»
 *   - DEFERRED               «Отложенный спрос»
 *   - ORAL_BOOKING           «Устная бронь»
 *   - BOOKING_REMOVED        «Снята бронь» (близка к «думают»)
 */
export function isSalesExceptionStatus(pipelineId: number, statusId: number): boolean {
  if (pipelineId === AMO_PIPELINES.BERZARINA) {
    return (
      statusId === AMO_BERZARINA_STATUS.MEETING_DONE_THINKING ||
      statusId === AMO_BERZARINA_STATUS.DEFERRED ||
      statusId === AMO_BERZARINA_STATUS.ORAL_BOOKING ||
      statusId === AMO_BERZARINA_STATUS.BOOKING_REMOVED
    );
  }
  if (pipelineId === AMO_PIPELINES.ZORGE9) {
    return (
      statusId === AMO_ZORGE_STATUS.MEETING_DONE_THINKING ||
      statusId === AMO_ZORGE_STATUS.DEFERRED ||
      statusId === AMO_ZORGE_STATUS.ORAL_BOOKING ||
      statusId === AMO_ZORGE_STATUS.BOOKING_REMOVED
    );
  }
  if (pipelineId === AMO_PIPELINES.TOLBUKHINA) {
    return (
      statusId === AMO_TOLBUKHINA_STATUS.MEETING_DONE_THINKING ||
      statusId === AMO_TOLBUKHINA_STATUS.DEFERRED ||
      statusId === AMO_TOLBUKHINA_STATUS.ORAL_BOOKING ||
      statusId === AMO_TOLBUKHINA_STATUS.BOOKING_REMOVED
    );
  }
  return false;
}

/**
 * 2026-06-16: «поздние» стадии воронки продаж — клиент уже на пути
 * к сделке (платная бронь, подготовка, сделка, регистрация, контроль
 * оплаты). Для новой фиксации B → REJECTED сразу. Брокер A уже занял.
 *   - PAID_BOOKING       «Платная бронь»
 *   - DEAL_PREP          «Подготовка сделки»
 *   - DEAL               «Сделка»
 *   - DEAL_REGISTERED    «Сделка зарегистрирована»
 *   - PAYMENT_CONTROL    «Контроль оплаты»
 */
export function isSalesDealStatus(pipelineId: number, statusId: number): boolean {
  if (pipelineId === AMO_PIPELINES.BERZARINA) {
    return [
      AMO_BERZARINA_STATUS.PAID_BOOKING,
      AMO_BERZARINA_STATUS.DEAL_PREP,
      AMO_BERZARINA_STATUS.DEAL,
      AMO_BERZARINA_STATUS.DEAL_REGISTERED,
      AMO_BERZARINA_STATUS.PAYMENT_CONTROL,
    ].includes(statusId as any);
  }
  if (pipelineId === AMO_PIPELINES.ZORGE9) {
    return [
      AMO_ZORGE_STATUS.PAID_BOOKING,
      AMO_ZORGE_STATUS.DEAL_PREP,
      AMO_ZORGE_STATUS.DEAL,
      AMO_ZORGE_STATUS.DEAL_REGISTERED,
      AMO_ZORGE_STATUS.PAYMENT_CONTROL,
    ].includes(statusId as any);
  }
  if (pipelineId === AMO_PIPELINES.TOLBUKHINA) {
    return [
      AMO_TOLBUKHINA_STATUS.PAID_BOOKING,
      AMO_TOLBUKHINA_STATUS.DEAL_PREP,
      AMO_TOLBUKHINA_STATUS.DEAL,
      AMO_TOLBUKHINA_STATUS.DEAL_REGISTERED,
      AMO_TOLBUKHINA_STATUS.PAYMENT_CONTROL,
    ].includes(statusId as any);
  }
  return false;
}

/** Финал КЦ: «Встреча проведена» (142 для пайплайна КЦ). Считаем как «КЦ завершён». */
export function isKcMeetingHeldStatus(pipelineId: number, statusId: number): boolean {
  return pipelineId === AMO_PIPELINES.KC && statusId === 142;
}

/**
 * 2026-06-05: статус «Отложенный спрос» во всех воронках.
 * Клиент сам ранее звонил и сказал «пока не готов покупать». Это отдельный
 * сценарий: при попытке фиксации брокером этого клиента КЦ должен уточнить
 * у клиента, действительно ли он сейчас работает с этим брокером, или это
 * попытка перехватить заявку.
 */
export function isDeferredDemandStatus(pipelineId: number, statusId: number): boolean {
  return (
    (pipelineId === AMO_PIPELINES.KC && statusId === AMO_KC_STATUS.DEFERRED) ||
    (pipelineId === AMO_PIPELINES.BERZARINA && statusId === AMO_BERZARINA_STATUS.DEFERRED) ||
    (pipelineId === AMO_PIPELINES.ZORGE9 && statusId === AMO_ZORGE_STATUS.DEFERRED) ||
    (pipelineId === AMO_PIPELINES.TOLBUKHINA && statusId === AMO_TOLBUKHINA_STATUS.DEFERRED)
  );
}

/**
 * 2026-06-11: Лид попадает под Правило 1 — старый лид в КЦ-воронке (7600542)
 * в ранних стадиях (до встречи): Неразобранное / Новое обращение / Недозвон /
 * Отложенный спрос / Классифицировали. Поведение при новой фиксации:
 *   - НЕ создавать новый лид в amoCRM
 *   - Прикрепить нового брокера как контакт на старый лид
 *   - Поставить ALARM-задачу на старый лид
 *   - Client в БД → UNDER_REVIEW (брокер видит «на уточнении»)
 */
export function isFixationRule1Lead(pipelineId: number, statusId: number): boolean {
  if (pipelineId !== AMO_PIPELINES.KC) return false;
  return (
    statusId === AMO_KC_STATUS.UNSORTED ||
    statusId === AMO_KC_STATUS.NEW_REQUEST ||
    statusId === AMO_KC_STATUS.NO_ANSWER ||
    statusId === AMO_KC_STATUS.DEFERRED ||
    statusId === AMO_KC_STATUS.QUALIFIED
  );
}

/**
 * 2026-06-15: Лид попадает под Правило 2 — старый лид в КЦ-воронке,
 * статус «Встреча назначена» (62907286). Поведение при новой фиксации:
 *   - НЕ создавать новый лид в amoCRM
 *   - Брокер НЕ прикрепляется как контакт
 *   - ALARM-задача «Подтвердить уникальность» на старый лид
 *   - Client в БД → UNDER_REVIEW
 *
 * Изменения:
 * - 2026-06-14: 142 «Встреча проведена» = closed-lost, не RULE_2.
 * - 2026-06-15: воронки продаж убраны — sales-pipeline лиды broker-platform
 *   вообще не трогает. Повторная фиксация при активном sales-лиде → новый
 *   КЦ-лид (RULE_3). См. isSalesPipeline.
 */
export function isFixationRule2Lead(pipelineId: number, statusId: number): boolean {
  // 143 (closed-lost) — это Правило 3, не 2
  if (statusId === 143) return false;
  // КЦ-воронка: только «Встреча назначена» (после неё 142 = closed-lost).
  if (pipelineId === AMO_PIPELINES.KC) {
    return statusId === AMO_KC_STATUS.MEETING_SCHEDULED;
  }
  // Воронки продаж — не наша зона ответственности, игнорим.
  return false;
}

/**
 * 2026-06-03: алгоритм проверки уникальности по правилам пользователя.
 *
 * Контекст: при фиксации брокером нового клиента нужно понять, конкурирует ли
 * он с уже идущей работой по этому контакту. Только акт осмотра, подписанный
 * на встрече, окончательно закрепляет клиента за брокером — до этого момента
 * несколько брокеров могут одновременно быть «условно уникальными».
 *
 * Правила:
 *   1) Контакт в amo не найден или у него нет лидов → УНИКАЛЬНЫЙ.
 *   2) Все лиды контакта в финальных статусах (143 везде или КЦ 142) → УНИКАЛЬНЫЙ.
 *   3) Активный лид в «Новое обращение» / «Квалифицировали выводим на встречу»
 *      И к нему прикреплён хоть один брокер → УНИКАЛЬНЫЙ для следующего брокера.
 *   4) Любой другой активный статус (Встреча назначена / Сделка / Контроль оплаты
 *      и т.д.) → АЛАРМ, статус «В обработке», ручная проверка КЦ.
 *
 * Возвращает 'UNIQUE' если все лиды прошли, иначе 'ALARM'.
 */
export type UniquenessTriggerType =
  | 'DEFERRED_DEMAND'      // лид в «Отложенный спрос»
  | 'NEW_REQUEST_NO_BROKER' // активная стадия без привязанного брокера
  | 'ACTIVE_SALES';         // встреча назначена / сделка / контроль оплаты и т.д.

/**
 * 2026-06-11: правило реакции на новую фиксацию когда у клиента уже есть лид.
 *
 *   RULE_1 — старый лид в КЦ ранних стадиях (Неразобранное / Новое обращение /
 *            Недозвон / Отложенный спрос / Классифицировали). Прикрепляем
 *            нового брокера контактом + ALARM-задача КЦ. Нового лида НЕТ.
 *   RULE_2 — старый лид в КЦ-встречах (62907286, 142) ИЛИ в любой воронке
 *            продаж (активный статус). ALARM «подтвердить уникальность»
 *            на старый лид. Брокер НЕ прикрепляется. Нового лида НЕТ.
 *   RULE_3 — все лиды контакта закрыты (143). Создаём новый лид без ссылок.
 *   NO_CONFLICT — у контакта нет лидов (или контакт не найден). Создаём новый.
 */
export type FixationRule =
  | 'RULE_1'
  | 'RULE_2'
  | 'RULE_3'
  | 'NO_CONFLICT'
  // 2026-06-16: новый брокер пытается зафиксировать клиента, у которого
  // уже есть активная sales-карточка в стадии «Встреча проведена, думают»
  // / «Отложенный спрос» / «Устная бронь» / «Снята бронь». Создаём L2
  // в КЦ + прикрепляем брокера, но статус Client = UNDER_REVIEW.
  // Лифт в CONDITIONALLY_UNIQUE — когда L2 дойдёт до «Квалифицировали»
  // (62907282) или старая sales-карточка закроется 143.
  | 'RULE_EXCEPTION_AFTER_SALES_MEETING'
  // 2026-06-16: новый брокер пытается зафиксировать клиента, у которого
  // sales-карточка уже на «Платной брони» / «Подготовке» / «Сделке» /
  // «Сделке зарегистрирована» / «Контроле оплаты». Брокер A уже занял,
  // B не имеет смысла — REJECTED сразу, без создания новой карточки.
  | 'RULE_REJECT_SALES_DEAL';

export interface UniquenessVerdict {
  rule: FixationRule;
  reason: string;
  triggerLeadId?: number;
  /** @deprecated 2026-06-11: для обратной совместимости — RULE_1/RULE_2 = ALARM, иначе UNIQUE. */
  verdict: 'UNIQUE' | 'ALARM';
  /** @deprecated оставлено для совместимости со старым кодом ALARM-ветки. */
  triggerType?: UniquenessTriggerType;
}

export function evaluateUniqueness(
  leads: Array<{
    id: number;
    pipeline_id: number;
    status_id: number;
    hasBrokerAttached: boolean;
  }>,
): UniquenessVerdict {
  if (!leads || leads.length === 0) {
    return {
      rule: 'NO_CONFLICT',
      verdict: 'UNIQUE',
      reason: 'Контакт в amoCRM не найден или нет лидов',
    };
  }

  // Идём по всем лидам. Самое строгое побеждает:
  //   RULE_REJECT_SALES_DEAL > RULE_EXCEPTION_AFTER_SALES_MEETING > RULE_2 > RULE_1 > RULE_3
  let rejectDealTriggerLeadId: number | undefined;
  let rejectDealReason = '';
  let exceptionTriggerLeadId: number | undefined;
  let exceptionReason = '';
  // 2026-06-17 fix: КЦ-триггер для RULE_2 хранится отдельно от sales-триггера,
  // чтобы КЦ ВСЕГДА побеждал. Раньше первый встреченный (часто sales-дочерний)
  // занимал rule2TriggerLeadId и алармы не доходили до КЦ-карточки.
  // Лид 32216245 (КЦ Встреча назначена) + 32216249 (sales Встреча назначена):
  // sales побеждал, handleRule1Or2Alarm видел sales-pipeline и early-return.
  let rule2KcTriggerLeadId: number | undefined;
  let rule2KcReason = '';
  let rule2SalesTriggerLeadId: number | undefined;
  let rule2SalesReason = '';
  let rule1TriggerLeadId: number | undefined;
  let rule1Reason = '';

  for (const lead of leads) {
    // 143 / 142 — финал, не блокирует.
    if (isClosedLostStatus(lead.status_id)) continue;

    // 2026-06-16: разные стадии sales-pipeline → разные правила.
    if (isSalesPipeline(lead.pipeline_id)) {
      if (!rejectDealTriggerLeadId && isSalesDealStatus(lead.pipeline_id, lead.status_id)) {
        rejectDealTriggerLeadId = lead.id;
        rejectDealReason = `Лид ${lead.id} уже в сделке (pipeline=${lead.pipeline_id}, status=${lead.status_id}). Брокер B не уникален.`;
      } else if (!exceptionTriggerLeadId && isSalesExceptionStatus(lead.pipeline_id, lead.status_id)) {
        exceptionTriggerLeadId = lead.id;
        exceptionReason = `Лид ${lead.id} в средней стадии sales-pipeline (pipeline=${lead.pipeline_id}, status=${lead.status_id}). Брокер A на финишной прямой, B = UNDER_REVIEW.`;
      } else if (!rule2SalesTriggerLeadId && isSalesMeetingScheduledStatus(lead.pipeline_id, lead.status_id)) {
        // «Встреча назначена» в продажах = аналог КЦ RULE_2 (UNDER_REVIEW
        // без новой карточки). См. ответ пользователя 2026-06-16.
        rule2SalesTriggerLeadId = lead.id;
        rule2SalesReason = `Лид ${lead.id} в стадии «Встреча назначена» воронки продаж. Брокер не прикрепляется, требуется подтверждение от КЦ.`;
      }
      // Прочие статусы (если есть) — игнорим.
      continue;
    }

    if (!rule2KcTriggerLeadId && isFixationRule2Lead(lead.pipeline_id, lead.status_id)) {
      rule2KcTriggerLeadId = lead.id;
      rule2KcReason = `Лид ${lead.id} в активной стадии (pipeline=${lead.pipeline_id}, status=${lead.status_id}). Требуется подтверждение уникальности от КЦ.`;
    } else if (!rule1TriggerLeadId && isFixationRule1Lead(lead.pipeline_id, lead.status_id)) {
      rule1TriggerLeadId = lead.id;
      rule1Reason = `Лид ${lead.id} в КЦ-воронке (status=${lead.status_id}). Новый брокер добавлен контактом, КЦ-задача аларм.`;
    }
  }

  // КЦ-триггер всегда побеждает sales-триггер для RULE_2 — alarm должен попадать
  // в КЦ-карточку, где сидит менеджер.
  const rule2TriggerLeadId = rule2KcTriggerLeadId ?? rule2SalesTriggerLeadId;
  const rule2Reason = rule2KcTriggerLeadId ? rule2KcReason : rule2SalesReason;

  if (rejectDealTriggerLeadId) {
    return {
      rule: 'RULE_REJECT_SALES_DEAL',
      verdict: 'ALARM',
      triggerType: 'ACTIVE_SALES',
      triggerLeadId: rejectDealTriggerLeadId,
      reason: rejectDealReason,
    };
  }
  if (exceptionTriggerLeadId) {
    return {
      rule: 'RULE_EXCEPTION_AFTER_SALES_MEETING',
      verdict: 'ALARM',
      triggerType: 'ACTIVE_SALES',
      triggerLeadId: exceptionTriggerLeadId,
      reason: exceptionReason,
    };
  }
  if (rule2TriggerLeadId) {
    return {
      rule: 'RULE_2',
      verdict: 'ALARM',
      triggerType: 'ACTIVE_SALES',
      triggerLeadId: rule2TriggerLeadId,
      reason: rule2Reason,
    };
  }
  if (rule1TriggerLeadId) {
    return {
      rule: 'RULE_1',
      verdict: 'ALARM',
      triggerType: 'NEW_REQUEST_NO_BROKER',
      triggerLeadId: rule1TriggerLeadId,
      reason: rule1Reason,
    };
  }
  // Все лиды контакта либо закрыты (143), либо у контакта вообще не было активных лидов.
  return {
    rule: 'RULE_3',
    verdict: 'UNIQUE',
    reason: 'Все активные лиды контакта закрыты, создаём новый',
  };
}

export const BROKER_PIPELINE_ID = AMO_PIPELINES.BROKERS;

// Pipeline → Project (для маппинга в локальную БД)
export function pipelineToProject(pipelineId: number): 'ZORGE9' | 'SILVER_BOR' {
  if (pipelineId === AMO_PIPELINES.BERZARINA) return 'SILVER_BOR';
  return 'ZORGE9';
}

// Determine project from lead custom fields (e.g. "Объект интереса")
export function leadToProject(lead: any): 'ZORGE9' | 'SILVER_BOR' {
  const cf = lead?.custom_fields_values || [];
  const interest = cf.find((f: any) =>
    /объект интереса|объект|корпус/i.test(String(f?.field_name || '')),
  );
  const val = String(interest?.values?.[0]?.value || '').toLowerCase();
  if (/берзарин|серебр|silver/i.test(val)) return 'SILVER_BOR';
  if (/зорге|zorge/i.test(val)) return 'ZORGE9';
  return pipelineToProject(lead?.pipeline_id || 0);
}

// amoCRM lead status → local DealStatus
export function statusToDealStatus(statusId: number): 'PENDING' | 'SIGNED' | 'PAID' | 'COMMISSION_PAID' | 'CANCELLED' {
  if (statusId === AMO_STATUS_FINAL_LOST) return 'CANCELLED';
  if (statusId === AMO_STATUS_FINAL_WON) return 'PAID';
  // Правка 2026-05-13: amoCRM status 142 'Успешно реализовано' = клиент полностью
  // оплатил сделку. Это НЕ значит что компания выплатила комиссию брокеру —
  // выплата комиссии происходит позже, отдельным процессом, и должна
  // выставлять COMMISSION_PAID руками (через админку/финансиста).
  // Broker pipeline: "Сделка"
  if (statusId === AMO_BROKER_STAGE.DEAL) return 'SIGNED';
  // "Сделка зарегистрирована"
  if ([62907454, 62907382, 62907594, 28905292].includes(statusId)) return 'SIGNED';
  // "Контроль оплаты"
  if ([62907458, 62907386, 62907598, 33935695].includes(statusId)) return 'PAID';
  // "ДВОУ (Платная бронь)"
  if ([62907442, 62907370, 62907582, 33935671].includes(statusId)) return 'SIGNED';
  return 'PENDING';
}

// Status IDs where meeting was held (Встреча проведена и далее)
export const AMO_MEETING_HELD_STATUSES = new Set([
  // Воронка Зорге9 — от "Встреча проведена, думают" и далее
  62907430, 62907434, 62907438, 62907442, 62907446, 62907450, 62907454, 62907458,
  // Воронка Берзарина
  62907358, 62907362, 62907366, 62907370, 62907374, 62907378, 62907382, 62907386,
  // Воронка Толбухина
  62907570, 62907574, 62907578, 62907582, 62907586, 62907590, 62907594, 62907598,
  // Продажи
  28905214, 28905280, 33935671, 28905283, 28905289, 28905292, 33935695, 42176281,
  // Подогрев
  29126935,
  // Воронка брокеров — Сделка → встреча уже была
  AMO_BROKER_STAGE.DEAL,
  // Финальный "Успешно реализовано" / "Встреча проведена"
  142,
]);

export function mapMeetingStatus(statusId: number): 'PENDING' | 'COMPLETED' | 'CANCELLED' {
  if (statusId === 143) return 'CANCELLED';
  if (AMO_MEETING_HELD_STATUSES.has(statusId)) return 'COMPLETED';
  return 'PENDING';
}

// Status IDs that represent actual deals across all client pipelines
export const AMO_DEAL_STATUSES = new Set([
  // Воронка Зорге9
  62907450, 62907454, 62907458,
  // Воронка Берзарина
  62907378, 62907382, 62907386,
  // Воронка Толбухина
  62907590, 62907594, 62907598,
  // Продажи (старая)
  28905289, 28905292, 33935695,
  // Воронка брокеров — Сделка
  AMO_BROKER_STAGE.DEAL,
  // Финальный "Успешно реализовано"
  142,
]);

export function isDealStage(statusId: number): boolean {
  return AMO_DEAL_STATUSES.has(statusId);
}

export const AMO_CONTACT_FIELDS = {
  PHONE: 557903,
  EMAIL: 557905,
  POSITION: 557901,
  INN: 834489,
  IS_BROKER: 835415,         // checkbox "Брокер"
  AGENCY_NAME: 835417,       // text "Агенство"
  TELEGRAM_USERNAME: 835983,
  TELEGRAM_ID: 835985,
  WHATSAPP_USERNAME: 842321,
  BROKER_TOUR_VISITED: 842303,
  BROKER_TOUR_DATE: 842305,
  BLACKLIST: 834665,
  REGION: 589265,
  PRESENTATION_SENT: 835955,
  ADDITIONAL_COMPANIES: 842329,
  CORRESPONDENCE_ADDRESS: 558637,   // 2026-07-03: адрес корреспонденции агентства
} as const;

/**
 * 2026-07-03: реквизиты юр.лица агентства.
 * Обнаружены через inspect-amo-fields.js --entity companies.
 * Используются в agencyToAmoCompanyFields для синка Agency → amoCRM Company.
 */
export const AMO_COMPANY_FIELDS = {
  PHONE: 557903,               // multitext "Телефон"
  EMAIL: 557905,               // multitext "Email"
  ADDRESS: 557909,             // textarea "Адрес" (корреспонденции)
  LEGAL_NAME: 663905,          // text "Юр. лицо"
  LEGAL_ADDRESS: 663907,       // text "Юр. адрес"
  OGRN: 663909,                // text "ОГРН"
  INN: 663911,                 // text "ИНН"
  KPP: 663913,                 // text "КПП"
  BANK_BIK: 663915,            // text "БИК"
  BANK_NAME: 663917,           // text "Название банка"
  CORRESPONDENT_ACCOUNT: 663919, // text "Кор.счет"
  BANK_ACCOUNT: 663929,        // text "Рас.счет"
} as const;

/**
 * Маппинг Agency (Prisma) → массив custom_fields_values для amoCRM company
 * (POST /companies или PATCH /companies/{id}). Мапим только заполненные поля,
 * пустые пропускаем — amoCRM не любит пустые значения, они очищают поле.
 */
export function agencyToAmoCompanyFields(
  agency: {
    legalName?: string | null;
    legalAddress?: string | null;
    address?: string | null;
    inn?: string | null;
    ogrn?: string | null;
    kpp?: string | null;
    bankName?: string | null;
    bankBik?: string | null;
    bankAccount?: string | null;
    correspondentAccount?: string | null;
    phone?: string | null;
    email?: string | null;
  },
): any[] {
  const fields: any[] = [];
  const pushText = (field_id: number, value: string | null | undefined) => {
    if (value != null && String(value).trim().length > 0) {
      fields.push({ field_id, values: [{ value: String(value).trim() }] });
    }
  };
  pushText(AMO_COMPANY_FIELDS.LEGAL_NAME, agency.legalName);
  pushText(AMO_COMPANY_FIELDS.LEGAL_ADDRESS, agency.legalAddress);
  pushText(AMO_COMPANY_FIELDS.ADDRESS, agency.address);
  pushText(AMO_COMPANY_FIELDS.INN, agency.inn);
  pushText(AMO_COMPANY_FIELDS.OGRN, agency.ogrn);
  pushText(AMO_COMPANY_FIELDS.KPP, agency.kpp);
  pushText(AMO_COMPANY_FIELDS.BANK_NAME, agency.bankName);
  pushText(AMO_COMPANY_FIELDS.BANK_BIK, agency.bankBik);
  pushText(AMO_COMPANY_FIELDS.BANK_ACCOUNT, agency.bankAccount);
  pushText(AMO_COMPANY_FIELDS.CORRESPONDENT_ACCOUNT, agency.correspondentAccount);
  // Телефон/email — multitext, требуют enum_code (WORK) чтобы попасть в амо
  // в правильную «строчку» (WORK/HOME/OTHER).
  if (agency.phone && agency.phone.trim()) {
    fields.push({
      field_id: AMO_COMPANY_FIELDS.PHONE,
      values: [{ value: agency.phone.trim(), enum_code: 'WORK' }],
    });
  }
  if (agency.email && agency.email.trim()) {
    fields.push({
      field_id: AMO_COMPANY_FIELDS.EMAIL,
      values: [{ value: agency.email.trim(), enum_code: 'WORK' }],
    });
  }
  return fields;
}

/**
 * Маппинг Broker (Prisma модель) в массив custom_fields_values для amoCRM
 * contact update. Источник истины — БД нашего кабинета: всё что заполнено
 * в Broker и связанной primary Agency идёт в amo при ЛЮБОМ изменении
 * профиля (register, PATCH /auth/me, изменение из админки и т.д.).
 *
 * Поля Broker, у которых НЕТ field_id в amo (пока не маппятся):
 * - birthDate (нет AMO_CONTACT_FIELDS.BIRTH_DATE — нужно узнать ID)
 * - specialization (COMM/RESIDENTIAL/BOTH — нужно поле в amo)
 * - bestCallTime (нет в amo)
 * - isCoordinator / coordinatorAgency (нет в amo)
 *
 * Поля amo, для которых нет колонки в Broker (нужны в БД, чтобы заполнять):
 * - POSITION (должность)
 * - TELEGRAM_USERNAME, TELEGRAM_ID, WHATSAPP_USERNAME
 * - PRESENTATION_SENT, ADDITIONAL_COMPANIES
 */
export function brokerToAmoContactFields(
  broker: {
    phone?: string | null;
    email?: string | null;
    region?: string | null;
    position?: string | null;
    telegramUsername?: string | null;
    telegramId?: string | null;
    whatsappUsername?: string | null;
    presentationSent?: boolean | null;
    brokerTourVisited?: boolean | null;
    brokerTourDate?: Date | string | null;
    doNotCall?: boolean | null;
  },
  agency?: { name?: string | null; inn?: string | null; address?: string | null } | null,
): any[] {
  const fields: any[] = [];

  // Контакт всегда помечается флагом "Брокер" — это критерий поиска
  // в /admin/brokers/import-from-amo.
  fields.push({ field_id: AMO_CONTACT_FIELDS.IS_BROKER, values: [{ value: true }] });

  // 2026-07-03: адрес корреспонденции агентства → поле "Адрес корреспонденции"
  // в карточке контакта (id=558637). Остальные реквизиты юр.лица идут в
  // связанную компанию (см. agencyToAmoCompanyFields).
  if (agency?.address) {
    fields.push({
      field_id: AMO_CONTACT_FIELDS.CORRESPONDENCE_ADDRESS,
      values: [{ value: String(agency.address) }],
    });
  }

  if (broker.phone) {
    fields.push({
      field_id: AMO_CONTACT_FIELDS.PHONE,
      values: [{ value: broker.phone, enum_code: 'WORK' }],
    });
  }
  if (broker.email) {
    fields.push({
      field_id: AMO_CONTACT_FIELDS.EMAIL,
      values: [{ value: broker.email, enum_code: 'WORK' }],
    });
  }
  if (broker.position) {
    fields.push({ field_id: AMO_CONTACT_FIELDS.POSITION, values: [{ value: broker.position }] });
  }
  if (agency?.inn) {
    fields.push({ field_id: AMO_CONTACT_FIELDS.INN, values: [{ value: agency.inn }] });
  }
  if (agency?.name) {
    fields.push({ field_id: AMO_CONTACT_FIELDS.AGENCY_NAME, values: [{ value: agency.name }] });
  }
  if (broker.telegramUsername) {
    fields.push({
      field_id: AMO_CONTACT_FIELDS.TELEGRAM_USERNAME,
      values: [{ value: broker.telegramUsername }],
    });
  }
  if (broker.telegramId) {
    fields.push({
      field_id: AMO_CONTACT_FIELDS.TELEGRAM_ID,
      values: [{ value: broker.telegramId }],
    });
  }
  if (broker.whatsappUsername) {
    fields.push({
      field_id: AMO_CONTACT_FIELDS.WHATSAPP_USERNAME,
      values: [{ value: broker.whatsappUsername }],
    });
  }
  if (broker.region) {
    fields.push({ field_id: AMO_CONTACT_FIELDS.REGION, values: [{ value: broker.region }] });
  }
  if (broker.brokerTourVisited) {
    fields.push({
      field_id: AMO_CONTACT_FIELDS.BROKER_TOUR_VISITED,
      values: [{ value: true }],
    });
  }
  if (broker.brokerTourDate) {
    const d = new Date(broker.brokerTourDate);
    if (!isNaN(d.getTime())) {
      fields.push({
        field_id: AMO_CONTACT_FIELDS.BROKER_TOUR_DATE,
        values: [{ value: Math.floor(d.getTime() / 1000) }],
      });
    }
  }
  if (broker.presentationSent) {
    fields.push({
      field_id: AMO_CONTACT_FIELDS.PRESENTATION_SENT,
      values: [{ value: true }],
    });
  }
  if (broker.doNotCall) {
    fields.push({ field_id: AMO_CONTACT_FIELDS.BLACKLIST, values: [{ value: true }] });
  }

  return fields;
}

/**
 * Custom field IDs on Lead entity. Discovered 2026-05-12 via inspect-lead/32112013.
 * Применяются при синхронизации сделок (amocrm.service.ts, scheduler.service.ts).
 */
export const AMO_LEAD_FIELDS = {
  // Метраж сделки в м² — основное поле для расчёта commission level.
  // Раньше всегда было 0, поэтому level=START.
  SQM: 604555,                       // text "Метраж, м2"
  // ID помещения в Profitbase — для привязки к Lot.
  PROFITBASE_LOT_ID: 604559,         // text "ID помещения"
  PRICE_PER_SQM: 604557,             // text "Цена за м2, руб"
  FLOOR: 604551,                     // text "Этаж"
  BUILDING: 604547,                  // text "Дом" (например "Корпус 1. Gold")
  ROOMS_COUNT: 617501,               // text "Кол-во комнат"
  LIVING_AREA: 617505,               // text "Жилая площадь"
  PRICE_NO_DISCOUNT: 833045,         // text "Стоимость без скидок, руб"
  PRICE_WITH_DISCOUNT: 833069,       // text "Стоимость с учетом скидки, руб"
  PRICE_DDU: 833065,                 // text "Стоимость в ДДУ, руб"
  CONTRACT_NUMBER: 558577,           // text "№ договора"
  CONTRACT_TYPE: 617493,             // text "Тип договора" (fz214 и т.д.)
  CONTRACT_DATE: 558353,             // date "Дата договора" (unix sec)
  // Объект интереса (используется как fallback к pipeline_id для маппинга проекта).
  INTEREST_OBJECT: 839179,           // text "Объект интереса"
  // ДЕДУПЛИКАЦИЯ: amoCRM хранит связь между дубликатами карточек.
  // У дочерней карточки cc_id_parent указывает на ID родительской.
  // Используем это для объединения дублей при синке.
  CC_ID_PARENT: 839249,              // text "cc_id_parent" — id парной сделки
  // Ссылка на сделку в "Воронке брокеров" (третья копия одной и той же сделки).
  BROKER_PIPELINE_LINK: 842387,      // text "Сделка в Брокерах"
  // Комиссия — проставляется руками менеджером в amoCRM. Авторитет, не считаем локально.
  COMMISSION_AMOUNT: 673171,         // text "Комиссия в руб."
  COMMISSION_RATE: 673169,           // text "Комиссия брокера в %"
  // Поля воронки КЦ (используются при createFixationRequest) — узнаны
  // через debug-endpoint 2026-05-22.
  FROM_BROKER: 665195,               // radiobutton "От брокера"
  PURCHASE_TIMING: 612517,           // select "Планирует покупку в срок"
  READINESS_LEVEL: 839449,           // select "Готовность к сделке"
  QUESTIONNAIRE_FILLED: 842273,      // select "Опросник заполнен"
  BROKER_REQUEST_DATE: 833189,       // date "Дата создания заявки от брокера" (unix sec)
  // 2026-06-09: UTM / tracking / calltouch / mango поля КЦ-воронки.
  // Морикит проставляет эти поля при настоящих заявках («Заявка от брокера»
  // как маркер источника). Для наших фиксаций тоже их заполняем, чтобы
  // в amo лид выглядел как от брокера (вкладка «utm» в карточке лида).
  // Узнаны через GET /api/v4/leads/32205511 («Дмитрий от Ивана» — пример).
  UTM_SOURCE: 618551,
  UTM_MEDIUM: 618553,
  UTM_CAMPAIGN: 618555,
  UTM_CONTENT: 618557,
  UTM_TERM: 618559,
  EMAIL_MARKER: 618543,                  // поле «Email» во вкладке utm (не контакта)
  COMMENT_TO_REQUEST: 618547,            // «Комментарий к заявке»
  REQUEST_THEME: 618545,                 // «Тема заявки»
  CREATED_FROM: 618511,                  // «Создана из»
  UPDATED_FROM: 667383,                  // «Обновлена из»
  LANDING_PAGE: 618563,                  // «Страница входа на сайт» (URL)
  TRACKED_SITE: 618561,                  // «Отслеживаемый сайт» (URL)
  REFERRER_PAGE: 618565,                 // «Страница реферального перехода» (URL)
  COMPLETION_PAGE: 618567,               // «Страница выполнения обращения» (URL)
  TRACKED_NUMBER: 618521,                // «Отслеживаемый номер»
  REDIRECT_NUMBER: 618519,               // «Номер переадресации»
  CLIENT_NUMBER: 618517,                 // «Номер клиента»
  REQUEST_TIME: 618527,                  // «Время обращения»
  CALLTOUCH_REQUEST_ID: 618579,          // «ID заявки в Calltouch»
  MANGO_LINE_NUMBER: 605883,             // «Номер линии MANGO OFFICE»
  YANDEX_CLIENT_ID: 618589,
  GOOGLE_CLIENT_ID: 618587,
  CALLTOUCH_CLIENT_ID: 618585,
  CALLTOUCH_CALL_ID: 618577,
  OS_FIELD: 618573,                      // «Операционная система»
  BROWSER_FIELD: 618575,                 // «Браузер»
  SESSION_ID: 618583,
  CLIENT_NAME_TRACKING: 618541,          // «Имя клиента» (поле трекинга, не основное)
  RECORDING_URL: 618535,                 // «Скачать запись» (URL)
  CITY: 618569,                          // «Город»
  PBX_CALL_ID: 618581,                   // «ID звонка в АТС»
  CALL_DURATION: 618529,                 // «Длительность»
  CALL_WAIT_TIME: 618531,                // «Ожидание»
  DOC_SOURCE: 820653,                    // «источник для документов» («внешний»)
  BROKER_REQUEST_NUMBER: 667539,         // «Номер заявки брокера»
} as const;

/**
 * 2026-06-09: маркер-значение, которое Morekit ставит во все UTM/tracking
 * поля для лидов от брокера. Мы повторяем то же поведение чтобы вкладка
 * «utm» в карточке лида не была пустой.
 */
export const BROKER_SOURCE_MARKER = 'Заявка от брокера';
export const BROKER_SOURCE_URL_MARKER = 'http://Заявка от брокера';

/**
 * Build массив custom_fields_values для маркеров «Заявка от брокера»
 * (текстовые + URL-поля), которые проставляются на всех брокерских лидах.
 */
export function brokerLeadMarkerFields(brokerRequestNumber?: string | number): any[] {
  const TEXT = BROKER_SOURCE_MARKER;
  const URL = BROKER_SOURCE_URL_MARKER;
  const fields: any[] = [
    // UTM
    { field_id: AMO_LEAD_FIELDS.UTM_SOURCE,           values: [{ value: TEXT }] },
    { field_id: AMO_LEAD_FIELDS.UTM_MEDIUM,           values: [{ value: TEXT }] },
    { field_id: AMO_LEAD_FIELDS.UTM_CAMPAIGN,         values: [{ value: TEXT }] },
    { field_id: AMO_LEAD_FIELDS.UTM_CONTENT,          values: [{ value: TEXT }] },
    { field_id: AMO_LEAD_FIELDS.UTM_TERM,             values: [{ value: TEXT }] },
    // 2026-06-14: COMMENT_TO_REQUEST тоже маркер «Заявка от брокера» —
    // как у эталонных Морикит-лидов. Реальный комментарий брокера уходит
    // в ноту лида, а не в это поле трекинга.
    { field_id: AMO_LEAD_FIELDS.COMMENT_TO_REQUEST,   values: [{ value: TEXT }] },
    { field_id: AMO_LEAD_FIELDS.EMAIL_MARKER,         values: [{ value: TEXT }] },
    { field_id: AMO_LEAD_FIELDS.REQUEST_THEME,        values: [{ value: TEXT }] },
    { field_id: AMO_LEAD_FIELDS.CREATED_FROM,         values: [{ value: TEXT }] },
    { field_id: AMO_LEAD_FIELDS.UPDATED_FROM,         values: [{ value: TEXT }] },
    // URL поля
    { field_id: AMO_LEAD_FIELDS.LANDING_PAGE,         values: [{ value: URL  }] },
    { field_id: AMO_LEAD_FIELDS.TRACKED_SITE,         values: [{ value: URL  }] },
    { field_id: AMO_LEAD_FIELDS.REFERRER_PAGE,        values: [{ value: URL  }] },
    { field_id: AMO_LEAD_FIELDS.COMPLETION_PAGE,      values: [{ value: URL  }] },
    { field_id: AMO_LEAD_FIELDS.RECORDING_URL,        values: [{ value: URL  }] },
    // Calltouch / Mango / Tracking
    { field_id: AMO_LEAD_FIELDS.TRACKED_NUMBER,       values: [{ value: TEXT }] },
    { field_id: AMO_LEAD_FIELDS.REDIRECT_NUMBER,      values: [{ value: TEXT }] },
    { field_id: AMO_LEAD_FIELDS.CLIENT_NUMBER,        values: [{ value: TEXT }] },
    { field_id: AMO_LEAD_FIELDS.REQUEST_TIME,         values: [{ value: TEXT }] },
    { field_id: AMO_LEAD_FIELDS.CALLTOUCH_REQUEST_ID, values: [{ value: TEXT }] },
    { field_id: AMO_LEAD_FIELDS.MANGO_LINE_NUMBER,    values: [{ value: TEXT }] },
    { field_id: AMO_LEAD_FIELDS.YANDEX_CLIENT_ID,     values: [{ value: TEXT }] },
    { field_id: AMO_LEAD_FIELDS.GOOGLE_CLIENT_ID,     values: [{ value: TEXT }] },
    { field_id: AMO_LEAD_FIELDS.CALLTOUCH_CLIENT_ID,  values: [{ value: TEXT }] },
    { field_id: AMO_LEAD_FIELDS.CALLTOUCH_CALL_ID,    values: [{ value: TEXT }] },
    { field_id: AMO_LEAD_FIELDS.OS_FIELD,             values: [{ value: TEXT }] },
    { field_id: AMO_LEAD_FIELDS.BROWSER_FIELD,        values: [{ value: TEXT }] },
    { field_id: AMO_LEAD_FIELDS.SESSION_ID,           values: [{ value: TEXT }] },
    { field_id: AMO_LEAD_FIELDS.CLIENT_NAME_TRACKING, values: [{ value: TEXT }] },
    { field_id: AMO_LEAD_FIELDS.CITY,                 values: [{ value: TEXT }] },
    { field_id: AMO_LEAD_FIELDS.PBX_CALL_ID,          values: [{ value: TEXT }] },
    { field_id: AMO_LEAD_FIELDS.CALL_DURATION,        values: [{ value: TEXT }] },
    { field_id: AMO_LEAD_FIELDS.CALL_WAIT_TIME,       values: [{ value: TEXT }] },
    // Брокерские мета-поля
    { field_id: AMO_LEAD_FIELDS.DOC_SOURCE,           values: [{ value: 'внешний' }] },
  ];
  if (brokerRequestNumber !== undefined && brokerRequestNumber !== null && String(brokerRequestNumber).length > 0) {
    fields.push({ field_id: AMO_LEAD_FIELDS.BROKER_REQUEST_NUMBER, values: [{ value: String(brokerRequestNumber) }] });
  }
  return fields;
}

// Enum values для select/radio полей лида КЦ.
export const AMO_LEAD_ENUMS = {
  FROM_BROKER_YES: 985337,
  FROM_BROKER_NO: 985339,
  // Готовность к сделке
  READINESS_HOT: 1025401,            // ☀️ Горячий
  READINESS_WARM: 1025403,           // ⛅️ Тёплый
  READINESS_COLD: 1025405,           // ❄️ Холодный
  // Опросник заполнен
  QUESTIONNAIRE_YES: 1028039,
  QUESTIONNAIRE_NO: 1028041,
  // Планирует покупку
  PURCHASE_1_TO_3_MONTHS: 890509,
  PURCHASE_3_TO_6_MONTHS: 890511,
  PURCHASE_OVER_5_MONTHS: 890513,    // в amo это «от 5 месяцев»
  PURCHASE_NOT_CLARIFIED: 891589,
} as const;

// Маппинг из строки UI в enum_id amoCRM для readinessLevel.
export function readinessLevelToEnumId(value: string | null | undefined): number | null {
  if (!value) return null;
  const v = value.toLowerCase().replace(/[^а-яё]/g, '');
  if (v.includes('горяч')) return AMO_LEAD_ENUMS.READINESS_HOT;
  if (v.includes('тёпл') || v.includes('тепл')) return AMO_LEAD_ENUMS.READINESS_WARM;
  if (v.includes('холод')) return AMO_LEAD_ENUMS.READINESS_COLD;
  return null;
}

// Маппинг purchaseTiming из строки UI в enum_id amoCRM.
export function purchaseTimingToEnumId(value: string | null | undefined): number | null {
  if (!value) return null;
  const v = value.toLowerCase();
  if (v.includes('1') && v.includes('3')) return AMO_LEAD_ENUMS.PURCHASE_1_TO_3_MONTHS;
  if (v.includes('3') && v.includes('6')) return AMO_LEAD_ENUMS.PURCHASE_3_TO_6_MONTHS;
  if (v.includes('6') || v.includes('12') || v.includes('более')) return AMO_LEAD_ENUMS.PURCHASE_OVER_5_MONTHS;
  if (v.includes('выясн') || v.includes('не указ')) return AMO_LEAD_ENUMS.PURCHASE_NOT_CLARIFIED;
  return null;
}

/**
 * Helper: достать значение custom field по field_id.
 * Возвращает строку или null.
 */
export function getLeadCustomFieldValue(lead: any, fieldId: number): string | null {
  const cf = (lead?.custom_fields_values || []).find((f: any) => f?.field_id === fieldId);
  const v = cf?.values?.[0]?.value;
  return v != null && v !== '' ? String(v) : null;
}

/**
 * Helper: достать число из custom field. Возвращает 0 если нет/невалид.
 */
export function getLeadCustomFieldNumber(lead: any, fieldId: number): number {
  const v = getLeadCustomFieldValue(lead, fieldId);
  if (!v) return 0;
  // Поля типа "46.85" или "29637780" — стандартный парсинг.
  const n = Number(String(v).replace(/\s/g, '').replace(/,/g, '.'));
  return isNaN(n) ? 0 : n;
}
