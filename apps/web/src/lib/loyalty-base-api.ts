import { apiGet, apiPost, apiUpload } from './api';

export type LoyaltyBaseKey = 'anna' | 'ours';
export type LoyaltyEntityType = 'brokers' | 'agencies';
export type LoyaltySegment = 'NOT_CALLED_CURRENT_MONTH' | 'NEW_BROKER' | 'BT_WITHOUT_FIXATION' | 'BIRTHDAY_TODAY';

export interface LoyaltyLeader {
  id: string;
  name: string;
  deals: number;
  dealAmount: string;
}

export interface LoyaltyOverview {
  base: LoyaltyBaseKey;
  snapshot: {
    id: string;
    status: string;
    publishedAt: string;
  } | null;
  brokersTotal: number;
  agenciesTotal: number;
  notCalledCurrentMonth: number;
  newBrokers: number;
  btWithoutFixation: number;
  birthdaysToday: number | null;
  birthdayKnownCount: number;
  topBroker: LoyaltyLeader | null;
  topAgency: LoyaltyLeader | null;
  activities: { fixations: number; meetings: number; deals: number };
  dealAmount: string;
  period: { from: string; to: string } | null;
}

export interface LoyaltyRecord {
  id: string;
  entityType: LoyaltyEntityType;
  name: string;
  company: string;
  phone: string;
  email: string;
  city: string;
  status: string;
  stage: string;
  assignee: string;
  dataQuality: string;
  hasAmo: boolean | null;
  archived: boolean;
  fixations: number | null;
  meetings: number | null;
  deals: number | null;
  dealAmount: string | null;
  lastCallAt: string;
  lastActivityAt: string;
  nextTask: string;
  birthday: string;
  workFormat: string;
  specialization: string;
  sourceIds: string[];
  contacts: Array<{ id: string; name: string; role: string; phone: string; email: string }>;
  history: Array<{ id: string; type: string; occurredAt: string; title: string; description: string }>;
  provenance: Array<{ field: string; source: string; updatedAt: string }>;
}

export interface LoyaltyListResponse {
  base: LoyaltyBaseKey;
  entityType: LoyaltyEntityType;
  items: LoyaltyRecord[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface LoyaltyListFilters {
  page: number;
  pageSize: number;
  search?: string;
  archived?: 'exclude' | 'include' | 'only';
  city?: string;
  hasAmo?: '' | 'true' | 'false';
  segment?: LoyaltySegment | '';
}

export type ReconciliationDecision = 'LINK' | 'KEEP_SEPARATE' | 'REJECT_MATCH' | 'UNLINK' | '';
export type ReconciliationDecisionAction = Exclude<ReconciliationDecision, ''>;

export interface ReconciliationSide {
  id: string;
  entityType: string;
  name: string;
  phone: string;
  company: string;
  source: string;
}

export interface ReconciliationCase {
  id: string;
  version: number;
  status: string;
  matchReason: string;
  matchCodes: string[];
  score: number;
  anna: ReconciliationSide | null;
  ours: ReconciliationSide | null;
  decision: ReconciliationDecision | '';
}

export interface ReconciliationResponse {
  items: ReconciliationCase[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface LoyaltyActiveLink {
  id: string;
  version: number;
  ownerType: string;
  ownerId: string;
  ownerName: string;
  targetType: string;
  targetId: string;
  targetName: string;
  reconciliationCaseId: string;
  decidedAt: string;
  ruleVersion: string;
  presentInActiveSnapshot: boolean;
}

export interface LoyaltyActiveLinksResponse {
  items: LoyaltyActiveLink[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface ImportSummary {
  records: number;
  brokers: number;
  agencies: number;
  contactPoints: number;
  uniqueNormalizedPhones: number;
  externalIdentities: number;
  activities: number;
  organizationRoles: number;
  duplicateSourceKeys: number;
  invalidContactPoints: number;
  issueCount: number;
  candidateCount: number;
  ambiguousRecords: number;
  includedActivities: number | null;
  includedFixations: number | null;
  includedMeetings: number | null;
  includedDeals: number | null;
  includedBrokerTours: number | null;
  includedCalls: number | null;
  includedDealAmount: string | null;
  excludedActivities: number | null;
  unknownActivities: number | null;
  currentPublishedRecords: number | null;
  coverageDropRequiresConfirmation: boolean | null;
  coverageDropConfirmed: boolean | null;
  coverageDrops: Array<{ dimension: string; current: number | string; staged: number | string }>;
}

export interface ImportIssue {
  row: number | null;
  code: string;
}

export interface ImportStepResult {
  id: string;
  snapshotId: string;
  status: string;
  contentHash: string;
  publishable: boolean | null;
  expectedActiveSnapshotId: string | null;
  hasExpectedActiveSnapshotBinding: boolean;
  summary: ImportSummary;
  issues: ImportIssue[];
}

type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {};

const nonEmptyRecord = (value: unknown) => {
  const record = asRecord(value);
  return Object.keys(record).length ? record : null;
};

const pick = (record: UnknownRecord, ...keys: string[]): unknown => {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
};

const stringValue = (value: unknown, fallback = ''): string => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
};

const numberValue = (value: unknown, fallback = 0): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const nullableNumberValue = (value: unknown): number | null => (
  value === undefined || value === null || value === '' ? null : numberValue(value)
);

const decimalValue = (value: unknown, fallback = '0'): string => {
  const candidate = typeof value === 'string'
    ? value.trim()
    : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
  return /^\d+(?:\.\d+)?$/.test(candidate) ? candidate : fallback;
};

const nullableDecimalValue = (value: unknown): string | null => (
  value === undefined || value === null || value === '' ? null : decimalValue(value)
);

/** Format a non-negative Decimal string without converting it to JS Number. */
export function formatRubles(value: string | null): string {
  if (value === null || !/^\d+(?:\.\d+)?$/.test(value)) return '—';
  const [integer, rawFraction = ''] = value.split('.');
  const fraction = rawFraction.padEnd(2, '0').slice(0, 2);
  const grouped = BigInt(integer).toLocaleString('ru-RU');
  return `${grouped}${fraction === '00' ? '' : `,${fraction}`} ₽`;
}

const booleanValue = (value: unknown): boolean | null => {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return null;
};

const arrayValue = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

const stringArray = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map((item) => stringValue(item)).filter(Boolean);
  const text = stringValue(value);
  return text ? text.split(/[;,\n]+/).map((item) => item.trim()).filter(Boolean) : [];
};

function responseRoot(value: unknown): UnknownRecord {
  const outer = asRecord(value);
  const nested = nonEmptyRecord(outer.data);
  if (!nested) return outer;
  const hasEnvelope = ['items', 'results', 'brokers', 'agencies', 'item', 'overview', 'metrics', 'summary', 'contentHash', 'snapshotId']
    .some((key) => nested[key] !== undefined);
  return hasEnvelope ? nested : outer;
}

function normalizeLeader(value: unknown): LoyaltyLeader | null {
  const firstValue = Array.isArray(value) ? value[0] : value;
  const item = asRecord(firstValue);
  const id = stringValue(pick(item, 'id', 'brokerId', 'agencyId', 'externalId'));
  const name = stringValue(pick(item, 'name', 'displayName', 'fullName', 'title', 'companyName'));
  if (!id && !name) return null;
  return {
    id,
    name: name || '—',
    deals: numberValue(pick(item, 'deals', 'dealCount', 'dealsCount', 'count')),
    dealAmount: decimalValue(pick(item, 'dealAmount', 'dealAmountRub', 'amount', 'sales')),
  };
}

export function normalizeLoyaltyOverview(value: unknown, base: LoyaltyBaseKey): LoyaltyOverview {
  const root = responseRoot(value);
  const overview = nonEmptyRecord(root.overview) || root;
  const metrics = nonEmptyRecord(overview.metrics) || nonEmptyRecord(overview.kpis) || {};
  const brokers = nonEmptyRecord(overview.brokers) || {};
  const agencies = nonEmptyRecord(overview.agencies) || {};
  const activities = nonEmptyRecord(overview.activities) || {};
  const period = nonEmptyRecord(overview.period);
  const snapshotRaw = nonEmptyRecord(overview.snapshot);
  const metric = (...keys: string[]) => numberValue(pick(metrics, ...keys));
  const brokerMetric = (...keys: string[]) => numberValue(pick(brokers, ...keys), metric(...keys));
  const nullableBrokerMetric = (...keys: string[]): number | null => {
    for (const source of [brokers, metrics]) {
      for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
        return source[key] === null ? null : numberValue(source[key]);
      }
    }
    return 0;
  };

  return {
    base: (stringValue(overview.base) === 'ours' ? 'ours' : stringValue(overview.base) === 'anna' ? 'anna' : base),
    snapshot: snapshotRaw ? {
      id: stringValue(pick(snapshotRaw, 'id', 'snapshotId')),
      status: stringValue(pick(snapshotRaw, 'status', 'state')),
      publishedAt: stringValue(pick(snapshotRaw, 'publishedAt', 'published_at', 'updatedAt', 'createdAt')),
    } : null,
    brokersTotal: numberValue(pick(brokers, 'total', 'count', 'brokersTotal'), numberValue(pick(overview, 'brokersTotal'))),
    agenciesTotal: numberValue(pick(agencies, 'total', 'count', 'agenciesTotal'), numberValue(pick(overview, 'agenciesTotal'))),
    notCalledCurrentMonth: brokerMetric('notCalledCurrentMonth', 'notCalledThisMonth', 'not_called_current_month', 'notCalled'),
    newBrokers: brokerMetric('newBrokers', 'newCount', 'new_brokers', 'new'),
    btWithoutFixation: brokerMetric('btWithoutFixation', 'btAttendedNoFixation', 'bt_no_fixation'),
    birthdaysToday: nullableBrokerMetric('birthdaysToday', 'birthdayToday', 'birthdays_today'),
    birthdayKnownCount: brokerMetric('birthdayKnownCount', 'birthdaysKnownCount', 'birthday_known_count'),
    topBroker: normalizeLeader(pick(brokers, 'top', 'topBroker', 'leader') ?? pick(metrics, 'topBroker', 'top_broker')),
    topAgency: normalizeLeader(pick(agencies, 'top', 'topAgency', 'leader') ?? pick(metrics, 'topAgency', 'top_agency')),
    activities: {
      fixations: numberValue(pick(activities, 'fixations', 'fixationCount')),
      meetings: numberValue(pick(activities, 'meetings', 'meetingCount')),
      deals: numberValue(pick(activities, 'deals', 'dealCount')),
    },
    dealAmount: decimalValue(pick(overview, 'dealAmount', 'dealAmountRub', 'amount')),
    period: period ? {
      from: stringValue(pick(period, 'from', 'dateFrom')),
      to: stringValue(pick(period, 'to', 'dateTo')),
    } : null,
  };
}

function normalizeContact(value: unknown) {
  const item = asRecord(value);
  const points = arrayValue(item.contactPoints).map(asRecord);
  const pointValue = (type: string) => {
    const point = points.find((candidate) => stringValue(candidate.type).toUpperCase() === type);
    return stringValue(pick(point || {}, 'value', 'maskedValue'));
  };
  return {
    id: stringValue(pick(item, 'id', 'externalId')),
    name: stringValue(pick(item, 'name', 'displayName', 'fullName')),
    role: stringValue(pick(item, 'role', 'position')),
    phone: stringValue(pick(item, 'phone', 'primaryPhone'), pointValue('PHONE')),
    email: stringValue(pick(item, 'email', 'primaryEmail'), pointValue('EMAIL')),
  };
}

function normalizeHistory(value: unknown) {
  const item = asRecord(value);
  return {
    id: stringValue(pick(item, 'id', 'externalId')),
    type: stringValue(pick(item, 'type', 'eventType', 'kind')),
    occurredAt: stringValue(pick(item, 'occurredAt', 'date', 'createdAt')),
    title: stringValue(pick(item, 'title', 'result', 'name', 'reasonCode', 'verdict')),
    description: stringValue(pick(item, 'description', 'comment', 'note', 'verdict')),
  };
}

function normalizeProvenance(value: unknown) {
  const item = asRecord(value);
  return {
    field: stringValue(pick(item, 'field', 'fieldName')),
    source: stringValue(pick(item, 'source', 'sourceName', 'sourceSystem')),
    updatedAt: stringValue(pick(item, 'updatedAt', 'observedAt', 'readAt', 'createdAt')),
  };
}

export function normalizeLoyaltyRecord(value: unknown, entityType: LoyaltyEntityType): LoyaltyRecord {
  const item = asRecord(value);
  const metrics = nonEmptyRecord(item.metrics) || {};
  const activitySummary = nonEmptyRecord(item.activities) || {};
  const activityItems = arrayValue(item.activities);
  const attributes = nonEmptyRecord(item.attributes) || {};
  const attributeCrm = nonEmptyRecord(attributes.crm) || {};
  const crm = nonEmptyRecord(item.crm) || {};
  const phones = stringArray(pick(item, 'phones', 'phoneNumbers'));
  const emails = stringArray(pick(item, 'emails', 'emailAddresses'));
  const contactPoints = arrayValue(item.contactPoints).map(asRecord);
  const primaryPoint = (type: string) => contactPoints.find((point) => (
    stringValue(point.type).toUpperCase() === type && booleanValue(point.isPrimary) === true
  )) || contactPoints.find((point) => stringValue(point.type).toUpperCase() === type);
  const phonePoint = primaryPoint('PHONE');
  const emailPoint = primaryPoint('EMAIL');
  const externalIdentities = arrayValue(item.externalIdentities).map(asRecord);
  const agencies = arrayValue(item.agencies).map(asRecord);
  const hasAmoRaw = pick(item, 'hasAmo', 'hasAmoCrm', 'amoLinked') ?? pick(crm, 'linked', 'found');
  const hasAmoIdentity = externalIdentities.length > 0
    ? externalIdentities.some((identity) => stringValue(identity.system).toUpperCase() === 'AMOCRM')
    : null;
  const firstActivityAt = stringValue(pick(asRecord(activityItems[0]), 'occurredAt', 'date', 'createdAt'));
  const lastCallAt = stringValue(pick(
    activityItems.map(asRecord).find((activity) => stringValue(activity.type).toUpperCase() === 'CALL') || {},
    'occurredAt', 'date', 'createdAt',
  ));

  return {
    id: stringValue(pick(item, 'id', 'externalId', 'contactId', 'uuid')),
    entityType,
    name: stringValue(pick(item, 'name', 'displayName', 'fullName', 'title', 'legalName'), 'Без названия'),
    company: stringValue(
      pick(item, 'company', 'agencyName', 'organization', 'legalName'),
      stringValue(pick(agencies[0] || {}, 'displayName', 'name')),
    ),
    phone: stringValue(
      pick(item, 'phone', 'primaryPhone'),
      stringValue(pick(phonePoint || {}, 'value', 'maskedValue'), phones[0] || ''),
    ),
    email: stringValue(
      pick(item, 'email', 'primaryEmail'),
      stringValue(pick(emailPoint || {}, 'value', 'maskedValue'), emails[0] || ''),
    ),
    city: stringValue(pick(item, 'city', 'region', 'geography'), stringValue(pick(attributes, 'city', 'region', 'geography'))),
    status: stringValue(
      pick(item, 'computedStatus', 'loyaltyStatus', 'partnershipLevel', 'status', 'category'),
      stringValue(pick(attributes, 'computedStatus', 'loyaltyStatus', 'partnershipLevel', 'status', 'category')),
    ),
    stage: stringValue(pick(item, 'relationshipStage', 'partnershipStage', 'stage'), stringValue(pick(attributes, 'relationshipStage', 'partnershipStage', 'stage'))),
    assignee: stringValue(pick(item, 'assigneeName', 'assignedTo', 'assignee', 'responsibleName'), stringValue(pick(attributes, 'assigneeName', 'assignedTo', 'assignee', 'responsibleName'))),
    dataQuality: stringValue(pick(item, 'dataQuality', 'qualityStatus', 'verification'), stringValue(pick(attributes, 'dataQuality', 'qualityStatus', 'verification'))),
    hasAmo: hasAmoRaw !== undefined ? booleanValue(hasAmoRaw) : hasAmoIdentity,
    archived: Boolean(pick(item, 'archivedAt')) || booleanValue(pick(item, 'archived', 'isArchived')) === true,
    fixations: nullableNumberValue(pick(item, 'fixations', 'fixationCount') ?? pick(metrics, 'fixations', 'fixationCount') ?? pick(activitySummary, 'fixations')),
    meetings: nullableNumberValue(pick(item, 'meetings', 'meetingCount') ?? pick(metrics, 'meetings', 'meetingCount') ?? pick(activitySummary, 'meetings')),
    deals: nullableNumberValue(pick(item, 'deals', 'dealCount') ?? pick(metrics, 'deals', 'dealCount') ?? pick(activitySummary, 'deals')),
    dealAmount: nullableDecimalValue(pick(item, 'dealAmount', 'dealAmountRub', 'sales', 'amount') ?? pick(metrics, 'dealAmount', 'dealAmountRub', 'sales', 'amount')),
    lastCallAt: stringValue(pick(item, 'lastCallAt', 'lastCallDate'), stringValue(pick(attributes, 'lastCallAt', 'lastCallDate'), lastCallAt)),
    lastActivityAt: stringValue(pick(item, 'lastActivityAt', 'lastActivityDate'), stringValue(pick(attributes, 'lastActivityAt', 'lastActivityDate'), firstActivityAt)),
    nextTask: stringValue(pick(item, 'nextTask', 'nextStep', 'nextAgreement'), stringValue(pick(attributes, 'nextTask', 'nextStep', 'nextAgreement'))),
    birthday: stringValue(
      pick(item, 'birthday', 'birthDate'),
      stringValue(pick(attributes, 'birthday', 'birthDate'), stringValue(pick(attributeCrm, 'birthday', 'birthDate'))),
    ),
    workFormat: stringValue(pick(item, 'workFormat', 'format'), stringValue(pick(attributes, 'workFormat', 'format'))),
    specialization: stringArray(pick(item, 'specializations', 'specialization') ?? pick(attributes, 'specializations', 'specialization')).join(', '),
    sourceIds: stringArray(pick(item, 'sourceIds', 'crmIds', 'externalIds')).concat(
      externalIdentities.map((identity) => [stringValue(identity.system), stringValue(identity.externalId)].filter(Boolean).join(':')).filter(Boolean),
    ),
    contacts: arrayValue(pick(item, 'contacts', 'contactPersons', 'agencyContacts', 'brokers')).map(normalizeContact),
    history: arrayValue(pick(item, 'history', 'events', 'activityHistory', 'activities')).map(normalizeHistory),
    provenance: arrayValue(pick(item, 'provenance', 'fieldSources', 'sources')).map(normalizeProvenance),
  };
}

export function normalizeLoyaltyList(
  value: unknown,
  base: LoyaltyBaseKey,
  entityType: LoyaltyEntityType,
  fallbackPage: number,
  fallbackPageSize: number,
): LoyaltyListResponse {
  const root = responseRoot(value);
  const nestedData = Array.isArray(root.data) ? root.data : null;
  const candidates = pick(root, 'items', 'results', entityType);
  const items = arrayValue(candidates ?? nestedData);
  const pagination = nonEmptyRecord(root.pagination) || nonEmptyRecord(root.meta) || {};
  const page = numberValue(pick(root, 'page') ?? pick(pagination, 'page', 'currentPage'), fallbackPage);
  const pageSize = numberValue(pick(root, 'pageSize', 'limit') ?? pick(pagination, 'pageSize', 'limit', 'perPage'), fallbackPageSize);
  const total = numberValue(pick(root, 'total', 'totalCount') ?? pick(pagination, 'total', 'totalCount'), items.length);
  const totalPages = numberValue(pick(root, 'totalPages') ?? pick(pagination, 'totalPages', 'pages'), Math.max(1, Math.ceil(total / Math.max(1, pageSize))));
  return {
    base: stringValue(root.base) === 'ours' ? 'ours' : stringValue(root.base) === 'anna' ? 'anna' : base,
    entityType: ['agencies', 'AGENCY'].includes(stringValue(root.entityType))
      ? 'agencies'
      : ['brokers', 'BROKER'].includes(stringValue(root.entityType)) ? 'brokers' : entityType,
    items: items.map((item) => normalizeLoyaltyRecord(item, entityType)),
    page,
    pageSize,
    total,
    totalPages,
  };
}

export function normalizeLoyaltyDetail(value: unknown, entityType: LoyaltyEntityType): LoyaltyRecord {
  const root = responseRoot(value);
  const item = pick(root, 'item', entityType === 'brokers' ? 'broker' : 'agency') ?? root;
  return normalizeLoyaltyRecord(item, entityType);
}

function normalizeReconciliationSide(value: unknown): ReconciliationSide | null {
  const side = nonEmptyRecord(value);
  if (!side) return null;
  const contacts = arrayValue(side.contacts).map(asRecord);
  const contact = contacts.find((item) => stringValue(item.type).toUpperCase() === 'PHONE') || contacts[0] || {};
  return {
    id: stringValue(pick(side, 'id', 'externalId')),
    entityType: stringValue(pick(side, 'entityType', 'type')),
    name: stringValue(pick(side, 'name', 'displayName', 'fullName', 'title'), '—'),
    phone: stringValue(pick(side, 'phone', 'primaryPhone', 'contact'), stringValue(pick(contact, 'maskedValue', 'value'))),
    company: stringValue(pick(side, 'company', 'agencyName', 'organization')),
    source: stringValue(pick(side, 'source', 'base')),
  };
}

function normalizeReconciliationCase(value: unknown): ReconciliationCase {
  const item = asRecord(value);
  const decision = stringValue(pick(item, 'decision', 'resolution')).toUpperCase();
  return {
    id: stringValue(pick(item, 'id', 'caseId')),
    version: numberValue(pick(item, 'version', 'rowVersion')),
    status: stringValue(pick(item, 'status', 'state')),
    matchReason: stringValue(pick(item, 'matchReason', 'reason', 'reasonCode')),
    matchCodes: stringArray(pick(item, 'matchCodes', 'reasonCodes', 'matches')),
    score: numberValue(pick(item, 'score', 'confidence')),
    anna: normalizeReconciliationSide(pick(item, 'anna', 'annaRecord', 'source')),
    ours: normalizeReconciliationSide(pick(item, 'ours', 'ourRecord', 'target')),
    decision: ['LINK', 'KEEP_SEPARATE', 'REJECT_MATCH', 'UNLINK'].includes(decision)
      ? decision as ReconciliationDecision
      : '',
  };
}

export function normalizeReconciliation(value: unknown, fallbackPage: number, fallbackPageSize: number): ReconciliationResponse {
  const root = responseRoot(value);
  const items = arrayValue(pick(root, 'items', 'cases', 'results') ?? (Array.isArray(root.data) ? root.data : []));
  const pagination = nonEmptyRecord(root.pagination) || nonEmptyRecord(root.meta) || {};
  const page = numberValue(pick(root, 'page') ?? pick(pagination, 'page'), fallbackPage);
  const pageSize = numberValue(pick(root, 'pageSize', 'limit') ?? pick(pagination, 'pageSize', 'limit'), fallbackPageSize);
  const total = numberValue(pick(root, 'total') ?? pick(pagination, 'total'), items.length);
  return {
    items: items.map(normalizeReconciliationCase),
    page,
    pageSize,
    total,
    totalPages: numberValue(pick(root, 'totalPages') ?? pick(pagination, 'totalPages'), Math.max(1, Math.ceil(total / Math.max(1, pageSize)))),
  };
}

function normalizeActiveLink(value: unknown): LoyaltyActiveLink {
  const item = asRecord(value);
  return {
    id: stringValue(pick(item, 'id', 'linkId')),
    version: numberValue(pick(item, 'version', 'rowVersion')),
    ownerType: stringValue(pick(item, 'ownerType', 'sourceType')),
    ownerId: stringValue(pick(item, 'ownerId', 'sourceId')),
    ownerName: stringValue(pick(item, 'ownerName', 'sourceName', 'displayName'), 'Нет в активном снимке'),
    targetType: stringValue(pick(item, 'targetType')),
    targetId: stringValue(pick(item, 'targetId')),
    targetName: stringValue(pick(item, 'targetName'), 'Удалено из нашей базы'),
    reconciliationCaseId: stringValue(pick(item, 'reconciliationCaseId', 'caseId')),
    decidedAt: stringValue(pick(item, 'decidedAt', 'createdAt')),
    ruleVersion: stringValue(pick(item, 'ruleVersion')),
    presentInActiveSnapshot: booleanValue(pick(item, 'presentInActiveSnapshot')) === true,
  };
}

export function normalizeActiveLinks(value: unknown, fallbackPage: number, fallbackPageSize: number): LoyaltyActiveLinksResponse {
  const root = responseRoot(value);
  const items = arrayValue(pick(root, 'items', 'links', 'results') ?? (Array.isArray(root.data) ? root.data : []));
  const pagination = nonEmptyRecord(root.pagination) || nonEmptyRecord(root.meta) || {};
  const page = numberValue(pick(root, 'page') ?? pick(pagination, 'page'), fallbackPage);
  const pageSize = numberValue(pick(root, 'pageSize', 'limit') ?? pick(pagination, 'pageSize', 'limit'), fallbackPageSize);
  const total = numberValue(pick(root, 'total') ?? pick(pagination, 'total'), items.length);
  return {
    items: items.map(normalizeActiveLink),
    page,
    pageSize,
    total,
    totalPages: numberValue(
      pick(root, 'totalPages') ?? pick(pagination, 'totalPages'),
      total === 0 ? 0 : Math.ceil(total / Math.max(1, pageSize)),
    ),
  };
}

function normalizeImportSummary(value: unknown): ImportSummary {
  const summary = asRecord(value);
  const nullableCount = (key: string) => Object.prototype.hasOwnProperty.call(summary, key)
    ? summary[key] === null ? null : numberValue(summary[key])
    : null;
  return {
    records: numberValue(pick(summary, 'records')),
    brokers: numberValue(pick(summary, 'brokers')),
    agencies: numberValue(pick(summary, 'agencies')),
    contactPoints: numberValue(pick(summary, 'contactPoints')),
    uniqueNormalizedPhones: numberValue(pick(summary, 'uniqueNormalizedPhones')),
    externalIdentities: numberValue(pick(summary, 'externalIdentities')),
    activities: numberValue(pick(summary, 'activities')),
    organizationRoles: numberValue(pick(summary, 'organizationRoles')),
    duplicateSourceKeys: numberValue(pick(summary, 'duplicateSourceKeys')),
    invalidContactPoints: numberValue(pick(summary, 'invalidContactPoints')),
    issueCount: numberValue(pick(summary, 'issueCount')),
    candidateCount: numberValue(pick(summary, 'candidateCount')),
    ambiguousRecords: numberValue(pick(summary, 'ambiguousRecords')),
    includedActivities: nullableCount('includedActivities'),
    includedFixations: nullableCount('includedFixations'),
    includedMeetings: nullableCount('includedMeetings'),
    includedDeals: nullableCount('includedDeals'),
    includedBrokerTours: nullableCount('includedBrokerTours'),
    includedCalls: nullableCount('includedCalls'),
    includedDealAmount: Object.prototype.hasOwnProperty.call(summary, 'includedDealAmount')
      ? stringValue(summary.includedDealAmount)
      : null,
    excludedActivities: nullableCount('excludedActivities'),
    unknownActivities: nullableCount('unknownActivities'),
    currentPublishedRecords: nullableCount('currentPublishedRecords'),
    coverageDropRequiresConfirmation: Object.prototype.hasOwnProperty.call(summary, 'coverageDropRequiresConfirmation')
      ? booleanValue(summary.coverageDropRequiresConfirmation)
      : null,
    coverageDropConfirmed: Object.prototype.hasOwnProperty.call(summary, 'coverageDropConfirmed')
      ? booleanValue(summary.coverageDropConfirmed)
      : null,
    coverageDrops: arrayValue(summary.coverageDrops).map((value) => {
      const drop = asRecord(value);
      const exactValue = (item: unknown): number | string => typeof item === 'number' || typeof item === 'string'
        ? item
        : numberValue(item);
      return {
        dimension: stringValue(drop.dimension),
        current: exactValue(drop.current),
        staged: exactValue(drop.staged),
      };
    }).filter((drop) => Boolean(drop.dimension)),
  };
}

export function normalizeImportResult(value: unknown): ImportStepResult {
  const root = responseRoot(value);
  const result = nonEmptyRecord(root.result) || root;
  return {
    id: stringValue(pick(result, 'id', 'dryRunId', 'stageId', 'jobId')),
    snapshotId: stringValue(pick(result, 'snapshotId', 'snapshot_id')),
    status: stringValue(pick(result, 'status', 'state')),
    contentHash: stringValue(pick(result, 'contentHash', 'content_hash', 'hash')),
    publishable: pick(result, 'publishable') === undefined ? null : booleanValue(pick(result, 'publishable')),
    expectedActiveSnapshotId: result.expectedActiveSnapshotId === null
      ? null
      : stringValue(result.expectedActiveSnapshotId) || null,
    hasExpectedActiveSnapshotBinding: Object.prototype.hasOwnProperty.call(result, 'expectedActiveSnapshotId'),
    summary: normalizeImportSummary(pick(result, 'summary', 'counts')),
    issues: arrayValue(pick(result, 'issues', 'warnings', 'errors')).map((item): ImportIssue => {
      const record = asRecord(item);
      const rowValue = pick(record, 'row', 'rowNumber');
      return {
        row: rowValue === undefined ? null : numberValue(rowValue),
        code: stringValue(pick(record, 'code', 'message', 'reason'), stringValue(item)),
      };
    }).filter((issue) => Boolean(issue.code)),
  };
}

const queryString = (entries: object) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `?${query}` : '';
};

export async function getLoyaltyOverview(base: LoyaltyBaseKey, range?: { from: string; to: string }) {
  const value = await apiGet<unknown>(`/loyalty-base/${base}/overview${queryString(range || {})}`);
  return normalizeLoyaltyOverview(value, base);
}

export async function getLoyaltyList(base: LoyaltyBaseKey, entityType: LoyaltyEntityType, filters: LoyaltyListFilters) {
  const { search = '', ...nonSensitiveFilters } = filters;
  const hasAmoValue = filters.hasAmo === '' || filters.hasAmo === undefined
    ? undefined
    : filters.hasAmo === 'true';
  const value = search
    ? await apiPost<unknown>(`/loyalty-base/${base}/${entityType}/search`, {
      search,
      page: filters.page,
      pageSize: filters.pageSize,
      archived: filters.archived,
      city: filters.city || undefined,
      hasAmo: hasAmoValue,
      segment: filters.segment || undefined,
    })
    : await apiGet<unknown>(`/loyalty-base/${base}/${entityType}${queryString({
      ...nonSensitiveFilters,
      hasAmo: hasAmoValue,
    })}`);
  return normalizeLoyaltyList(value, base, entityType, filters.page, filters.pageSize);
}

export async function getLoyaltyDetail(base: LoyaltyBaseKey, entityType: LoyaltyEntityType, id: string) {
  const value = await apiGet<unknown>(`/loyalty-base/${base}/${entityType}/${encodeURIComponent(id)}`);
  return normalizeLoyaltyDetail(value, entityType);
}

export async function getReconciliationCases(filters: { page: number; pageSize: number; status?: string; search?: string }) {
  const { search = '', ...nonSensitiveFilters } = filters;
  const value = search
    ? await apiPost<unknown>('/loyalty-base/reconciliation/search', {
      search,
      page: filters.page,
      pageSize: filters.pageSize,
      status: filters.status || undefined,
    })
    : await apiGet<unknown>(`/loyalty-base/reconciliation${queryString(nonSensitiveFilters)}`);
  return normalizeReconciliation(value, filters.page, filters.pageSize);
}

export async function decideReconciliationCase(caseId: string, decision: ReconciliationDecisionAction, expectedVersion: number) {
  return apiPost<unknown>('/loyalty-base/reconciliation', { caseId, decision, expectedVersion });
}

export async function getActiveLoyaltyLinks(filters: { page: number; pageSize: number; entityType?: 'BROKER' | 'AGENCY' | '' }) {
  const value = await apiGet<unknown>(`/loyalty-base/reconciliation/links${queryString(filters)}`);
  return normalizeActiveLinks(value, filters.page, filters.pageSize);
}

export async function unlinkActiveLoyaltyLink(linkId: string, expectedVersion: number) {
  return apiPost<unknown>('/loyalty-base/reconciliation/links/unlink', { linkId, expectedVersion });
}

export async function dryRunAnnaImport(file: File) {
  const formData = new FormData();
  formData.append('file', file);
  return normalizeImportResult(await apiUpload<unknown>('/loyalty-base/anna/import/dry-run', formData));
}

export async function stageAnnaImport(
  file: File,
  expectedContentHash: string,
  expectedActiveSnapshotId: string | null,
  confirmCoverageDrop = false,
) {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('expectedContentHash', expectedContentHash);
  formData.append('expectedActiveSnapshotId', expectedActiveSnapshotId ?? '');
  if (confirmCoverageDrop) formData.append('confirmCoverageDrop', 'true');
  return normalizeImportResult(await apiUpload<unknown>('/loyalty-base/anna/import/stage', formData));
}

export async function publishAnnaImport(
  snapshotId: string,
  expectedContentHash: string,
  expectedActiveSnapshotId: string | null,
  confirmCoverageDrop = false,
) {
  return normalizeImportResult(await apiPost<unknown>(`/loyalty-base/anna/import/${encodeURIComponent(snapshotId)}/publish`, {
    expectedContentHash,
    expectedActiveSnapshotId,
    ...(confirmCoverageDrop ? { confirmCoverageDrop: true } : {}),
    confirmed: true,
  }));
}
