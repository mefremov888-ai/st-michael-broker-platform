#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const CANONICAL_ZIP_SHA256 =
  "482ea63ddd9030ace255a4d50c9dda8b631a8493d98b8fce4948037533da79df";
const CANONICAL_OUTPUT_BYTES = 10_426_832;
const CANONICAL_OUTPUT_SHA256 =
  "bb8604657da22eca33943084bc0d12827fea8bc7de3eeec032892fb83ae5a6fc";
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_SOURCE_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const MAX_POSTGRES_BIGINT = 9223372036854775807n;

const BROKER_ENTRY =
  "source-package/current-dashboard/app/broker-source-enriched.ts";
const AGENCY_ENTRY = "source-package/current-dashboard/app/crm-agencies.ts";

const BROKER_KEYS = new Set([
  "phone",
  "name",
  "company",
  "email",
  "history",
  "comment",
  "sources",
  "specialization",
  "geography",
  "role",
  "crm",
]);
const BROKER_CRM_KEYS = new Set([
  "verification",
  "id",
  "ids",
  "url",
  "name",
  "names",
  "company",
  "companies",
  "email",
  "emails",
  "birthday",
  "bt",
  "btDate",
  "region",
  "fixations",
  "meetings",
  "deals",
  "lastFixationDate",
  "lastMeetingDate",
  "lastDealDate",
  "dealsByMonth",
  "dealAmountRub",
  "lastCallDate",
  "callsMayAugust",
]);
const BROKER_CRM_CALL_KEYS = new Set(["date", "direction", "result"]);
const AGENCY_KEYS = new Set([
  "id",
  "kind",
  "name",
  "company",
  "phone",
  "email",
  "role",
  "specialization",
  "stage",
  "birthday",
  "btDate",
  "lastMeetingDate",
  "lastDealDate",
  "fixations",
  "meetings",
  "deals",
  "sales",
  "rating",
  "assigned",
  "calls",
  "recognitions",
  "agencyContacts",
  "agencySize",
  "brokerCount",
  "website",
  "projectsOnSite",
  "sitePlacementRequirements",
  "lastAgencyMeetingDate",
  "agencyBtFormat",
  "activeBrokers",
  "lastContractDate",
  "nextAgreement",
  "partnershipStatus",
  "crmIds",
  "crmSource",
  "verification",
  "aliases",
  "crmNames",
  "paymentControl",
  "successfulDeals",
  "zorgeDeals",
  "berzarinaDeals",
  "activeCrmCards",
  "crmScore",
  "dealsWithAmount",
  "dealsByMonth",
  "verifiedDealIds",
]);
const AGENCY_CONTACT_KEYS = new Set(["id", "name", "role", "phone", "email"]);
const AGENCY_CALL_KEYS = new Set([
  "id",
  "date",
  "campaign",
  "employee",
  "result",
  "agreement",
  "nextAt",
]);
const RECOGNITION_KEYS = new Set([
  "id",
  "date",
  "type",
  "note",
  "employee",
  "amount",
  "validUntil",
  "attachment",
]);

const CANONICAL_INVENTORY = Object.freeze({
  brokerRows: 6670,
  agencyRows: 202,
  brokerUniquePhones: 6665,
  invalidBrokerPhones: 5,
  brokerRowsWithAmo: 6092,
  brokerIdentityReferences: 6701,
  brokerUniqueIdentityReferences: 6699,
  brokerConflictingIdentityReferences: 2,
  brokerFixations: 739,
  brokerMeetings: 375,
  brokerDeals: 198,
  brokerDealAmountRub: "4722766207.00",
  brokerTours: 1248,
  brokerDatedCalls: 146,
  agencyIdentityReferences: 243,
  agencyContacts: 56,
  agencyRowsWithPhone: 56,
  agencyUniquePhones: 55,
  agencyMeetings: 697,
  agencyDeals: 223,
  agencyDealAmountRub: "4704307380.00",
  linkedBrokerAgencyRoles: 2289,
  ambiguousBrokerAgencyRoles: 0,
  unmatchedBrokerAgencyRoles: 4381,
});

class ConversionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ConversionError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ConversionError(code, message);
}

function assert(condition, code, message) {
  if (!condition) fail(code, message);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

let crcTable;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let index = 0; index < 256; index++) {
      let value = index;
      for (let bit = 0; bit < 8; bit++) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      crcTable[index] = value >>> 0;
    }
  }
  let value = 0xffffffff;
  for (const byte of buffer)
    value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function safeZipName(name) {
  if (
    !name ||
    name.includes("\0") ||
    name.includes("\\") ||
    name.startsWith("/")
  )
    return false;
  const parts = name.split("/");
  return !parts.some((part) => part === "..");
}

function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  fail("ZIP_EOCD_MISSING", "ZIP central directory terminator is missing");
}

function readSelectedZipEntries(buffer, selectedNames) {
  assert(
    Buffer.isBuffer(buffer),
    "ZIP_BUFFER_REQUIRED",
    "ZIP input must be a buffer",
  );
  assert(
    buffer.length <= MAX_ARCHIVE_BYTES,
    "ZIP_TOO_LARGE",
    "ZIP exceeds the archive safety limit",
  );
  const eocd = findEndOfCentralDirectory(buffer);
  const disk = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const diskEntries = buffer.readUInt16LE(eocd + 8);
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const commentLength = buffer.readUInt16LE(eocd + 20);
  assert(
    disk === 0 && centralDisk === 0 && diskEntries === totalEntries,
    "ZIP_MULTIDISK_UNSUPPORTED",
    "Multi-disk ZIP files are not supported",
  );
  assert(
    totalEntries !== 0xffff &&
      centralSize !== 0xffffffff &&
      centralOffset !== 0xffffffff,
    "ZIP64_UNSUPPORTED",
    "ZIP64 archives are not supported",
  );
  assert(
    eocd + 22 + commentLength === buffer.length,
    "ZIP_TRAILING_BYTES",
    "ZIP has unexpected trailing bytes",
  );
  assert(
    centralOffset + centralSize <= eocd,
    "ZIP_CENTRAL_RANGE",
    "ZIP central directory is outside the archive",
  );

  const selected = new Map();
  const seen = new Set();
  let offset = centralOffset;
  for (let index = 0; index < totalEntries; index++) {
    assert(
      offset + 46 <= buffer.length &&
        buffer.readUInt32LE(offset) === 0x02014b50,
      "ZIP_CENTRAL_ENTRY",
      "ZIP central directory entry is invalid",
    );
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const expectedCrc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const entryCommentLength = buffer.readUInt16LE(offset + 32);
    const entryDisk = buffer.readUInt16LE(offset + 34);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const nextOffset =
      offset + 46 + nameLength + extraLength + entryCommentLength;
    assert(
      nextOffset <= centralOffset + centralSize,
      "ZIP_CENTRAL_ENTRY_RANGE",
      "ZIP entry metadata is truncated",
    );
    const nameBuffer = buffer.subarray(offset + 46, offset + 46 + nameLength);
    const name = nameBuffer.toString(flags & 0x0800 ? "utf8" : "latin1");
    assert(
      safeZipName(name),
      "ZIP_UNSAFE_PATH",
      "ZIP contains an unsafe entry name",
    );
    assert(
      !seen.has(name),
      "ZIP_DUPLICATE_ENTRY",
      "ZIP contains duplicate entry names",
    );
    seen.add(name);
    assert(
      entryDisk === 0,
      "ZIP_MULTIDISK_ENTRY",
      "ZIP entry belongs to another disk",
    );
    assert(
      (flags & 0x0001) === 0,
      "ZIP_ENCRYPTED_ENTRY",
      "Encrypted ZIP entries are not supported",
    );
    assert(
      compressedSize !== 0xffffffff &&
        uncompressedSize !== 0xffffffff &&
        localOffset !== 0xffffffff,
      "ZIP64_ENTRY_UNSUPPORTED",
      "ZIP64 entries are not supported",
    );

    if (selectedNames.has(name)) {
      assert(
        uncompressedSize <= MAX_SOURCE_ENTRY_BYTES,
        "ZIP_SOURCE_ENTRY_TOO_LARGE",
        "A required source entry exceeds the safety limit",
      );
      assert(
        method === 0 || method === 8,
        "ZIP_METHOD_UNSUPPORTED",
        "Required ZIP entry uses an unsupported method",
      );
      assert(
        localOffset + 30 <= buffer.length &&
          buffer.readUInt32LE(localOffset) === 0x04034b50,
        "ZIP_LOCAL_ENTRY",
        "Required ZIP local entry is invalid",
      );
      const localFlags = buffer.readUInt16LE(localOffset + 6);
      const localMethod = buffer.readUInt16LE(localOffset + 8);
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      assert(
        localFlags === flags && localMethod === method,
        "ZIP_HEADER_MISMATCH",
        "ZIP local and central headers disagree",
      );
      const localNameStart = localOffset + 30;
      const localName = buffer
        .subarray(localNameStart, localNameStart + localNameLength)
        .toString(flags & 0x0800 ? "utf8" : "latin1");
      assert(
        localName === name,
        "ZIP_LOCAL_NAME_MISMATCH",
        "ZIP local entry name differs from the central directory",
      );
      const dataStart = localNameStart + localNameLength + localExtraLength;
      const dataEnd = dataStart + compressedSize;
      assert(
        dataEnd <= buffer.length,
        "ZIP_ENTRY_TRUNCATED",
        "Required ZIP entry is truncated",
      );
      const compressed = buffer.subarray(dataStart, dataEnd);
      let value;
      try {
        value =
          method === 0
            ? Buffer.from(compressed)
            : zlib.inflateRawSync(compressed, {
                maxOutputLength: MAX_SOURCE_ENTRY_BYTES,
              });
      } catch {
        fail(
          "ZIP_INFLATE_FAILED",
          "Required ZIP entry could not be decompressed",
        );
      }
      assert(
        value.length === uncompressedSize,
        "ZIP_ENTRY_SIZE_MISMATCH",
        "Required ZIP entry size is invalid",
      );
      assert(
        crc32(value) === expectedCrc,
        "ZIP_ENTRY_CRC_MISMATCH",
        "Required ZIP entry checksum is invalid",
      );
      selected.set(name, value);
    }
    offset = nextOffset;
  }
  assert(
    offset === centralOffset + centralSize,
    "ZIP_CENTRAL_SIZE_MISMATCH",
    "ZIP central directory size is invalid",
  );
  for (const name of selectedNames) {
    assert(
      selected.has(name),
      "ZIP_REQUIRED_ENTRY_MISSING",
      `Required source entry is missing: ${name}`,
    );
  }
  return { entries: selected, entryCount: totalEntries };
}

function findJsonArrayEnd(source, start) {
  assert(
    source[start] === "[",
    "SOURCE_ARRAY_REQUIRED",
    "Export must start with a JSON array",
  );
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index++) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "[") depth++;
    else if (character === "]") {
      depth--;
      if (depth === 0) return index;
      assert(
        depth >= 0,
        "SOURCE_ARRAY_UNBALANCED",
        "Exported JSON array is unbalanced",
      );
    }
  }
  fail("SOURCE_ARRAY_UNTERMINATED", "Exported JSON array is unterminated");
}

function parseExportedJsonArray(buffer, exportName, typedDeclaration = "") {
  let source = buffer.toString("utf8");
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
  assert(
    !source.includes("\0"),
    "SOURCE_NUL_BYTE",
    "Source entry contains a NUL byte",
  );
  const marker = `export const ${exportName}${typedDeclaration} =`;
  const markerAt = source.indexOf(marker);
  assert(
    markerAt >= 0 && source.indexOf(marker, markerAt + marker.length) < 0,
    "SOURCE_EXPORT_MISSING",
    `Expected unique ${exportName} export was not found`,
  );
  let start = markerAt + marker.length;
  while (/\s/.test(source[start] || "")) start++;
  const end = findJsonArrayEnd(source, start);
  const suffix = source.slice(end + 1);
  assert(
    /^\s*(?:as\s+const\s*)?;\s*$/.test(suffix),
    "SOURCE_EXECUTABLE_SUFFIX",
    `Unexpected executable syntax follows ${exportName}`,
  );
  let value;
  try {
    value = JSON.parse(source.slice(start, end + 1));
  } catch {
    fail(
      "SOURCE_NOT_STRICT_JSON",
      `${exportName} must contain a strict JSON array literal`,
    );
  }
  assert(
    Array.isArray(value),
    "SOURCE_ARRAY_REQUIRED",
    `${exportName} is not an array`,
  );
  return value;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertKnownKeys(value, allowed, location) {
  assert(
    isPlainObject(value),
    "SOURCE_OBJECT_REQUIRED",
    `${location} must be an object`,
  );
  for (const key of Object.keys(value)) {
    assert(
      !["__proto__", "prototype", "constructor"].includes(key),
      "SOURCE_UNSAFE_KEY",
      `${location} contains an unsafe key`,
    );
    assert(
      allowed.has(key),
      "SOURCE_UNKNOWN_FIELD",
      `${location} contains unknown field ${key}`,
    );
  }
}

function sourceString(
  value,
  location,
  { required = false, max = 10_000 } = {},
) {
  if (value === undefined || value === null) {
    assert(!required, "SOURCE_FIELD_REQUIRED", `${location} is required`);
    return "";
  }
  assert(
    typeof value === "string",
    "SOURCE_STRING_REQUIRED",
    `${location} must be a string`,
  );
  assert(
    value.length <= max,
    "SOURCE_STRING_TOO_LONG",
    `${location} exceeds its safety limit`,
  );
  const trimmed = value.trim();
  assert(
    !required || trimmed.length > 0,
    "SOURCE_FIELD_REQUIRED",
    `${location} cannot be empty`,
  );
  return trimmed;
}

function sourceInteger(value, location) {
  assert(
    Number.isSafeInteger(value) && value >= 0 && value <= 20_000_000,
    "SOURCE_INTEGER_INVALID",
    `${location} must be a non-negative safe integer`,
  );
  return value;
}

function stringArray(value, location, maximum = 1000) {
  assert(
    Array.isArray(value),
    "SOURCE_ARRAY_REQUIRED",
    `${location} must be an array`,
  );
  assert(
    value.length <= maximum,
    "SOURCE_ARRAY_TOO_LARGE",
    `${location} exceeds its safety limit`,
  );
  return value.map((item, index) =>
    sourceString(item, `${location}[${index}]`, { max: 10_000 }),
  );
}

function uniqueStrings(values) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const trimmed = String(value || "").trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    output.push(trimmed);
  }
  return output;
}

function compactObject(value) {
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === null || item === "") continue;
    if (Array.isArray(item) && item.length === 0) continue;
    if (isPlainObject(item) && Object.keys(item).length === 0) continue;
    output[key] = item;
  }
  return output;
}

function normalizePhone(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return null;
  let digits = trimmed.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("77")) digits = digits.slice(1);
  else if (digits.length === 11 && digits.startsWith("77")) return null;
  else if (digits.length === 11 && digits.startsWith("8"))
    digits = `7${digits.slice(1)}`;
  else if (digits.length === 10) digits = `7${digits}`;
  else if (digits.length < 10) return null;
  return `+${digits}`;
}

function normalizeEmail(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : null;
}

function addContactPoint(
  points,
  seen,
  invalid,
  type,
  rawValue,
  label,
  isPrimary,
  sourceField,
) {
  const value = String(rawValue || "").trim();
  if (!value) return;
  const normalized =
    type === "PHONE" ? normalizePhone(value) : normalizeEmail(value);
  if (!normalized) {
    invalid.push({ field: sourceField, value });
    return;
  }
  const key = `${type}:${normalized}`;
  if (seen.has(key)) return;
  seen.add(key);
  const point = { type, value };
  if (isPrimary) point.isPrimary = true;
  points.push(point);
}

function positiveAmoId(value, location) {
  const text = sourceString(value, location, { max: 128 });
  if (!text) return null;
  assert(
    /^\d{1,19}$/.test(text),
    "SOURCE_AMO_ID_INVALID",
    `${location} must be a numeric amoCRM identifier`,
  );
  const parsed = BigInt(text);
  assert(
    parsed >= 1n && parsed <= MAX_POSTGRES_BIGINT,
    "SOURCE_AMO_ID_INVALID",
    `${location} is outside the PostgreSQL bigint range`,
  );
  return text;
}

function validHttpUrl(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 1000) return undefined;
  try {
    const parsed = new URL(text);
    return ["http:", "https:"].includes(parsed.protocol) ? text : undefined;
  } catch {
    return undefined;
  }
}

function isoAtMoscowStartOfDay(value, location) {
  const text = sourceString(value, location, { max: 64 });
  if (!text) return undefined;
  let year;
  let month;
  let day;
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) [, year, month, day] = match;
  else {
    match = text.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (match) [, day, month, year] = match;
  }
  if (year) {
    const check = new Date(
      Date.UTC(Number(year), Number(month) - 1, Number(day)),
    );
    assert(
      check.getUTCFullYear() === Number(year) &&
        check.getUTCMonth() + 1 === Number(month) &&
        check.getUTCDate() === Number(day),
      "SOURCE_DATE_INVALID",
      `${location} is not a calendar date`,
    );
    return `${year}-${month}-${day}T00:00:00+03:00`;
  }
  assert(
    /^\d{4}-\d{2}-\d{2}T/.test(text) &&
      Number.isFinite(new Date(text).getTime()),
    "SOURCE_DATE_INVALID",
    `${location} is not an ISO date`,
  );
  return text;
}

function normalizedMonthCounts(value, location) {
  assert(
    isPlainObject(value),
    "SOURCE_MONTH_MAP_REQUIRED",
    `${location} must be an object`,
  );
  const output = {};
  for (const month of Object.keys(value).sort()) {
    assert(
      /^\d{4}-(?:0[1-9]|1[0-2])$/.test(month),
      "SOURCE_MONTH_KEY_INVALID",
      `${location} contains an invalid month key`,
    );
    output[month] = sourceInteger(value[month], `${location}.${month}`);
  }
  return output;
}

function moneyFromIntegerRub(value, location) {
  assert(
    Number.isSafeInteger(value) && value >= 0 && value <= 9_999_999_999_999_999,
    "SOURCE_MONEY_INVALID",
    `${location} must be a non-negative safe integer RUB amount`,
  );
  const amount = value;
  return `${amount}.00`;
}

function decimalNumberToScaledInteger(value, scaleDigits, location) {
  assert(
    typeof value === "number" && Number.isFinite(value) && value >= 0,
    "SOURCE_DECIMAL_INVALID",
    `${location} must be a non-negative decimal number`,
  );
  const lexical = String(value).toLowerCase();
  const match = lexical.match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/);
  assert(
    match,
    "SOURCE_DECIMAL_INVALID",
    `${location} has an unsupported decimal representation`,
  );
  const fraction = match[2] || "";
  const exponent = Number(match[3] || 0);
  const shift = scaleDigits + exponent - fraction.length;
  let integer = BigInt(`${match[1]}${fraction}`);
  if (shift >= 0) integer *= 10n ** BigInt(shift);
  else {
    const divisor = 10n ** BigInt(-shift);
    assert(
      integer % divisor === 0n,
      "SOURCE_DECIMAL_PRECISION",
      `${location} has precision beyond the documented unit`,
    );
    integer /= divisor;
  }
  assert(
    integer <= 9_999_999_999_999_999n,
    "SOURCE_DECIMAL_OVERFLOW",
    `${location} exceeds Decimal(18,2)`,
  );
  return integer;
}

function moneyFromMillionRub(value, location) {
  const rubles = decimalNumberToScaledInteger(value, 6, location);
  return `${rubles}.00`;
}

function moneyToCents(value) {
  const match = String(value).match(/^(\d+)(?:\.(\d{1,2}))?$/);
  assert(match, "MONEY_INTERNAL_INVALID", "Internal monetary value is invalid");
  return BigInt(match[1]) * 100n + BigInt((match[2] || "").padEnd(2, "0"));
}

function centsToMoney(value) {
  return `${value / 100n}.${String(value % 100n).padStart(2, "0")}`;
}

function normalizeSpecializations(value) {
  const groups = sourceString(value, "broker.specialization", { max: 10_000 })
    .split(/[\n;,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return uniqueStrings(
    groups.flatMap((item) => {
      if (
        ["Бизнес-класс", "Премиум", "Элитная", "Региональный брокер"].includes(
          item,
        )
      )
        return ["Бизнес / премиум"];
      if (item === "Вторичка бизнес+") return ["Вторичка"];
      if (["Инвестиции", "Коммерция / офисы", "Коммерция"].includes(item)) {
        return ["Коммерция — аренда", "Коммерция — продажа"];
      }
      return [item];
    }),
  );
}

function normalizeCallResult(value) {
  const text = String(value || "").trim();
  if (/ндз|недозвон/i.test(text)) return "НДЗ";
  if (/проинформирован/i.test(text)) return "Проинформирован";
  if (/неактуально|не интересно|неинтересно/i.test(text)) return "Неинтересно";
  if (/просил не звонить|отказ от коммуникации/i.test(text))
    return "Просил не звонить";
  if (/только отправить|отправить инф/i.test(text))
    return "Просил отправить информацию";
  if (/запись на бт/i.test(text)) return "Запись на БТ";
  if (/отказ от бт/i.test(text)) return "Отказ от БТ";
  if (/некорректн/i.test(text)) return "Некорректный номер";
  if (/не брокер|уже не брокер/i.test(text)) return "Уже не брокер";
  return text;
}

function importedCallPeriod(label) {
  if (/август/i.test(label)) return "2026-08";
  if (/июль/i.test(label)) return "2026-07";
  if (/зорге/i.test(label)) return "2026-06";
  if (label === "Результат звонка") return "2026-05";
  return undefined;
}

function importedCampaignName(label) {
  if (/зорге/i.test(label)) return "Обзвон июнь";
  if (label === "Результат звонка") return "Обзвон май";
  return label;
}

function normalizeAgencyAlias(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[«»"']/g, "")
    .replace(/\s+/g, " ");
}

function splitAliases(value) {
  return uniqueStrings(
    String(value || "")
      .split(";")
      .map((item) => item.trim()),
  );
}

function buildAgencyIdentity(row, index) {
  const id = sourceString(row.id, `agencies[${index}].id`, {
    required: true,
    max: 128,
  });
  return {
    externalKey: `anna:agency:id-sha256:${sha256(`ANNA_AGENCY\0${id}`)}`,
    sourceExternalId: id,
  };
}

function brokerExternalKey(normalizedPhone) {
  // The source has no immutable non-CRM row ID. A full namespaced SHA-256 of
  // the unique normalized phone is the least-unsafe deterministic fallback:
  // it does not expose the number, does not merge on a name, and a changed
  // phone intentionally creates a new row for manual reconciliation.
  return `anna:broker:phone-sha256:${sha256(`ANNA_BROKER_PHONE\0${normalizedPhone}`)}`;
}

function buildAgency(row, index) {
  const location = `agencies[${index}]`;
  assertKnownKeys(row, AGENCY_KEYS, location);
  assert(
    sourceString(row.kind, `${location}.kind`, { required: true, max: 32 }) ===
      "agency",
    "SOURCE_AGENCY_KIND",
    `${location}.kind must be agency`,
  );
  const identity = buildAgencyIdentity(row, index);
  const displayName = sourceString(row.name, `${location}.name`, {
    required: true,
    max: 256,
  });
  const company =
    sourceString(row.company, `${location}.company`, { max: 256 }) ||
    displayName;
  const points = [];
  const pointKeys = new Set();
  const invalidContacts = [];
  addContactPoint(
    points,
    pointKeys,
    invalidContacts,
    "PHONE",
    row.phone,
    "Основной",
    true,
    "phone",
  );
  addContactPoint(
    points,
    pointKeys,
    invalidContacts,
    "EMAIL",
    row.email,
    "Основной",
    true,
    "email",
  );

  assert(
    Array.isArray(row.agencyContacts),
    "SOURCE_ARRAY_REQUIRED",
    `${location}.agencyContacts must be an array`,
  );
  assert(
    row.agencyContacts.length <= 20,
    "SOURCE_CONTACT_LIMIT",
    `${location}.agencyContacts exceeds the import limit`,
  );
  const agencyContacts = row.agencyContacts.map((contact, contactIndex) => {
    const contactLocation = `${location}.agencyContacts[${contactIndex}]`;
    assertKnownKeys(contact, AGENCY_CONTACT_KEYS, contactLocation);
    const normalized = compactObject({
      id: sourceString(contact.id, `${contactLocation}.id`, {
        required: true,
        max: 128,
      }),
      name: sourceString(contact.name, `${contactLocation}.name`, {
        required: true,
        max: 256,
      }),
      role: sourceString(contact.role, `${contactLocation}.role`, { max: 120 }),
      phone: sourceString(contact.phone, `${contactLocation}.phone`, {
        max: 320,
      }),
      email: sourceString(contact.email, `${contactLocation}.email`, {
        max: 320,
      }),
    });
    addContactPoint(
      points,
      pointKeys,
      invalidContacts,
      "PHONE",
      normalized.phone,
      "Контакт агентства",
      false,
      `agencyContacts[${contactIndex}].phone`,
    );
    addContactPoint(
      points,
      pointKeys,
      invalidContacts,
      "EMAIL",
      normalized.email,
      "Контакт агентства",
      false,
      `agencyContacts[${contactIndex}].email`,
    );
    return normalized;
  });
  assert(
    points.length <= 20,
    "OUTPUT_CONTACT_LIMIT",
    `${location} produces more than 20 contact points`,
  );

  const crmIds = uniqueStrings(
    sourceString(row.crmIds, `${location}.crmIds`, { max: 10_000 })
      .split(";")
      .map((item) => item.trim()),
  ).map((value, crmIndex) =>
    positiveAmoId(value, `${location}.crmIds[${crmIndex}]`),
  );
  const externalIdentities = crmIds.map((externalId, crmIndex) => ({
    system: "AMOCRM",
    entityType: "COMPANY",
    externalId,
    ...(crmIndex === 0 ? { isPrimary: true } : {}),
  }));

  assert(
    Array.isArray(row.calls),
    "SOURCE_ARRAY_REQUIRED",
    `${location}.calls must be an array`,
  );
  const callBreakdown = row.calls.map((call, callIndex) => {
    const callLocation = `${location}.calls[${callIndex}]`;
    assertKnownKeys(call, AGENCY_CALL_KEYS, callLocation);
    return compactObject({
      source: "ANNA_FILE",
      id: sourceString(call.id, `${callLocation}.id`, { max: 128 }),
      date: sourceString(call.date, `${callLocation}.date`, { max: 64 }),
      campaign: sourceString(call.campaign, `${callLocation}.campaign`, {
        max: 500,
      }),
      employee: sourceString(call.employee, `${callLocation}.employee`, {
        max: 256,
      }),
      result: sourceString(call.result, `${callLocation}.result`, {
        max: 10_000,
      }),
      agreement: sourceString(call.agreement, `${callLocation}.agreement`, {
        max: 10_000,
      }),
      nextAt: sourceString(call.nextAt, `${callLocation}.nextAt`, { max: 64 }),
    });
  });
  assert(
    callBreakdown.length <= 1000,
    "SOURCE_CALL_LIMIT",
    `${location}.calls exceeds the aggregate limit`,
  );

  assert(
    Array.isArray(row.recognitions),
    "SOURCE_ARRAY_REQUIRED",
    `${location}.recognitions must be an array`,
  );
  const recognitions = row.recognitions.map((item, recognitionIndex) => {
    const recognitionLocation = `${location}.recognitions[${recognitionIndex}]`;
    assertKnownKeys(item, RECOGNITION_KEYS, recognitionLocation);
    const output = {};
    for (const key of Object.keys(item).sort()) {
      const value = item[key];
      if (value === undefined || value === null || value === "") continue;
      assert(
        ["string", "number", "boolean"].includes(typeof value),
        "SOURCE_RECOGNITION_VALUE",
        `${recognitionLocation}.${key} has an unsupported value`,
      );
      output[key] = value;
    }
    return output;
  });

  const meetings = sourceInteger(row.meetings, `${location}.meetings`);
  const deals = sourceInteger(row.deals, `${location}.deals`);
  const fixations = sourceInteger(row.fixations, `${location}.fixations`);
  const dealAmount = moneyFromMillionRub(row.sales, `${location}.sales`);
  const sourceAggregate = compactObject({
    sourceKind: "ANNA_LEGACY_CRM",
    sourceVersion: "crm-agencies-v1",
    sourceLabel: "Данные Анны",
    quality: "SOURCE_REPORTED",
    exactness: "UNKNOWN",
    periodKind: "LIFETIME",
    contributesToSourceSummary: true,
    fixationCount: fixations,
    meetingCount: meetings,
    dealCount: deals,
    dealAmount,
    currency: "RUB",
    lastMeetingAt: isoAtMoscowStartOfDay(
      row.lastMeetingDate,
      `${location}.lastMeetingDate`,
    ),
    lastDealAt: isoAtMoscowStartOfDay(
      row.lastDealDate,
      `${location}.lastDealDate`,
    ),
    dealsByMonth: normalizedMonthCounts(
      row.dealsByMonth,
      `${location}.dealsByMonth`,
    ),
    provenance: {
      rawField: "sales",
      rawUnit: "MILLION_RUB",
      scale: 1000000,
    },
  });

  const aliases = uniqueStrings(
    [...splitAliases(row.aliases), ...splitAliases(row.crmNames)].filter(
      (value) => value !== displayName && value !== company,
    ),
  );
  const attributes = compactObject({
    company,
    role: sourceString(row.role, `${location}.role`, { max: 120 }),
    specialization: sourceString(
      row.specialization,
      `${location}.specialization`,
      { max: 10_000 },
    ),
    stage: sourceString(row.stage, `${location}.stage`, { max: 256 }),
    birthday: sourceString(row.birthday, `${location}.birthday`, { max: 64 }),
    btDate: sourceString(row.btDate, `${location}.btDate`, { max: 64 }),
    rating: row.rating,
    assignee: sourceString(row.assigned, `${location}.assigned`, { max: 256 }),
    agencyContacts,
    agencySize: sourceString(row.agencySize, `${location}.agencySize`, {
      max: 120,
    }),
    brokerCount: row.brokerCount,
    website: sourceString(row.website, `${location}.website`, { max: 1000 }),
    projectsOnSite: sourceString(
      row.projectsOnSite,
      `${location}.projectsOnSite`,
      { max: 500 },
    ),
    sitePlacementRequirements: sourceString(
      row.sitePlacementRequirements,
      `${location}.sitePlacementRequirements`,
      { max: 10_000 },
    ),
    lastAgencyMeetingDate: sourceString(
      row.lastAgencyMeetingDate,
      `${location}.lastAgencyMeetingDate`,
      { max: 64 },
    ),
    agencyBtFormat: sourceString(
      row.agencyBtFormat,
      `${location}.agencyBtFormat`,
      { max: 1000 },
    ),
    activeBrokers: row.activeBrokers,
    lastContractDate: sourceString(
      row.lastContractDate,
      `${location}.lastContractDate`,
      { max: 64 },
    ),
    nextAgreement: sourceString(
      row.nextAgreement,
      `${location}.nextAgreement`,
      { max: 10_000 },
    ),
    partnershipStatus: sourceString(
      row.partnershipStatus,
      `${location}.partnershipStatus`,
      { max: 256 },
    ),
    crmSource: sourceString(row.crmSource, `${location}.crmSource`, {
      max: 256,
    }),
    dataQuality: sourceString(row.verification, `${location}.verification`, {
      max: 256,
    }),
    aliases,
    paymentControl: row.paymentControl,
    successfulDeals: row.successfulDeals,
    zorgeDeals: row.zorgeDeals,
    berzarinaDeals: row.berzarinaDeals,
    activeCrmCards: row.activeCrmCards,
    crmScore: row.crmScore,
    dealsWithAmount: row.dealsWithAmount,
    verifiedDealIds: Array.isArray(row.verifiedDealIds)
      ? row.verifiedDealIds
      : undefined,
    calls: callBreakdown,
    recognitions,
    invalidContacts,
  });
  assert(
    Buffer.byteLength(JSON.stringify(attributes), "utf8") <= 32 * 1024,
    "OUTPUT_METADATA_TOO_LARGE",
    `${location} attributes exceed the API metadata limit`,
  );

  return {
    record: compactObject({
      externalKey: identity.externalKey,
      entityType: "AGENCY",
      displayName,
      sourceExternalId: identity.sourceExternalId,
      attributes,
      contactPoints: points,
      externalIdentities,
      sourceAggregate,
    }),
    aliases: uniqueStrings([
      displayName,
      company,
      ...splitAliases(row.aliases),
      ...splitAliases(row.crmNames),
    ]),
    rawPhone: sourceString(row.phone, `${location}.phone`, { max: 320 }),
    agencyContactCount: agencyContacts.length,
  };
}

function buildAgencyAliasIndex(agencies) {
  const index = new Map();
  for (const agency of agencies) {
    for (const alias of agency.aliases) {
      const normalized = normalizeAgencyAlias(alias);
      if (!normalized) continue;
      if (!index.has(normalized)) index.set(normalized, new Set());
      index.get(normalized).add(agency.record.externalKey);
    }
  }
  return index;
}

function buildBroker(row, index, agencyAliasIndex, brokerAmoIdCounts) {
  const location = `brokers[${index}]`;
  assertKnownKeys(row, BROKER_KEYS, location);
  const crm = row.crm === undefined || row.crm === null ? {} : row.crm;
  assertKnownKeys(crm, BROKER_CRM_KEYS, `${location}.crm`);
  const rawPhone = sourceString(row.phone, `${location}.phone`, {
    required: true,
    max: 320,
  });
  const normalizedPhone = normalizePhone(rawPhone);

  const rawName = sourceString(row.name, `${location}.name`, { max: 256 });
  const crmName = sourceString(crm.name, `${location}.crm.name`, { max: 256 });
  const displayName = crmName || rawName || "Имя не указано";
  const rawCompany = sourceString(row.company, `${location}.company`, {
    max: 256,
  });
  const crmCompany = sourceString(crm.company, `${location}.crm.company`, {
    max: 256,
  });
  const company = crmCompany || rawCompany;

  const points = [];
  const pointKeys = new Set();
  const invalidContacts = [];
  addContactPoint(
    points,
    pointKeys,
    invalidContacts,
    "PHONE",
    rawPhone,
    "Основной",
    true,
    "phone",
  );
  const emailCandidates = uniqueStrings([
    sourceString(crm.email, `${location}.crm.email`, { max: 320 }),
    ...stringArray(crm.emails || [], `${location}.crm.emails`, 20),
    sourceString(row.email, `${location}.email`, { max: 320 }),
  ]);
  emailCandidates.forEach((email, emailIndex) =>
    addContactPoint(
      points,
      pointKeys,
      invalidContacts,
      "EMAIL",
      email,
      emailIndex === 0 ? "Основной" : "Дополнительный",
      emailIndex === 0,
      `emails[${emailIndex}]`,
    ),
  );
  assert(
    points.length <= 20,
    "OUTPUT_CONTACT_LIMIT",
    `${location} produces more than 20 contact points`,
  );

  const crmIdValues = uniqueStrings([
    sourceString(crm.id, `${location}.crm.id`, { max: 128 }),
    ...stringArray(crm.ids || [], `${location}.crm.ids`, 50),
  ]);
  const crmIds = crmIdValues.map((value, crmIndex) =>
    positiveAmoId(value, `${location}.crm.ids[${crmIndex}]`),
  );
  // Validate the legacy URL shape, but do not duplicate it in every identity:
  // amoCRM links are reconstructable from the retained external IDs.
  if (crm.url)
    assert(
      validHttpUrl(crm.url),
      "SOURCE_AMO_URL_INVALID",
      `${location}.crm.url is invalid`,
    );
  const externalIdentities = crmIds.map((externalId, crmIndex) =>
    compactObject({
      system: "AMOCRM",
      entityType: "CONTACT",
      externalId,
      isPrimary: crmIndex === 0 ? true : undefined,
    }),
  );

  assert(
    Array.isArray(row.history),
    "SOURCE_ARRAY_REQUIRED",
    `${location}.history must be an array`,
  );
  assert(
    row.history.length <= 1000,
    "SOURCE_HISTORY_LIMIT",
    `${location}.history exceeds the aggregate limit`,
  );
  const history = row.history.map((tuple, historyIndex) => {
    assert(
      Array.isArray(tuple) && tuple.length === 2,
      "SOURCE_HISTORY_TUPLE",
      `${location}.history[${historyIndex}] must be a two-item tuple`,
    );
    const campaign = sourceString(
      tuple[0],
      `${location}.history[${historyIndex}][0]`,
      { max: 1000 },
    );
    const result = sourceString(
      tuple[1],
      `${location}.history[${historyIndex}][1]`,
      { max: 10_000 },
    );
    // Compact lossless tuple: [label, rawValue, normalizedResult,
    // campaignMonth|null]. A missing fifth value means occurredAt is unknown;
    // month attribution must never be promoted to an invented event date.
    return [
      campaign,
      result,
      normalizeCallResult(result),
      importedCallPeriod(campaign) || null,
    ];
  });
  assert(
    Array.isArray(crm.callsMayAugust || []),
    "SOURCE_ARRAY_REQUIRED",
    `${location}.crm.callsMayAugust must be an array`,
  );
  const datedCalls = (crm.callsMayAugust || []).map((call, callIndex) => {
    const callLocation = `${location}.crm.callsMayAugust[${callIndex}]`;
    assertKnownKeys(call, BROKER_CRM_CALL_KEYS, callLocation);
    return compactObject({
      source: "AMOCRM",
      date: sourceString(call.date, `${callLocation}.date`, { max: 64 }),
      direction: sourceString(call.direction, `${callLocation}.direction`, {
        max: 80,
      }),
      result: sourceString(call.result, `${callLocation}.result`, {
        max: 10_000,
      }),
      occurredAtKnown: Boolean(
        sourceString(call.date, `${callLocation}.date`, { max: 64 }),
      ),
    });
  });
  assert(
    history.length + datedCalls.length <= 1000,
    "SOURCE_CALL_LIMIT",
    `${location} call history exceeds the aggregate limit`,
  );

  const fixations = sourceInteger(crm.fixations, `${location}.crm.fixations`);
  const meetings = sourceInteger(crm.meetings, `${location}.crm.meetings`);
  const deals = sourceInteger(crm.deals, `${location}.crm.deals`);
  const btValue = sourceString(crm.bt, `${location}.crm.bt`, { max: 32 });
  const btDate = isoAtMoscowStartOfDay(crm.btDate, `${location}.crm.btDate`);
  const hasBt = btValue === "1" || Boolean(btDate);
  const wasInvitedToBt = history.some((call) => call[2] === "Запись на БТ");
  const stage =
    deals > 1
      ? "Повторные сделки / VIP"
      : deals > 0
        ? "Сделка"
        : meetings > 0
          ? "Встреча"
          : fixations > 0
            ? "Фиксация"
            : hasBt
              ? "Был на БТ"
              : wasInvitedToBt
                ? "Приглашён на БТ"
                : "Звонили";
  const crmRegion = sourceString(crm.region, `${location}.crm.region`, {
    max: 100,
  });
  const geography = sourceString(row.geography, `${location}.geography`, {
    max: 100,
  });
  const isRegional =
    geography === "Регион" || Boolean(crmRegion && !/москв/i.test(crmRegion));
  const rowRole = sourceString(row.role, `${location}.role`, { max: 120 });
  const sources = stringArray(row.sources, `${location}.sources`, 100);
  const isCoordinator =
    rowRole === "Координатор" || sources.includes("Координаторы");
  const sourceSpecialization = sourceString(
    row.specialization,
    `${location}.specialization`,
    { max: 10_000 },
  );
  const specializations = normalizeSpecializations(sourceSpecialization);
  const crmNames = stringArray(crm.names || [], `${location}.crm.names`, 50);
  const crmCompanies = stringArray(
    crm.companies || [],
    `${location}.crm.companies`,
    50,
  );
  const aliases = uniqueStrings([rawName, ...crmNames]).filter(
    (value) => value !== displayName,
  );
  const companyAliases = uniqueStrings([rawCompany, ...crmCompanies]).filter(
    (value) => value !== company,
  );

  const matchedAgencies = new Set();
  for (const candidate of uniqueStrings([company])) {
    const matches = agencyAliasIndex.get(normalizeAgencyAlias(candidate));
    if (matches) for (const key of matches) matchedAgencies.add(key);
  }
  const membership =
    matchedAgencies.size === 1
      ? "linked"
      : matchedAgencies.size > 1
        ? "ambiguous"
        : "unmatched";
  const organizationRoles =
    matchedAgencies.size === 1
      ? [
          {
            organizationExternalKey: [...matchedAgencies][0],
            role: isCoordinator ? "Координатор" : rowRole || "Брокер",
            isPrimary: true,
            evidence: { method: "EXACT_NORMALIZED_ALIAS", source: "ANNA_FILE" },
          },
        ]
      : [];

  const sourceDataQuality =
    sourceString(crm.verification, `${location}.crm.verification`, {
      max: 256,
    }) || "Не найден в amoCRM";
  const attributes = compactObject({
    company,
    companyAliases,
    role: isCoordinator ? "Координатор" : rowRole || "Брокер",
    workFormat: isCoordinator
      ? "Координатор"
      : company
        ? "Агентство"
        : "Частный брокер",
    specialization: specializations,
    sourceSpecialization:
      specializations.join("; ") === sourceSpecialization
        ? undefined
        : sourceSpecialization,
    geography,
    region: isRegional ? "Регион" : "Москва",
    stage,
    birthday: sourceString(crm.birthday, `${location}.crm.birthday`, {
      max: 64,
    }),
    btDate: sourceString(crm.btDate, `${location}.crm.btDate`, { max: 64 }),
    comment: sourceString(row.comment, `${location}.comment`, { max: 10_000 }),
    history,
    dataQuality: normalizedPhone ? sourceDataQuality : "Некорректный номер",
    sourceDataQuality: !normalizedPhone ? sourceDataQuality : undefined,
    exclusionCandidate: !normalizedPhone ? "INVALID_PHONE" : undefined,
    matchable: !normalizedPhone ? false : undefined,
    sources,
    aliases,
    invalidContacts,
  });
  assert(
    Buffer.byteLength(JSON.stringify(attributes), "utf8") <= 32 * 1024,
    "OUTPUT_METADATA_TOO_LARGE",
    `${location} attributes exceed the API metadata limit`,
  );

  const sourceAggregate = compactObject({
    sourceKind: "ANNA_LEGACY_CRM",
    sourceVersion: "broker-source-enriched-v1",
    sourceLabel: "Данные Анны",
    quality: "SOURCE_REPORTED",
    exactness: "UNKNOWN",
    periodKind: "LIFETIME",
    contributesToSourceSummary: true,
    fixationCount: fixations,
    meetingCount: meetings,
    dealCount: deals,
    brokerTourCount: hasBt ? 1 : 0,
    callCount: datedCalls.length,
    dealAmount: moneyFromIntegerRub(
      crm.dealAmountRub,
      `${location}.crm.dealAmountRub`,
    ),
    currency: "RUB",
    lastFixationAt: isoAtMoscowStartOfDay(
      crm.lastFixationDate,
      `${location}.crm.lastFixationDate`,
    ),
    lastMeetingAt: isoAtMoscowStartOfDay(
      crm.lastMeetingDate,
      `${location}.crm.lastMeetingDate`,
    ),
    lastDealAt: isoAtMoscowStartOfDay(
      crm.lastDealDate,
      `${location}.crm.lastDealDate`,
    ),
    lastCallAt: isoAtMoscowStartOfDay(
      crm.lastCallDate,
      `${location}.crm.lastCallDate`,
    ),
    brokerTourVisited: hasBt,
    brokerTourAt: btDate,
    dealsByMonth: normalizedMonthCounts(
      crm.dealsByMonth,
      `${location}.crm.dealsByMonth`,
    ),
    callBreakdown: datedCalls,
  });

  const uniqueAmoFallback = !normalizedPhone
    ? crmIds.find((id) => brokerAmoIdCounts.get(id) === 1)
    : undefined;
  const invalidIdentityHash = !normalizedPhone
    ? sha256(`ANNA_INVALID_BROKER_ROW\0${index + 1}\0${rawPhone}`)
    : undefined;
  return {
    record: compactObject({
      externalKey: normalizedPhone
        ? brokerExternalKey(normalizedPhone)
        : uniqueAmoFallback
          ? `anna:broker:amo-contact:${uniqueAmoFallback}`
          : `anna:broker:invalid-row-sha256:${invalidIdentityHash}`,
      entityType: "BROKER",
      displayName,
      city: isRegional && crmRegion ? crmRegion : "Москва",
      attributes,
      contactPoints: points,
      externalIdentities,
      organizationRoles,
      sourceAggregate,
    }),
    normalizedPhone,
    membership,
  };
}

function summarizeSourceReported(records) {
  const byEntityType = {};
  for (const [entityType, groupName] of [
    ["BROKER", "brokers"],
    ["AGENCY", "agencies"],
  ]) {
    const rows = records.filter(
      (record) => record.entityType === entityType && record.sourceAggregate,
    );
    const countMetric = (field) => {
      const values = rows
        .map((record) => record.sourceAggregate[field])
        .filter((value) => value !== undefined && value !== null);
      return {
        value: values.length
          ? values.reduce((total, value) => total + value, 0)
          : null,
        known: values.length,
      };
    };
    const fixations = countMetric("fixationCount");
    const meetings = countMetric("meetingCount");
    const deals = countMetric("dealCount");
    const brokerTours = countMetric("brokerTourCount");
    const calls = countMetric("callCount");
    const amountValues = rows
      .map((record) => record.sourceAggregate.dealAmount)
      .filter((value) => value !== undefined && value !== null)
      .map(moneyToCents);
    byEntityType[groupName] = {
      records: rows.length,
      fixations: fixations.value,
      fixationKnownRecords: fixations.known,
      meetings: meetings.value,
      meetingKnownRecords: meetings.known,
      deals: deals.value,
      dealKnownRecords: deals.known,
      brokerTours: brokerTours.value,
      brokerTourKnownRecords: brokerTours.known,
      calls: calls.value,
      callKnownRecords: calls.known,
      dealAmount: amountValues.length
        ? centsToMoney(amountValues.reduce((total, value) => total + value, 0n))
        : null,
      dealAmountKnownRecords: amountValues.length,
    };
  }
  return byEntityType;
}

function buildImportDocument(brokerRows, agencyRows) {
  const agencies = agencyRows.map(buildAgency);
  const agencyAliasIndex = buildAgencyAliasIndex(agencies);
  const sourceBrokerAmoIdCounts = new Map();
  for (let index = 0; index < brokerRows.length; index++) {
    const crm = isPlainObject(brokerRows[index]?.crm)
      ? brokerRows[index].crm
      : {};
    const ids = uniqueStrings([
      crm.id,
      ...(Array.isArray(crm.ids) ? crm.ids : []),
    ]);
    for (const id of ids)
      sourceBrokerAmoIdCounts.set(
        String(id),
        (sourceBrokerAmoIdCounts.get(String(id)) || 0) + 1,
      );
  }
  const brokers = brokerRows.map((row, index) =>
    buildBroker(row, index, agencyAliasIndex, sourceBrokerAmoIdCounts),
  );
  const records = [
    ...brokers.map((item) => item.record),
    ...agencies.map((item) => item.record),
  ].sort((left, right) => left.externalKey.localeCompare(right.externalKey));
  const externalKeys = new Set(records.map((record) => record.externalKey));
  assert(
    externalKeys.size === records.length,
    "OUTPUT_DUPLICATE_KEY",
    "Conversion produced duplicate external keys",
  );
  const uniquePhones = new Set(
    records.flatMap((record) =>
      (record.contactPoints || [])
        .filter((point) => point.type === "PHONE")
        .map((point) => normalizePhone(point.value))
        .filter(Boolean),
    ),
  );
  const externalIdentities = records.reduce(
    (sum, record) => sum + (record.externalIdentities || []).length,
    0,
  );
  const sourceAggregates = records.filter(
    (record) => record.sourceAggregate,
  ).length;
  const sourceReportedSummary = summarizeSourceReported(records);
  const document = {
    sourceName: "Broker Loyalty CRM / Anna Skibitskaya / 2026-08-17",
    ruleVersion: "anna-loyalty-import-v1",
    expectedRecords: records.length,
    expectedUniquePhones: uniquePhones.size,
    expectedActivities: 0,
    expectedSourceAggregates: sourceAggregates,
    expectedSourceReportedSummary: sourceReportedSummary,
    expectedExternalIdentities: externalIdentities,
    expectedIncludedFixations: 0,
    expectedIncludedMeetings: 0,
    expectedIncludedDeals: 0,
    expectedIncludedBrokerTours: 0,
    expectedIncludedCalls: 0,
    expectedIncludedDealAmount: "0.00",
    records,
  };

  const brokerAmoIds = brokers
    .flatMap((item) => item.record.externalIdentities || [])
    .filter(
      (identity) =>
        identity.system === "AMOCRM" && identity.entityType === "CONTACT",
    )
    .map((identity) => identity.externalId);
  const brokerAmoIdCounts = new Map();
  for (const id of brokerAmoIds)
    brokerAmoIdCounts.set(id, (brokerAmoIdCounts.get(id) || 0) + 1);
  const agencyAmoIds = agencies
    .flatMap((item) => item.record.externalIdentities || [])
    .filter(
      (identity) =>
        identity.system === "AMOCRM" && identity.entityType === "COMPANY",
    )
    .map((identity) => identity.externalId);
  const brokerSummary = sourceReportedSummary.brokers;
  const agencySummary = sourceReportedSummary.agencies;
  const report = {
    brokerRows: brokers.length,
    agencyRows: agencies.length,
    outputRecords: records.length,
    brokerUniquePhones: new Set(
      brokers.map((item) => item.normalizedPhone).filter(Boolean),
    ).size,
    invalidBrokerPhones: brokers.filter((item) => !item.normalizedPhone).length,
    allUniquePhones: uniquePhones.size,
    brokerRowsWithAmo: brokers.filter(
      (item) => (item.record.externalIdentities || []).length > 0,
    ).length,
    brokerIdentityReferences: brokerAmoIds.length,
    brokerUniqueIdentityReferences: new Set(brokerAmoIds).size,
    brokerConflictingIdentityReferences: [...brokerAmoIdCounts.values()].filter(
      (count) => count > 1,
    ).length,
    agencyIdentityReferences: agencyAmoIds.length,
    agencyUniqueIdentityReferences: new Set(agencyAmoIds).size,
    agencyContacts: agencies.reduce(
      (sum, item) => sum + item.agencyContactCount,
      0,
    ),
    agencyRowsWithPhone: agencies.filter((item) =>
      normalizePhone(item.rawPhone),
    ).length,
    agencyUniquePhones: new Set(
      agencies.map((item) => normalizePhone(item.rawPhone)).filter(Boolean),
    ).size,
    linkedBrokerAgencyRoles: brokers.filter(
      (item) => item.membership === "linked",
    ).length,
    ambiguousBrokerAgencyRoles: brokers.filter(
      (item) => item.membership === "ambiguous",
    ).length,
    unmatchedBrokerAgencyRoles: brokers.filter(
      (item) => item.membership === "unmatched",
    ).length,
    sourceAggregates,
    externalIdentities,
    brokerFixations: brokerSummary.fixations,
    brokerMeetings: brokerSummary.meetings,
    brokerDeals: brokerSummary.deals,
    brokerDealAmountRub: brokerSummary.dealAmount,
    brokerTours: brokerSummary.brokerTours,
    brokerDatedCalls: brokerSummary.calls,
    agencyMeetings: agencySummary.meetings,
    agencyDeals: agencySummary.deals,
    agencyDealAmountRub: agencySummary.dealAmount,
    invalidContactValues: records.reduce(
      (sum, record) =>
        sum +
        ((record.attributes && record.attributes.invalidContacts) || []).length,
      0,
    ),
  };
  return { document, report };
}

function assertCanonicalInventory(report) {
  const mismatches = [];
  for (const [field, expected] of Object.entries(CANONICAL_INVENTORY)) {
    if (report[field] !== expected)
      mismatches.push(
        `${field} expected ${expected} calculated ${report[field]}`,
      );
  }
  assert(
    mismatches.length === 0,
    "CANONICAL_INVENTORY_MISMATCH",
    `Canonical source inventory mismatch: ${mismatches.join("; ")}`,
  );
}

function convertArchive({
  zipPath,
  expectedSha256 = CANONICAL_ZIP_SHA256,
  maxOutputBytes = MAX_OUTPUT_BYTES,
}) {
  assert(
    typeof zipPath === "string" && zipPath.length > 0,
    "ZIP_PATH_REQUIRED",
    "A ZIP path is required",
  );
  assert(
    /^[a-f0-9]{64}$/i.test(expectedSha256),
    "EXPECTED_SHA_INVALID",
    "Expected ZIP SHA-256 must be 64 hexadecimal characters",
  );
  let archive;
  try {
    const stat = fs.statSync(zipPath);
    assert(
      stat.isFile(),
      "ZIP_NOT_FILE",
      "ZIP path does not point to a regular file",
    );
    assert(
      stat.size <= MAX_ARCHIVE_BYTES,
      "ZIP_TOO_LARGE",
      "ZIP exceeds the archive safety limit",
    );
    archive = fs.readFileSync(zipPath);
  } catch (error) {
    if (error instanceof ConversionError) throw error;
    fail("ZIP_READ_FAILED", "ZIP could not be read");
  }
  const archiveSha256 = sha256(archive);
  assert(
    archiveSha256 === expectedSha256.toLowerCase(),
    "ZIP_SHA256_MISMATCH",
    "ZIP SHA-256 does not match the explicitly expected value",
  );
  const selected = readSelectedZipEntries(
    archive,
    new Set([BROKER_ENTRY, AGENCY_ENTRY]),
  );
  const brokerRows = parseExportedJsonArray(
    selected.entries.get(BROKER_ENTRY),
    "brokerSourceRows",
    ": BrokerSourceRow[]",
  );
  const agencyRows = parseExportedJsonArray(
    selected.entries.get(AGENCY_ENTRY),
    "crmAgencySeed",
  );
  const { document, report } = buildImportDocument(brokerRows, agencyRows);
  if (archiveSha256 === CANONICAL_ZIP_SHA256) assertCanonicalInventory(report);
  const output = Buffer.from(JSON.stringify(document), "utf8");
  if (archiveSha256 === CANONICAL_ZIP_SHA256) {
    assert(
      output.length === CANONICAL_OUTPUT_BYTES &&
        sha256(output) === CANONICAL_OUTPUT_SHA256,
      "CANONICAL_OUTPUT_MISMATCH",
      "Canonical output changed; review the mapping and update the pinned output fingerprint explicitly",
    );
  }
  assert(
    output.length <= maxOutputBytes,
    "OUTPUT_TOO_LARGE",
    `Normalized JSON exceeds the ${maxOutputBytes}-byte import limit`,
  );
  const compressed = zlib.gzipSync(output, { level: 9, mtime: 0 });
  const gzipBase64Bytes = Math.ceil(compressed.length / 3) * 4;
  return {
    document,
    output,
    report: {
      sourceSha256: archiveSha256,
      sourceEntryCount: selected.entryCount,
      ...report,
      outputBytes: output.length,
      outputSha256: sha256(output),
      gzipBytes: compressed.length,
      gzipSha256: sha256(compressed),
      gzipBase64Bytes,
      gzipBase64Chunks45k: Math.ceil(gzipBase64Bytes / 45_000),
    },
  };
}

function writePrivateFile(outputPath, contents) {
  const destination = path.resolve(outputPath);
  const parent = path.dirname(destination);
  const parentStat = fs.statSync(parent);
  assert(
    parentStat.isDirectory(),
    "OUTPUT_PARENT_INVALID",
    "Output parent is not a directory",
  );
  assert(
    !fs.existsSync(destination),
    "OUTPUT_EXISTS",
    "Output already exists; choose a new path",
  );
  const temporary = path.join(
    parent,
    `.${path.basename(destination)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    const descriptor = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, contents);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.chmodSync(temporary, 0o600);
    fs.linkSync(temporary, destination);
    fs.chmodSync(destination, 0o600);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      /* best-effort cleanup */
    }
  }
  return {
    posixModeRequested: "0600",
    posixModeEnforced: process.platform !== "win32",
  };
}

function usage() {
  return [
    "Usage:",
    "  node scripts/anna-loyalty/convert.js --zip <source.zip> --output <import.json>",
    "  node scripts/anna-loyalty/convert.js --zip <source.zip> --report-only",
    "",
    `Default expected ZIP SHA-256: ${CANONICAL_ZIP_SHA256}`,
    "Use --expected-sha256 <64-hex> only for an explicitly reviewed replacement package.",
  ].join("\n");
}

function parseArguments(argv) {
  const options = { expectedSha256: CANONICAL_ZIP_SHA256, reportOnly: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--report-only") options.reportOnly = true;
    else if (
      argument === "--zip" ||
      argument === "--output" ||
      argument === "--expected-sha256"
    ) {
      const value = argv[++index];
      assert(
        value && !value.startsWith("--"),
        "CLI_VALUE_REQUIRED",
        `${argument} requires a value`,
      );
      if (argument === "--zip") options.zipPath = value;
      else if (argument === "--output") options.outputPath = value;
      else options.expectedSha256 = value.toLowerCase();
    } else fail("CLI_UNKNOWN_ARGUMENT", `Unknown argument: ${argument}`);
  }
  if (!options.help) {
    assert(options.zipPath, "ZIP_PATH_REQUIRED", "--zip is required");
    assert(
      options.reportOnly || options.outputPath,
      "OUTPUT_PATH_REQUIRED",
      "--output is required unless --report-only is used",
    );
    assert(
      !(options.reportOnly && options.outputPath),
      "CLI_MODE_CONFLICT",
      "--report-only cannot be combined with --output",
    );
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const converted = convertArchive({
    zipPath: options.zipPath,
    expectedSha256: options.expectedSha256,
  });
  const fileSecurity = options.reportOnly
    ? { posixModeRequested: null, posixModeEnforced: null }
    : writePrivateFile(options.outputPath, converted.output);
  // Deliberately report only hashes, counts and mode facts. Names, phones,
  // emails, comments and source paths never reach stdout/stderr.
  process.stdout.write(
    `${JSON.stringify(
      {
        mode: options.reportOnly ? "report-only" : "written",
        ...converted.report,
        fileSecurity,
      },
      null,
      2,
    )}\n`,
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    const code =
      error instanceof ConversionError ? error.code : "UNEXPECTED_ERROR";
    const message =
      error instanceof ConversionError
        ? error.message
        : "Unexpected converter failure";
    process.stderr.write(
      `Anna loyalty conversion failed [${code}]: ${message}\n`,
    );
    process.exitCode = 1;
  }
}

module.exports = {
  AGENCY_ENTRY,
  BROKER_ENTRY,
  CANONICAL_ZIP_SHA256,
  ConversionError,
  MAX_OUTPUT_BYTES,
  buildImportDocument,
  convertArchive,
  crc32,
  normalizePhone,
  parseExportedJsonArray,
  readSelectedZipEntries,
  writePrivateFile,
};
