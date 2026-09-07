import { Injectable } from '@nestjs/common';
import { DadataAdapter, DadataPartySuggestion } from '@st-michael/integrations';

@Injectable()
export class AgenciesService {
  private dadata = new DadataAdapter();

  // Возвращает подсказки по началу ИНН / названия. Минимум 4 символа в запросе
  // — не отдаём всю базу по 1-2 цифрам. При отсутствующем ключе DADATA_API_KEY
  // отдаёт пустой массив (DadataAdapter сам это обрабатывает).
  async suggest(query: string): Promise<DadataPartySuggestion[]> {
    const trimmed = String(query || '').trim();
    if (trimmed.length < 4) return [];
    return this.dadata.suggestParty(trimmed, 7);
  }
}
