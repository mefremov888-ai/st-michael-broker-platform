import { BadRequestException } from '@nestjs/common';

export const MANGO_EMPLOYEE_NUM_MAX_LENGTH = 20;

/**
 * EmployeeNUM is an identifier, not a number: keep it as a string so leading
 * zeroes are never lost. Empty string/null explicitly clears the mapping.
 */
export function normalizeMangoEmployeeNum(value: unknown): string | null {
  if (value === null || value === '') return null;
  if (value === undefined) {
    throw new BadRequestException('mangoEmployeeNum обязателен; передайте строку или null для очистки');
  }
  if (typeof value !== 'string') {
    throw new BadRequestException('Внутренний номер Mango должен быть строкой из цифр');
  }

  const normalized = value.trim();
  if (!normalized) return null;
  if (!/^\d+$/.test(normalized)) {
    throw new BadRequestException('Внутренний номер Mango может содержать только цифры');
  }
  if (normalized.length > MANGO_EMPLOYEE_NUM_MAX_LENGTH) {
    throw new BadRequestException(
      `Внутренний номер Mango не должен быть длиннее ${MANGO_EMPLOYEE_NUM_MAX_LENGTH} цифр`,
    );
  }
  return normalized;
}
