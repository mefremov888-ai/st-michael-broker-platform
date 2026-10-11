import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  type ActiveCommissionPolicy,
  buildPaymentTermsText,
  findActiveCommissionPolicy,
  formatPercent,
  getCommissionMaxRate,
  getCommissionMinRate,
  getCommissionRateLabel,
  getOverallMaxCommissionRate,
  resolveCommissionText,
} from './commission-display';

const progressive: ActiveCommissionPolicy = {
  project: 'ZORGE9', mode: 'PROGRESSIVE', flatRate: null,
  levels: [{ rate: '5' }, { rate: '6,5' }, { rate: '8' }],
};
const flat: ActiveCommissionPolicy = {
  project: 'SILVER_BOR', mode: 'FLAT', flatRate: '4,25', levels: null,
};
const policies = [progressive, flat];

test('delegated analytics copy describes attribution without advertising obsolete sqm levels', () => {
  const source = readFileSync(new URL('../app/(cabinet)/analytics/page.tsx', import.meta.url), 'utf8');
  assert.match(source, /В аналитике заявка и связанная комиссия учитываются у создателя заявки\./);
  assert.doesNotMatch(source, /м² в уровень|За них комиссия и м²/);
  assert.match(source, /delegated > 0/);
});

test('formats Decimal strings safely without inventing missing or invalid rates', () => {
  assert.equal(formatPercent('5,25%'), '5,25%');
  assert.equal(formatPercent(5.126), '5,13%');
  for (const value of [null, undefined, '', -1, Infinity, 'bad']) {
    assert.equal(formatPercent(value), '—');
  }
  assert.equal(formatPercent(null, 'Нет данных'), 'Нет данных');
});

test('historical progressive and fixed labels retain their own rates and modes', () => {
  assert.equal(getCommissionMinRate(progressive), 5);
  assert.equal(getCommissionMaxRate(progressive), 8);
  assert.equal(getCommissionRateLabel(progressive), '5–8%');
  assert.equal(getCommissionRateLabel(progressive, { maxOnly: true }), 'до 8%');
  assert.equal(getCommissionRateLabel(flat, { maxOnly: true }), '4,25%');
  assert.equal(getOverallMaxCommissionRate(policies), 8);
  assert.equal(findActiveCommissionPolicy(policies, 'SILVER_BOR'), flat);
  assert.equal(getCommissionRateLabel(null), '—');
  assert.equal(getOverallMaxCommissionRate([]), null);
  assert.equal(getCommissionRateLabel({ ...progressive, levels: [] }), '—');
});

test('only configured payment modifiers are rendered; disabled stale values stay hidden', () => {
  assert.equal(buildPaymentTermsText(null), '');
  assert.equal(buildPaymentTermsText({}), '');
  assert.equal(buildPaymentTermsText({
    installmentEnabled: false, installmentDiscount: 1,
    subsidizedMortgageEnabled: false, subsidizedMortgageRate: 4,
  }), '');
  assert.match(buildPaymentTermsText({ installmentDiscount: '0,5' }), /0,5 п\. п\./);
  assert.match(buildPaymentTermsText({ installmentEnabled: true, installmentDiscount: 0 }), /без уменьшения/);
  assert.match(buildPaymentTermsText({ subsidizedMortgageEnabled: true, subsidizedMortgageRate: 4 }), /фиксированная ставка 4%/);
});

test('explicit project tokens resolve independently and unknown tokens remain visible', () => {
  assert.equal(resolveCommissionText(
    '{{commission.ZORGE9.min}} / {{commission.ZORGE9.range}} / {{commission.SILVER_BOR.max}} / {{commission.overall.max}}',
    policies,
  ), '5% / 5–8% / 4,25% / 8%');
  const missing = '{{commission.SILVER_BOR.range}}';
  assert.equal(resolveCommissionText(missing, [progressive]), missing);
});

test('legacy commission copy respects selected project and leaves unrelated percentages intact', () => {
  assert.equal(resolveCommissionText('Комиссия до 10%, ПВ от 30%', policies, 'SILVER_BOR'), 'Комиссия 4,25%, ПВ от 30%');
  assert.equal(resolveCommissionText('Зорге 9: 3%; КСБ: до 9%', policies), 'Зорге 9: до 8%; КСБ: 4,25%');
  for (const text of ['Скидка 1%', 'Первоначальный взнос 30%', 'Ипотечная ставка 6%', 'Доходность 20%', 'Рассрочка: ставка 2%']) {
    assert.equal(resolveCommissionText(text, policies, { commissionContext: true }), text);
  }
  assert.equal(resolveCommissionText('Комиссия до 8%', []), 'Комиссия до 8%');
});
