import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ActiveCommissionPolicy, buildPaymentTermsText, getCommissionRateLabel, publishedInstallmentPayoutText, resolveCommissionText } from './commission-display';

const published: ActiveCommissionPolicy = {
  project:'ZORGE9', mode:'PROGRESSIVE', basis:'SALES_RUB_2026', flatRate:null,
  levels:[{ level:'RUB_0',minSalesRub:0,bonusRate:.2,rate:5.2 }, { level:'RUB_8',minSalesRub:650000000,bonusRate:1,rate:6 }],
  installmentEnabled:true, installmentDiscount:.5, subsidizedMortgageEnabled:true, subsidizedMortgageRate:4,
};
test('published commission range includes low down payment and does not show historical 8%', () => {
  assert.equal(getCommissionRateLabel(published), '4,2–6%');
  assert.equal(getCommissionRateLabel(published, { progressive:'max' }), 'до 6%');
  assert.equal(resolveCommissionText('Комиссия {{commission.ZORGE9.range}}', [published]), 'Комиссия 4,2–6%');
});
test('payment terms state both installment boundaries, not a single blanket 0.5% discount', () => {
  const text = buildPaymentTermsText(published);
  assert.match(text, /ПВ >50% — 4,5%/);
  assert.match(text, /ПВ ≤50% — 4%/);
  assert.match(text, /надбавка 0,2–1%/);
});
test('historical policies stay unchanged', () => {
  assert.equal(getCommissionRateLabel({project:'ZORGE9',mode:'FLAT',flatRate:7,levels:null}), '7%');
});
test('payout at exactly 30% is full, separate from rate threshold and actual receipt', () => {
  assert.match(publishedInstallmentPayoutText('ZORGE9'), /30% и более, включая ровно 30%/);
  assert.match(publishedInstallmentPayoutText('ZORGE9'), /полностью и единовременно/);
  assert.match(publishedInstallmentPayoutText('ZORGE9'), /Первый этап — 50% вознаграждения/);
  assert.match(publishedInstallmentPayoutText('SILVER_BOR'), /пропорционально фактической оплате/);
  assert.match(publishedInstallmentPayoutText('SILVER_BOR'), /не рассчитывает график/);
});
