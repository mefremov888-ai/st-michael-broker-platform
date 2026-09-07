import { DadataAdapter } from "@st-michael/integrations";

/**
 * 2026-09-07: реквизиты агентства из госреестра (ЕГРЮЛ/ЕГРИП через DaData)
 * по ИНН. Нужно, чтобы при создании карточки агентства сразу заполнялись
 * «Юридическое название» и юридический адрес — до этого их не писал никто,
 * и в «Нашей базе» у всех агентств стояло «Нет данных».
 *
 * Поведение при отсутствии ключа DADATA_API_KEY, сетевой ошибке или пустом
 * ответе — null: создание агентства продолжается без реквизитов, как раньше.
 */
export interface AgencyRegistryProfile {
  /** Короткое название без ОПФ-шума («Red Line», «ИП Иванов И.И.»). */
  shortName: string;
  /** Полное юридическое название с ОПФ — в Agency.legalName. */
  legalName: string;
  /** Юридический адрес одной строкой — в Agency.legalAddress. */
  legalAddress: string | null;
  /** ACTIVE / LIQUIDATED / … — как отдаёт DaData. */
  status: string;
  type: "LEGAL" | "INDIVIDUAL";
}

const isStrictInn = (inn: string) => /^\d{10}$|^\d{12}$/.test(inn);

let sharedAdapter: DadataAdapter | null = null;

export async function lookupAgencyRegistryByInn(
  rawInn: string,
  adapter?: Pick<DadataAdapter, "suggestParty" | "isConfigured">,
): Promise<AgencyRegistryProfile | null> {
  const inn = String(rawInn || "").replace(/\D/g, "");
  if (!isStrictInn(inn)) return null;
  const dadata = adapter ?? (sharedAdapter ??= new DadataAdapter());
  if (!dadata.isConfigured()) return null;
  try {
    const suggestions = await dadata.suggestParty(inn, 5);
    // Точное совпадение ИНН обязательно: подсказка «по началу ИНН» может
    // вернуть другую организацию.
    const exact = suggestions.find((s) => String(s.inn) === inn);
    if (!exact) return null;
    const legalName = String(exact.fullName || exact.name || "").trim();
    const shortName = String(exact.name || exact.fullName || "").trim();
    if (!legalName && !shortName) return null;
    return {
      shortName: shortName || legalName,
      legalName: legalName || shortName,
      legalAddress: String(exact.address || "").trim() || null,
      status: String(exact.status || "ACTIVE"),
      type: exact.type === "INDIVIDUAL" ? "INDIVIDUAL" : "LEGAL",
    };
  } catch {
    return null;
  }
}

/**
 * Данные для prisma.agency.create: имя — из amoCRM (если там уже есть
 * компания) или из реестра, иначе плейсхолдер; legalName/legalAddress — из
 * реестра, если он ответил.
 */
export function agencyCreateDataFromRegistry(
  inn: string,
  preferredName: string | null | undefined,
  profile: AgencyRegistryProfile | null,
  fallbackName: string,
) {
  const placeholder = `Агентство ${inn}`;
  const name =
    (preferredName && preferredName !== placeholder ? preferredName : null) ||
    profile?.shortName ||
    preferredName ||
    fallbackName;
  return {
    name,
    inn,
    ...(profile?.legalName ? { legalName: profile.legalName } : {}),
    ...(profile?.legalAddress ? { legalAddress: profile.legalAddress } : {}),
  };
}
