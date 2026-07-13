// Dadata Suggestions API — поиск юр.лиц/ИП по ИНН и началу названия.
// Используется в форме регистрации для автодополнения ИНН агентства.
// 2026-06-26: добавлено по запросу заказчика — брокер из существующего
// агентства не должен помнить ИНН наизусть, выбирает из подсказок.
//
// Тариф: бесплатный, 10 000 запросов/сутки на ключ.
// Документация: https://dadata.ru/api/suggest/party/

export interface DadataPartySuggestion {
  inn: string;
  name: string;          // короткое название (например "ПАО Сбербанк")
  fullName: string;      // полное (с ОПФ) — для UI деталей
  type: 'LEGAL' | 'INDIVIDUAL';
  status: 'ACTIVE' | 'LIQUIDATING' | 'LIQUIDATED' | 'BANKRUPT' | 'REORGANIZING' | string;
  address: string;       // адрес одной строкой
}

interface DadataRawSuggestion {
  value: string;
  unrestricted_value?: string;
  data: {
    inn?: string;
    type?: string;
    name?: { short?: string; full_with_opf?: string; short_with_opf?: string };
    state?: { status?: string };
    address?: { value?: string; unrestricted_value?: string };
  };
}

interface DadataResponse {
  suggestions: DadataRawSuggestion[];
}

export class DadataAdapter {
  private apiKey: string;
  private baseUrl = 'https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/party';

  constructor(apiKey?: string) {
    this.apiKey = apiKey || process.env.DADATA_API_KEY || '';
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  /**
   * Подсказки по началу ИНН или названия. Возвращает до `count` результатов.
   * При ошибке сети / 4xx-5xx — отдаёт пустой массив (UI просто не покажет
   * dropdown, ввод не блокируется).
   *
   * @param query — 4+ символов. Цифры → поиск по ИНН. Иначе — по имени.
   * @param count — макс. количество (1-20, по умолчанию 7).
   */
  async suggestParty(query: string, count = 7): Promise<DadataPartySuggestion[]> {
    if (!this.isConfigured()) return [];
    if (!query || query.length < 4) return [];

    try {
      const res = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Token ${this.apiKey}`,
        },
        body: JSON.stringify({ query, count: Math.min(20, Math.max(1, count)) }),
      });
      if (!res.ok) return [];
      const json = (await res.json()) as DadataResponse;
      if (!Array.isArray(json?.suggestions)) return [];

      return json.suggestions
        .filter((s) => s?.data?.inn)
        .map((s) => ({
          inn: s.data.inn || '',
          name: s.data.name?.short || s.data.name?.short_with_opf || s.value || '',
          fullName: s.data.name?.full_with_opf || s.unrestricted_value || s.value || '',
          type: s.data.type === 'INDIVIDUAL' ? 'INDIVIDUAL' : 'LEGAL',
          status: s.data.state?.status || 'ACTIVE',
          address: s.data.address?.value || s.data.address?.unrestricted_value || '',
        }));
    } catch {
      return [];
    }
  }
}
