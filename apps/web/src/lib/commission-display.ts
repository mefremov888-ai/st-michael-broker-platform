export type CommissionProject = 'ZORGE9' | 'SILVER_BOR';

export type CommissionMode = 'FLAT' | 'PROGRESSIVE';

export type CommissionNumericValue = number | string | null | undefined;

export interface CommissionPolicyLevel {
  level?: string;
  name?: string;
  minSqm?: number | string;
  rate?: CommissionNumericValue;
}

/**
 * Public, display-safe representation of the policy that is active today.
 * Numeric fields also accept strings because Prisma Decimal values can cross
 * an API boundary in either form.
 */
export interface ActiveCommissionPolicy {
  project: CommissionProject;
  mode: CommissionMode;
  flatRate: CommissionNumericValue;
  levels: CommissionPolicyLevel[] | null;
  installmentEnabled?: boolean;
  installmentDiscount?: CommissionNumericValue;
  subsidizedMortgageEnabled?: boolean;
  subsidizedMortgageRate?: CommissionNumericValue;
  displayNote?: string | null;
}

export type ProgressiveRateLabel = 'range' | 'max';

export interface CommissionRateLabelOptions {
  /** `range` -> "5–8%"; `max` -> "до 8%". FLAT is always "4%". */
  progressive?: ProgressiveRateLabel;
  /** Backwards-friendly shorthand for `progressive: 'max'`. */
  maxOnly?: boolean;
  fallback?: string;
}

export interface ResolveCommissionTextContext {
  /** Policy used for a generic commission phrase. Without it, overall.max is used. */
  project?: CommissionProject | 'overall';
  /** Controls how a progressive rate is rendered in generic/standalone phrases. */
  progressive?: ProgressiveRateLabel;
  /** Allows a leading "до 8% — ..." phrase known by the caller to mean commission. */
  commissionContext?: boolean;
}

export type CommissionTextContext =
  | ResolveCommissionTextContext
  | CommissionProject
  | 'overall';

export type CommissionPaymentTerms = Partial<Pick<
  ActiveCommissionPolicy,
  | 'installmentEnabled'
  | 'installmentDiscount'
  | 'subsidizedMortgageEnabled'
  | 'subsidizedMortgageRate'
>>;

const DEFAULT_FALLBACK = '—';
const RATE_PRECISION = 2;

function numericRate(value: CommissionNumericValue): number | null {
  if (value === null || value === undefined || value === '') return null;

  const normalized = typeof value === 'string'
    ? value.trim().replace(/\s/g, '').replace(/%$/, '').replace(',', '.')
    : value;
  const rate = Number(normalized);

  return Number.isFinite(rate) && rate >= 0 ? rate : null;
}

function formatRateNumber(value: number): string {
  const factor = 10 ** RATE_PRECISION;
  const rounded = Math.round((value + Number.EPSILON) * factor) / factor;
  const safeValue = Object.is(rounded, -0) ? 0 : rounded;

  return safeValue
    .toFixed(RATE_PRECISION)
    .replace(/\.?0+$/, '')
    .replace('.', ',');
}

/** Formats a commission value with a Russian decimal comma, e.g. 5.25 -> 5,25%. */
export function formatPercent(
  value: CommissionNumericValue,
  fallback = DEFAULT_FALLBACK,
): string {
  const rate = numericRate(value);
  return rate === null ? fallback : `${formatRateNumber(rate)}%`;
}

export function getCommissionMinRate(
  policy: ActiveCommissionPolicy | null | undefined,
): number | null {
  if (!policy) return null;

  if (policy.mode === 'FLAT') return numericRate(policy.flatRate);

  const rates = (policy.levels || [])
    .map((level) => numericRate(level?.rate))
    .filter((rate): rate is number => rate !== null);

  return rates.length > 0 ? Math.min(...rates) : null;
}

export function getCommissionMaxRate(
  policy: ActiveCommissionPolicy | null | undefined,
): number | null {
  if (!policy) return null;

  if (policy.mode === 'FLAT') return numericRate(policy.flatRate);

  const rates = (policy.levels || [])
    .map((level) => numericRate(level?.rate))
    .filter((rate): rate is number => rate !== null);

  return rates.length > 0 ? Math.max(...rates) : null;
}

export function getOverallMaxCommissionRate(
  policies: readonly ActiveCommissionPolicy[],
): number | null {
  const rates = policies
    .map(getCommissionMaxRate)
    .filter((rate): rate is number => rate !== null);

  return rates.length > 0 ? Math.max(...rates) : null;
}

export function findActiveCommissionPolicy(
  policies: readonly ActiveCommissionPolicy[],
  project: CommissionProject,
): ActiveCommissionPolicy | undefined {
  return policies.find((policy) => policy.project === project);
}

/**
 * Human-readable base rate. A fixed policy never gets an inaccurate "до" prefix.
 */
export function getCommissionRateLabel(
  policy: ActiveCommissionPolicy | null | undefined,
  options: CommissionRateLabelOptions = {},
): string {
  const fallback = options.fallback ?? DEFAULT_FALLBACK;
  if (!policy) return fallback;

  if (policy.mode === 'FLAT') return formatPercent(policy.flatRate, fallback);

  const min = getCommissionMinRate(policy);
  const max = getCommissionMaxRate(policy);
  if (min === null || max === null) return fallback;

  const progressive = options.maxOnly ? 'max' : (options.progressive ?? 'range');
  if (progressive === 'max') return `до ${formatPercent(max, fallback)}`;
  if (min === max) return formatPercent(max, fallback);

  return `${formatRateNumber(min)}–${formatPercent(max, fallback)}`;
}

/**
 * Builds the payment modifier copy from the same policy as the base rate.
 * Disabled or unspecified modifiers are omitted instead of displaying stale defaults.
 */
export function buildPaymentTermsText(
  policy: CommissionPaymentTerms | null | undefined,
): string {
  if (!policy) return '';

  const parts: string[] = [];
  const installmentDiscount = numericRate(policy.installmentDiscount);
  const installmentIsConfigured = policy.installmentEnabled === true
    || (policy.installmentEnabled === undefined && installmentDiscount !== null);

  if (installmentIsConfigured && installmentDiscount !== null) {
    parts.push(installmentDiscount === 0
      ? 'При рассрочке действует базовая ставка без уменьшения.'
      : `При рассрочке ставка уменьшается на ${formatPercent(installmentDiscount).replace(/%$/, ' п. п.')} `
        + 'от базовой комиссии.');
  }

  const subsidizedMortgageRate = numericRate(policy.subsidizedMortgageRate);
  const mortgageIsConfigured = policy.subsidizedMortgageEnabled === true
    || (policy.subsidizedMortgageEnabled === undefined && subsidizedMortgageRate !== null);

  if (mortgageIsConfigured && subsidizedMortgageRate !== null) {
    parts.push(`При субсидированной ипотеке действует фиксированная ставка ${formatPercent(subsidizedMortgageRate)}.`);
  }

  return parts.join(' ');
}

const RATE_EXPRESSION = '(?:до\\s+)?\\d+(?:[.,]\\d+)?(?:\\s*[–—-]\\s*\\d+(?:[.,]\\d+)?)?\\s*%';

// These contexts commonly contain percentages, but those percentages are not
// the broker's base commission and must never be rewritten heuristically.
const PROTECTED_PERCENT_CONTEXT = /(?:(?:^|[^а-яё])пв(?:$|[^а-яё])|первоначальн|взнос|рассроч|ипотеч|кредит|доходност|скидк|бонус)/i;

function normalizeTextContext(context?: CommissionTextContext): ResolveCommissionTextContext {
  if (typeof context === 'string') return { project: context };
  return context || {};
}

function isProtectedPercentage(input: string, start: number, end: number): boolean {
  // Restrict the check to the current clause. A perfectly valid phrase such as
  // "Комиссия до 8%, ПВ от 10%" must update the first percentage while keeping
  // the second one intact.
  const leftWindow = input.slice(Math.max(0, start - 64), start);
  const leftClause = leftWindow.slice(Math.max(
    leftWindow.lastIndexOf('.'),
    leftWindow.lastIndexOf(','),
    leftWindow.lastIndexOf(';'),
    leftWindow.lastIndexOf('!'),
    leftWindow.lastIndexOf('?'),
    leftWindow.lastIndexOf('\n'),
  ) + 1);
  const rightWindow = input.slice(end, Math.min(input.length, end + 64));
  const rightBoundary = rightWindow.search(/[.,;!?\n]/);
  const rightClause = rightBoundary === -1 ? rightWindow : rightWindow.slice(0, rightBoundary);
  const nearby = `${leftClause}${input.slice(start, end)}${rightClause}`;
  return PROTECTED_PERCENT_CONTEXT.test(nearby);
}

function sourceUsesRange(source: string): boolean {
  return /[–—-]/.test(source);
}

function labelForPolicy(
  policy: ActiveCommissionPolicy | undefined,
  source: string,
  preferred?: ProgressiveRateLabel,
): string | null {
  if (!policy || getCommissionMaxRate(policy) === null) return null;
  const progressive = preferred ?? (sourceUsesRange(source) ? 'range' : 'max');
  return getCommissionRateLabel(policy, { progressive, fallback: '' }) || null;
}

function labelForGenericRate(
  policies: readonly ActiveCommissionPolicy[],
  source: string,
  context: ResolveCommissionTextContext,
): string | null {
  if (context.project && context.project !== 'overall') {
    return labelForPolicy(
      findActiveCommissionPolicy(policies, context.project),
      source,
      context.progressive,
    );
  }

  const overallMax = getOverallMaxCommissionRate(policies);
  return overallMax === null ? null : `до ${formatPercent(overallMax)}`;
}

function replaceGenericCommissionRates(
  input: string,
  policies: readonly ActiveCommissionPolicy[],
  context: ResolveCommissionTextContext,
): string {
  const keywordBefore = new RegExp(
    `((?:комисси(?:я|и|ю|ей)|ставк(?:а|и|у|ой)|шкал(?:а|ы|е|у|ой)|вознаграждени(?:е|я|ю|ем))\\s*(?:[:—–-]\\s*)?)(${RATE_EXPRESSION})`,
    'gi',
  );
  let result = input.replace(
    keywordBefore,
    (match: string, prefix: string, rate: string, offset: number, whole: string) => {
      const rateStart = offset + prefix.length;
      if (isProtectedPercentage(whole, rateStart, rateStart + rate.length)) return match;
      const label = labelForGenericRate(policies, rate, context);
      return label ? `${prefix}${label}` : match;
    },
  );

  const keywordAfter = new RegExp(
    `(${RATE_EXPRESSION})(\\s+(?:комисси(?:я|и|ю|ей)|ставк(?:а|и|у|ой)|шкал(?:а|ы|е|у|ой)|вознаграждени(?:е|я|ю|ем)))`,
    'gi',
  );
  result = result.replace(
    keywordAfter,
    (match: string, rate: string, suffix: string, offset: number, whole: string) => {
      if (isProtectedPercentage(whole, offset, offset + rate.length)) return match;
      const label = labelForGenericRate(policies, rate, context);
      return label ? `${label}${suffix}` : match;
    },
  );

  // Useful for isolated stat values ("до 8%") and known commission blurbs
  // ("До 8% — одна из лучших..."). It is opt-in unless a project is supplied.
  if (context.project || context.commissionContext) {
    const leadingRate = new RegExp(`^(\\s*)(${RATE_EXPRESSION})(?=\\s*(?:$|[—–-]))`, 'i');
    result = result.replace(
      leadingRate,
      (match: string, whitespace: string, rate: string, offset: number, whole: string) => {
        const rateStart = offset + whitespace.length;
        if (isProtectedPercentage(whole, rateStart, rateStart + rate.length)) return match;
        const label = labelForGenericRate(policies, rate, context);
        return label ? `${whitespace}${label}` : match;
      },
    );
  }

  return result;
}

function replaceProjectCommissionRate(
  input: string,
  policy: ActiveCommissionPolicy | undefined,
  projectNameExpression: string,
): string {
  if (!policy) return input;

  const rateBeforeProject = new RegExp(
    `(${RATE_EXPRESSION})(\\s+по\\s+(?:(?:проекту|проекте)\\s+)?${projectNameExpression})`,
    'gi',
  );

  let result = input.replace(rateBeforeProject, (
    match: string,
    rate: string,
    suffix: string,
    offset: number,
    whole: string,
  ) => {
    if (isProtectedPercentage(whole, offset, offset + rate.length)) return match;
    const label = labelForPolicy(policy, rate);
    return label ? `${label}${suffix}` : match;
  });

  // Legacy copy also commonly puts the project first:
  // "Шкала по КСБ — до 6,25%" or "Зорге 9: 4%".
  const projectBeforeRate = new RegExp(
    `(${projectNameExpression}\\s*(?:[:—–-]\\s*)?)(${RATE_EXPRESSION})`,
    'gi',
  );
  result = result.replace(projectBeforeRate, (
    match: string,
    prefix: string,
    rate: string,
    offset: number,
    whole: string,
  ) => {
    const rateStart = offset + prefix.length;
    if (isProtectedPercentage(whole, rateStart, rateStart + rate.length)) return match;
    const label = labelForPolicy(policy, rate);
    return label ? `${prefix}${label}` : match;
  });

  return result;
}

function resolveCommissionTokens(
  input: string,
  policies: readonly ActiveCommissionPolicy[],
): string {
  const projectToken = /{{\s*commission\.(ZORGE9|SILVER_BOR)\.(min|max|range)\s*}}/gi;
  let result = input.replace(projectToken, (token: string, rawProject: string, field: string) => {
    const project = rawProject.toUpperCase() as CommissionProject;
    const policy = findActiveCommissionPolicy(policies, project);
    if (!policy) return token;

    if (field.toLowerCase() === 'range') {
      const label = getCommissionRateLabel(policy, { progressive: 'range', fallback: '' });
      return label || token;
    }

    const rate = field.toLowerCase() === 'min'
      ? getCommissionMinRate(policy)
      : getCommissionMaxRate(policy);
    return rate === null ? token : formatPercent(rate);
  });

  result = result.replace(/{{\s*commission\.overall\.max\s*}}/gi, (token: string) => {
    const max = getOverallMaxCommissionRate(policies);
    return max === null ? token : formatPercent(max);
  });

  return result;
}

/**
 * Resolves explicit commission tokens and carefully updates legacy landing copy.
 * Project-qualified percentages are authoritative. Generic replacements are
 * limited to nearby commission/rate wording, so down payments and unrelated
 * marketing percentages are left intact.
 */
export function resolveCommissionText(
  text: string,
  policies: readonly ActiveCommissionPolicy[],
  context?: CommissionTextContext,
): string {
  if (!text || policies.length === 0) return text;

  const normalizedContext = normalizeTextContext(context);
  let result = replaceGenericCommissionRates(text, policies, normalizedContext);

  result = replaceProjectCommissionRate(
    result,
    findActiveCommissionPolicy(policies, 'ZORGE9'),
    '(?:[«"]?\\s*)?(?:(?:ЖК|АК)\\s+)?Зорге\\s*9(?:\\s*[»"])?',
  );
  result = replaceProjectCommissionRate(
    result,
    findActiveCommissionPolicy(policies, 'SILVER_BOR'),
    '(?:Квартал(?:у)?\\s+)?[«"]?(?:Серебряный\\s+Бор|Серебряному\\s+Бору|КСБ)[»"]?',
  );

  // Explicit tokens are resolved last so a generic legacy matcher can never
  // reinterpret a project-specific token value as the overall commission.
  return resolveCommissionTokens(result, policies);
}
