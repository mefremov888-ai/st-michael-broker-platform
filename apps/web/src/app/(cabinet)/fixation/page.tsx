'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiGet, apiPost } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Plus, Trash2, CheckCircle2, X } from 'lucide-react';

interface Participant {
  firstName: string;
  lastName: string;
  phone: string;
}

// Форматирование 10 цифр в +7 (XXX) XXX-XX-XX (правка 2026-05-14).
function formatPhoneFromDigits(digits10: string): string {
  if (!digits10) return '';
  const d = digits10.padEnd(10, '_').slice(0, 10);
  let out = '+7';
  if (digits10.length > 0) out += ' (' + d.slice(0, 3).replace(/_/g, '');
  if (digits10.length >= 3) out = '+7 (' + d.slice(0, 3) + ')';
  if (digits10.length > 3) out += ' ' + d.slice(3, 6).replace(/_/g, '');
  if (digits10.length >= 6) out = '+7 (' + d.slice(0, 3) + ') ' + d.slice(3, 6);
  if (digits10.length > 6) out += '-' + d.slice(6, 8).replace(/_/g, '');
  if (digits10.length >= 8) out = '+7 (' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6, 8);
  if (digits10.length > 8) out += '-' + d.slice(8, 10).replace(/_/g, '');
  return out;
}

// Форматирование числа с разделителями тысяч пробелами (для бюджета).
function formatMoney(raw: string): string {
  const d = raw.replace(/\D/g, '');
  if (!d) return '';
  return d.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

export default function FixationPage() {
  const router = useRouter();
  const { broker } = useAuth();

  const [isForeign, setIsForeign] = useState(false); // правка 2026-05-14: иностранные номера
  const [phoneDigits, setPhoneDigits] = useState(''); // только цифры для RU +7
  const [foreignPhone, setForeignPhone] = useState(''); // raw text для иностранных
  // Bug fix 2026-06-02: тип недвижимости должен соответствовать проекту.
  // Зорге 9 — апарт-комплекс, Серебряный бор — жилой (квартиры).
  // Коммерческие площади есть в обоих корпусах.
  const propertyTypesByProject: Record<string, Array<'Квартира' | 'Апартаменты' | 'Коммерческая'>> = {
    ZORGE9: ['Апартаменты', 'Коммерческая'],
    SILVER_BOR: ['Квартира', 'Коммерческая'],
  };
  const [firstName, setFirstName] = useState('');
  const [email, setEmail] = useState(''); // правка 2026-05-15: необязательное
  const [lastName, setLastName] = useState('');
  const [project, setProject] = useState('ZORGE9');
  // Тип недвижимости зависит от проекта: Зорге 9 — апартаменты, Серебряный
  // бор (Берзарина 37) — квартиры. Коммерческие помещения есть в обоих.
  // Bug fix 2026-06-02: «Квартира» для Зорге была доступна — это ошибка.
  const [propertyType, setPropertyType] = useState<'Квартира' | 'Апартаменты' | 'Коммерческая'>('Апартаменты');

  // При смене проекта — переключаем тип, если текущее значение
  // не входит в допустимые для проекта.
  useEffect(() => {
    const allowed = propertyTypesByProject[project] || [];
    if (allowed.length && !allowed.includes(propertyType)) {
      setPropertyType(allowed[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);
  const [roomsCount, setRoomsCount] = useState<string>(''); // студия/1/2/3/4+
  const [sqm, setSqm] = useState('');
  const [amount, setAmount] = useState(''); // raw digits
  const [participants, setParticipants] = useState<Participant[]>([]);
  // Правка 2026-05-22: новые поля по КБ3 (amo интеграция).
  // 2026-06-11: убрано поле clientRegion — лишняя информация для брокера.
  const [presentationSent, setPresentationSent] = useState(false);
  const [purchaseTiming, setPurchaseTiming] = useState('');
  const [readinessLevel, setReadinessLevel] = useState<'Холодный' | 'Тёплый' | 'Горячий' | ''>('Тёплый');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showSuccess, setShowSuccess] = useState(false);
  // КБ7 (2026-05-26): пользователь нажал «Отправить» хотя бы раз —
  // с этого момента подсвечиваем красным невалидные поля и пишем
  // под каждым «Заполните это поле». До первой попытки не дёргаем.
  const [attempted, setAttempted] = useState(false);
  // 2026-05-25: если amo упал — показываем брокеру предупреждение и
  // список менеджеров с телефонами, чтобы он мог позвонить напрямую.
  const [amoWarn, setAmoWarn] = useState<{
    message: string;
    managers: { fullName: string; phone: string; telegram: string | null }[];
  } | null>(null);

  // 2026-07-01: dropdown «Я фиксирую от агентства» убран. brokerAgency
  // всегда = primary агентство брокера (или первое если primary нет).
  const myAgencies = (broker?.agencies || []) as Array<{ id: string; name: string; inn: string; isPrimary?: boolean }>;
  const brokerAgency = myAgencies.find((a) => a.isPrimary) || myAgencies[0];

  // 2026-06-29 (refactor): убрали флаг координатора. Теперь любой брокер
  // может фиксировать клиента на другого брокера (новый создаётся прямо
  // здесь, в секции «Брокер»).
  // - `respMode = 'self'` — фиксирую на себя (по умолчанию).
  // - `respMode = 'other'` — поля ниже разворачиваются, брокер вводит
  //   данные нового, при submit фиксации он создаётся + назначается
  //   responsibleBrokerId.
  const [respMode, setRespMode] = useState<'self' | 'other'>('self');
  const [respSelected, setRespSelected] = useState<{ id: string; fullName: string; phone: string } | null>(null);
  // Поля «другого брокера» в секции снизу формы фиксации.
  const [otherLastName, setOtherLastName] = useState('');
  const [otherFirstName, setOtherFirstName] = useState('');
  const [otherMiddleName, setOtherMiddleName] = useState('');
  const [otherPhone, setOtherPhone] = useState(''); // 10 цифр без +7
  const [otherEmail, setOtherEmail] = useState('');
  // 2026-07-01: ИНН и dropdown агентства убраны из формы. Новый брокер
  // автоматически привязывается к primary агентству того кто фиксирует.
  const [otherError, setOtherError] = useState<{ field?: string; message: string } | null>(null);
  const [otherCreating, setOtherCreating] = useState(false);

  // Сбросить выбранного брокера при переключении на «на себя».
  useEffect(() => {
    if (respMode === 'self') {
      setRespSelected(null);
      setOtherError(null);
    }
  }, [respMode]);

  // Создание нового брокера (вызывается из handleSubmit основной формы,
  // если respMode='other' и respSelected ещё не выбран — то есть пользователь
  // ввёл данные нового брокера, но не «применил» отдельно).
  const ensureOtherBrokerCreated = async (): Promise<{ id: string; fullName: string; phone: string } | null> => {
    if (respSelected) return respSelected;
    setOtherError(null);
    const fullName = [otherLastName, otherFirstName, otherMiddleName].filter(Boolean).join(' ').trim();
    if (!fullName || fullName.length < 2) {
      setOtherError({ field: 'fullName', message: 'Введите фамилию и имя нового брокера' });
      return null;
    }
    if (otherPhone.length !== 10) {
      setOtherError({ field: 'phone', message: 'Введите 10 цифр номера' });
      return null;
    }
    if (otherEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(otherEmail)) {
      setOtherError({ field: 'email', message: 'Неверный формат email' });
      return null;
    }
    setOtherCreating(true);
    try {
      // 2026-07-01: agencyId/customInn больше не отправляем — бэк сам
      // подставит primary агентство того кто фиксирует.
      const r: any = await apiPost('/clients/create-new-broker', {
        fullName,
        phone: '+7' + otherPhone,
        email: otherEmail.trim() || undefined,
      });
      if (r?.broker) {
        const created = { id: r.broker.id, fullName: r.broker.fullName, phone: r.broker.phone };
        setRespSelected(created);
        return created;
      }
      setOtherError({ message: 'Не удалось создать брокера' });
      return null;
    } catch (e: any) {
      const raw = e?.response?.data || e;
      setOtherError({
        field: raw?.field,
        message: raw?.message || e?.message || 'Не удалось создать брокера',
      });
      return null;
    } finally {
      setOtherCreating(false);
    }
  };

  const addParticipant = () => {
    setParticipants([...participants, { firstName: '', lastName: '', phone: '' }]);
  };

  const removeParticipant = (i: number) => {
    setParticipants(participants.filter((_, idx) => idx !== i));
  };

  const updateParticipant = (i: number, field: keyof Participant, value: string) => {
    setParticipants(participants.map((p, idx) => idx === i ? { ...p, [field]: value } : p));
  };

  const updateParticipantPhone = (i: number, raw: string) => {
    // Извлекаем цифры. Поддерживаем paste полного номера:
    // «+79991234567», «89991234567», «79991234567» → «9991234567».
    let d = raw.replace(/\D/g, '');
    if (d.length === 11 && (d[0] === '7' || d[0] === '8')) d = d.slice(1);
    updateParticipant(i, 'phone', d.slice(0, 10));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAttempted(true);
    // КБ7: валидируем перед отправкой.
    const foreignD = foreignPhone.replace(/\D/g, '').length;
    const phoneOk = isForeign ? foreignD >= 7 : phoneDigits.length === 10;
    if (!phoneOk || !firstName.trim() || !sqm || !amount || !brokerAgency?.inn) {
      setError('Заполните все обязательные поля (отмечены красным)');
      setTimeout(() => {
        const el = document.querySelector('.field-invalid') as HTMLElement | null;
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 50);
      return;
    }

    // 2026-06-29 (refactor): если выбран режим «на другого брокера» —
    // сначала создаём (или находим existing по дублю телефона) брокера,
    // потом продолжаем фиксацию с responsibleBrokerId = его id.
    let responsibleBroker: { id: string; fullName: string; phone: string } | null = null;
    if (respMode === 'other') {
      responsibleBroker = await ensureOtherBrokerCreated();
      if (!responsibleBroker) {
        // Ошибка показалась через setOtherError, прокручиваем туда.
        setTimeout(() => {
          const el = document.querySelector('[data-other-broker-section]') as HTMLElement | null;
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 50);
        return;
      }
    }

    setLoading(true);
    setError('');

    const fullName = (lastName ? `${lastName} ${firstName}` : firstName).trim();
    // Нормализация телефона: для RU '+7' + 10 цифр, для иностранного — '+<digits>'.
    let phone: string;
    if (isForeign) {
      const digits = foreignPhone.replace(/\D/g, '');
      phone = digits ? '+' + digits : '';
    } else {
      phone = '+7' + phoneDigits;
    }

    const payload = {
      phone,
      fullName,
      // 2026-07-02: trim + falsy → undefined. Раньше email со случайным
      // пробелом падал в zod .email() → «Поле email: неверный формат».
      email: email.trim() || undefined,
      project,
      agencyInn: brokerAgency?.inn || '',
      propertyType,
      roomsCount: roomsCount || undefined,
      amount: amount ? Number(amount) : undefined,
      sqm: sqm ? Number(sqm) : undefined,
      presentationSent,
      purchaseTiming: purchaseTiming || undefined,
      readinessLevel: readinessLevel || undefined,
      participants: participants
        .filter((p) => p.firstName || p.lastName || p.phone)
        .map((p) => ({
          firstName: p.firstName,
          lastName: p.lastName,
          phone: p.phone ? '+7' + p.phone : '',
        })),
      ...(respMode === 'other' && responsibleBroker ? { responsibleBrokerId: responsibleBroker.id } : {}),
    };

    try {
      const result: any = await apiPost('/clients/fix', payload);
      // 2026-05-26: если бэк говорит «уже есть твой клиент» — спрашиваем
      // подтверждение и при OK повторяем с confirmDuplicate=true.
      if (result?.status === 'REQUIRES_CONFIRMATION') {
        const fmt = (s: any) => s ? new Date(s).toLocaleDateString('ru-RU') : '—';
        const ec = result.existingClient || {};
        const ok = window.confirm(
          `${result.message}\n\n` +
          `Существующая фиксация:\n` +
          `• ${ec.fullName} (${ec.phone})\n` +
          `• Статус: ${ec.uniquenessStatus}\n` +
          `• Создана: ${fmt(ec.createdAt)}\n` +
          `• Активна до: ${fmt(ec.uniquenessExpiresAt)}\n` +
          `• Сделок: ${ec.dealsCount}\n\n` +
          `Создать новую фиксацию всё равно?`
        );
        if (!ok) { setLoading(false); return; }
        const result2: any = await apiPost('/clients/fix', { ...payload, confirmDuplicate: true });
        if (result2?.amoSyncStatus === 'FAILED' && Array.isArray(result2?.managerContacts)) {
          setAmoWarn({
            message: result2.message || 'Заявка сохранена в кабинете, но не передана в amoCRM.',
            managers: result2.managerContacts,
          });
        }
        setShowSuccess(true);
      } else {
        if (result?.amoSyncStatus === 'FAILED' && Array.isArray(result?.managerContacts)) {
          setAmoWarn({
            message: result.message || 'Заявка сохранена в кабинете, но не передана в amoCRM.',
            managers: result.managerContacts,
          });
        }
        setShowSuccess(true);
      }
    } catch (err: any) {
      setError(err.message || 'Ошибка при отправке заявки');
    }

    setLoading(false);
  };

  const resetForm = () => {
    setPhoneDigits('');
    setForeignPhone('');
    setIsForeign(false);
    setFirstName('');
    setEmail('');
    setLastName('');
    setProject('ZORGE9');
    setPropertyType('Апартаменты');
    setRoomsCount('');
    setSqm('');
    setAmount('');
    setParticipants([]);
    setPresentationSent(false);
    setPurchaseTiming('');
    setReadinessLevel('Тёплый');
    setShowSuccess(false);
    setAmoWarn(null);
  };

  const brokerPhoneDisplay = broker?.phone || '—';
  const brokerNameDisplay = broker?.fullName || '—';
  // Минимум для submit: валидный телефон + имя + метраж + сумма + ИНН агентства.
  const foreignDigitsCount = foreignPhone.replace(/\D/g, '').length;
  const phoneValid = isForeign ? foreignDigitsCount >= 7 : phoneDigits.length === 10;
  const canSubmit = phoneValid && !!firstName && !!sqm && !!amount && !!brokerAgency?.inn;

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl md:text-3xl font-bold mb-6">Фиксация клиента</h1>

      <div className="card">
        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="label mb-0">Телефон клиента *</label>
              <label className="text-xs text-text-muted flex items-center gap-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isForeign}
                  onChange={(e) => { setIsForeign(e.target.checked); setPhoneDigits(''); setForeignPhone(''); }}
                />
                Иностранный номер
              </label>
            </div>
            {!isForeign ? (
              <>
                <div className="flex">
                  <span className={`inline-flex items-center px-3 bg-surface-secondary border border-r-0 rounded-l text-text-muted text-sm ${attempted && phoneDigits.length !== 10 ? 'border-error field-invalid' : 'border-border'}`}>+7</span>
                  <input
                    type="tel"
                    className={`input rounded-l-none ${attempted && phoneDigits.length !== 10 ? 'border-error field-invalid' : ''}`}
                    placeholder="(999) 123-45-67"
                    // value — отформатированный «(999) 123-45-67» от текущих phoneDigits.
                    // При onChange — извлекаем только цифры (не больше 10).
                    value={(() => {
                      const d = phoneDigits;
                      if (!d) return '';
                      let out = '(' + d.slice(0, 3);
                      if (d.length > 3) out += ') ' + d.slice(3, 6);
                      if (d.length > 6) out += '-' + d.slice(6, 8);
                      if (d.length > 8) out += '-' + d.slice(8, 10);
                      return out;
                    })()}
                    onChange={(e) => {
                      // Извлекаем цифры. Если 11 цифр и начинаются на 7 или 8
                      // — это вставлен полный номер (+79991234567 / 89991234567),
                      // отбрасываем код страны/префикс. Иначе берём первые 10.
                      let d = e.target.value.replace(/\D/g, '');
                      if (d.length === 11 && (d[0] === '7' || d[0] === '8')) {
                        d = d.slice(1);
                      }
                      setPhoneDigits(d.slice(0, 10));
                    }}
                    inputMode="numeric"
                    required
                  />
                </div>
                {phoneDigits.length === 10 && (
                  <div className="text-xs text-text-muted mt-1">{formatPhoneFromDigits(phoneDigits)}</div>
                )}
                {attempted && phoneDigits.length !== 10 && (
                  <div className="text-xs text-error mt-1">Заполните это поле — телефон 10 цифр</div>
                )}
              </>
            ) : (
              <>
                <input
                  type="tel"
                  className={`input ${attempted && foreignDigitsCount < 7 ? 'border-error field-invalid' : ''}`}
                  placeholder="+998 90 123 45 67"
                  value={foreignPhone}
                  onChange={(e) => setForeignPhone(e.target.value)}
                  required
                />
                <div className="text-xs text-text-muted mt-1">Иностранный — введи полный номер с кодом страны (любой формат)</div>
                {attempted && foreignDigitsCount < 7 && (
                  <div className="text-xs text-error mt-1">Заполните это поле — минимум 7 цифр</div>
                )}
              </>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="label">Имя *</label>
              <input
                type="text"
                className={`input ${attempted && !firstName.trim() ? 'border-error field-invalid' : ''}`}
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                required
              />
              {attempted && !firstName.trim() && (
                <div className="text-xs text-error mt-1">Заполните это поле</div>
              )}
            </div>
            <div>
              <label className="label">Фамилия</label>
              <input
                type="text"
                className="input"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
              />
            </div>
          </div>

          <div>
            <label className="label">Email</label>
            <input
              type="email"
              className="input"
              placeholder="client@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          {/* 2026-06-15 (правки Ксении): кнопку «Добавить участника» подняли
              к блоку с ФИО клиента, чтобы её было видно сразу — не
              приходится прокручивать форму до конца. */}
          {participants.length > 0 && (
            <div className="space-y-3 pt-4 border-t border-border">
              <div className="text-sm font-medium">Дополнительные участники</div>
              {participants.map((p, i) => (
                <div key={i} className="grid grid-cols-1 md:grid-cols-[1fr_1fr_1fr_auto] gap-2 items-end">
                  <div>
                    <label className="label text-xs">Имя</label>
                    <input
                      type="text"
                      className="input"
                      value={p.firstName}
                      onChange={(e) => updateParticipant(i, 'firstName', e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="label text-xs">Фамилия</label>
                    <input
                      type="text"
                      className="input"
                      value={p.lastName}
                      onChange={(e) => updateParticipant(i, 'lastName', e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="label text-xs">Телефон</label>
                    <input
                      type="tel"
                      className="input"
                      placeholder="+7 (999) 123-45-67"
                      value={p.phone ? formatPhoneFromDigits(p.phone) : ''}
                      onChange={(e) => updateParticipantPhone(i, e.target.value)}
                    />
                  </div>
                  <button
                    type="button"
                    className="btn btn-secondary text-error"
                    onClick={() => removeParticipant(i)}
                    aria-label="Удалить"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <button
            type="button"
            className="btn btn-secondary flex items-center gap-2"
            onClick={addParticipant}
          >
            <Plus className="w-4 h-4" /> Добавить участника (супруг и т.д.)
          </button>

          {/* 2026-07-01: dropdown «Я фиксирую от агентства» убран.
              brokerAgency автоматически = primary агентство (или первое). */}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="label">Проект *</label>
              <select
                className="input"
                value={project}
                onChange={(e) => setProject(e.target.value)}
              >
                <option value="ZORGE9">Зорге 9</option>
                <option value="SILVER_BOR">Серебряный бор</option>
              </select>
            </div>
            <div>
              <label className="label">Тип *</label>
              <select
                className="input"
                value={propertyType}
                onChange={(e) => setPropertyType(e.target.value as any)}
              >
                {(propertyTypesByProject[project] || []).map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="label">Кол-во комнат</label>
              <select
                className="input"
                value={roomsCount}
                onChange={(e) => setRoomsCount(e.target.value)}
              >
                <option value="">— не указано —</option>
                <option value="Студия">Студия</option>
                <option value="1к">1 комната</option>
                <option value="2к">2 комнаты</option>
                <option value="3к">3 комнаты</option>
                <option value="4к+">4+ комнаты</option>
              </select>
            </div>
            <div>
              <label className="label">Метраж, м² *</label>
              <input
                type="number"
                min="0"
                step="0.01"
                className={`input ${attempted && !sqm ? 'border-error field-invalid' : ''}`}
                placeholder="45.5"
                value={sqm}
                onChange={(e) => setSqm(e.target.value)}
                required
              />
              {attempted && !sqm && (
                <div className="text-xs text-error mt-1">Заполните это поле</div>
              )}
            </div>
          </div>

          <div>
            <label className="label">Бюджет покупки, ₽ *</label>
            <input
              type="text"
              inputMode="numeric"
              className={`input ${attempted && !amount ? 'border-error field-invalid' : ''}`}
              placeholder="25 000 000"
              value={formatMoney(amount)}
              onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))}
              required
            />
            {amount && (
              <div className="text-xs text-text-muted mt-1">
                {Number(amount).toLocaleString('ru-RU')} ₽
              </div>
            )}
            {attempted && !amount && (
              <div className="text-xs text-error mt-1">Заполните это поле</div>
            )}
          </div>

          {/* Дополнительные поля для amoCRM-лида (правка 2026-05-22, КБ3).
              2026-06-11: убран dev-маркер «(заполнится в amoCRM)» и поле
              «Регион клиента» — лишняя информация для брокера. */}
          <div className="border-t border-border pt-4 mt-2">
            <div className="text-xs font-semibold text-text-muted uppercase mb-3">Доп. информация о клиенте</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="label">Планирует покупку</label>
                <select className="input" value={purchaseTiming} onChange={(e) => setPurchaseTiming(e.target.value)}>
                  <option value="">— не указано —</option>
                  <option value="до 1 месяца">до 1 месяца</option>
                  <option value="от 1 до 3 месяцев">от 1 до 3 месяцев</option>
                  <option value="от 3 до 6 месяцев">от 3 до 6 месяцев</option>
                  <option value="от 6 до 12 месяцев">от 6 до 12 месяцев</option>
                  <option value="более 12 месяцев">более 12 месяцев</option>
                </select>
              </div>
              <div>
                <label className="label">Готовность к сделке</label>
                <select className="input" value={readinessLevel} onChange={(e) => setReadinessLevel(e.target.value as any)}>
                  <option value="">— не указано —</option>
                  <option value="Холодный">Холодный</option>
                  <option value="Тёплый">Тёплый</option>
                  <option value="Горячий">Горячий</option>
                </select>
              </div>
            </div>
          </div>

          {/* 2026-06-29 (refactor): секция «Брокер». Радио «На себя / На другого».
              При выборе «На другого» снизу появляется форма для нового брокера. */}
          <div className="pt-4 border-t border-border" data-other-broker-section>
            <h3 className="text-base font-semibold mb-3">Брокер</h3>

            <div className="flex flex-wrap gap-4 mb-4">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="respMode"
                  className="accent-accent"
                  checked={respMode === 'self'}
                  onChange={() => setRespMode('self')}
                />
                Фиксирую на себя
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="respMode"
                  className="accent-accent"
                  checked={respMode === 'other'}
                  onChange={() => setRespMode('other')}
                />
                Фиксирую на другого брокера
              </label>
            </div>

            {respMode === 'self' ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="label">ФИО брокера</label>
                  <input type="text" className="input bg-surface-secondary" value={brokerNameDisplay} readOnly />
                </div>
                <div>
                  <label className="label">Телефон брокера</label>
                  <input type="text" className="input bg-surface-secondary" value={brokerPhoneDisplay} readOnly />
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="text-xs text-text-muted">
                  Заполните данные нового брокера. При отправке формы он будет создан, и заявка уйдёт на него.
                  Если брокер с этим номером уже зарегистрирован — заявка автоматически уйдёт на него.
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="label">Фамилия <span className="text-error">*</span></label>
                    <input
                      type="text"
                      className={`input ${otherError?.field === 'fullName' ? 'field-invalid' : ''}`}
                      value={otherLastName}
                      onChange={(e) => setOtherLastName(e.target.value)}
                      disabled={otherCreating}
                    />
                  </div>
                  <div>
                    <label className="label">Имя <span className="text-error">*</span></label>
                    <input
                      type="text"
                      className={`input ${otherError?.field === 'fullName' ? 'field-invalid' : ''}`}
                      value={otherFirstName}
                      onChange={(e) => setOtherFirstName(e.target.value)}
                      disabled={otherCreating}
                    />
                  </div>
                </div>
                <div>
                  <label className="label">Отчество</label>
                  <input
                    type="text"
                    className="input"
                    value={otherMiddleName}
                    onChange={(e) => setOtherMiddleName(e.target.value)}
                    disabled={otherCreating}
                  />
                </div>
                <div>
                  <label className="label">Телефон <span className="text-error">*</span></label>
                  <div className="flex">
                    <span className="inline-flex items-center px-3 bg-surface-secondary border border-r-0 border-border rounded-l text-text-muted text-sm">+7</span>
                    <input
                      type="tel"
                      className={`input rounded-l-none ${otherError?.field === 'phone' ? 'field-invalid' : ''}`}
                      placeholder="9991234567"
                      value={otherPhone}
                      onChange={(e) => setOtherPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
                      maxLength={10}
                      disabled={otherCreating}
                    />
                  </div>
                </div>
                <div>
                  <label className="label">Email</label>
                  <input
                    type="email"
                    className={`input ${otherError?.field === 'email' ? 'field-invalid' : ''}`}
                    placeholder="broker@example.ru"
                    value={otherEmail}
                    onChange={(e) => setOtherEmail(e.target.value)}
                    disabled={otherCreating}
                  />
                  <div className="text-xs text-text-muted mt-1">
                    На email придёт приглашение для входа в кабинет.
                  </div>
                </div>
                {/* 2026-07-01: поля «ИНН агентства брокера» и «Агентство»
                    убраны. Новый брокер автоматически привязывается к primary
                    агентству того кто фиксирует (бэк сам возьмёт primary
                    из creator.brokerAgencies). */}
                {otherError && (
                  <div className="p-2 bg-error/20 text-error rounded text-xs">{otherError.message}</div>
                )}
              </div>
            )}
          </div>

          {error && (
            <div className="p-3 bg-error/20 text-error rounded-lg text-sm">{error}</div>
          )}

          <button
            type="submit"
            className="btn btn-primary w-full"
            disabled={loading}
          >
            {loading ? 'Отправка...' : 'Отправить заявку'}
          </button>

          {attempted && !brokerAgency?.inn && (
            <div className="text-xs text-error">
              У вас не привязано агентство с ИНН. Заполните данные в Профиле перед фиксацией.
            </div>
          )}
        </form>
      </div>

      {/* 2026-06-29 (refactor): модалка координатора удалена.
          Создание нового брокера теперь inline в секции «Брокер» формы. */}

      {showSuccess && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => setShowSuccess(false)}>
          <div
            className="bg-surface rounded-xl max-w-md w-full p-6 relative"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="absolute top-4 right-4 text-text-muted hover:text-text"
              onClick={() => setShowSuccess(false)}
            >
              <X className="w-5 h-5" />
            </button>
            <div className="text-center py-4">
              {amoWarn ? (
                <>
                  <div className="mx-auto w-16 h-16 bg-warning/20 rounded-full flex items-center justify-center mb-4">
                    <CheckCircle2 className="w-10 h-10 text-warning" />
                  </div>
                  <h2 className="text-xl font-bold mb-2">Заявка сохранена</h2>
                  <p className="text-text-muted mb-4 text-sm text-left">{amoWarn.message}</p>
                  {amoWarn.managers.length > 0 && (
                    <div className="text-left bg-warning/10 border border-warning/30 rounded p-3 mb-4 text-sm">
                      <div className="font-semibold mb-2">Менеджеры по брокерам:</div>
                      <ul className="space-y-1">
                        {amoWarn.managers.map((m, i) => (
                          <li key={i} className="flex flex-wrap items-center gap-x-2">
                            <span>{m.fullName}</span>
                            {m.phone && (
                              <a href={`tel:${m.phone}`} className="text-accent underline">{m.phone}</a>
                            )}
                            {m.telegram && (
                              <a href={`https://t.me/${m.telegram.replace(/^@/, '')}`} target="_blank" rel="noreferrer" className="text-info underline">tg: @{m.telegram.replace(/^@/, '')}</a>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="mx-auto w-16 h-16 bg-success/20 rounded-full flex items-center justify-center mb-4">
                    <CheckCircle2 className="w-10 h-10 text-success" />
                  </div>
                  <h2 className="text-2xl font-bold mb-2">Запрос отправлен</h2>
                  <p className="text-text-muted mb-6 text-sm">Заявка на фиксацию клиента успешно создана.</p>
                </>
              )}
              <div className="flex flex-col gap-2">
                <button
                  className="btn btn-primary w-full"
                  onClick={() => router.push('/clients')}
                >
                  Перейти к заявкам
                </button>
                <button
                  className="btn btn-secondary w-full"
                  onClick={resetForm}
                >
                  Создать ещё заявку
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
