import assert from 'node:assert/strict';
import test from 'node:test';
import { uniquenessHistoryLabel, uniquenessHistoryResult } from './uniqueness-history';

test('sales exception is shown as review, not as a resolved conflict', () => {
  const event = { action: 'UNIQUENESS_RESOLVED', payload: { trigger: 'SALES_REACHED_EXCEPTION_STAGE' } };
  assert.equal(uniquenessHistoryLabel(event), '🔎 Передано на проверку');
  assert.equal(uniquenessHistoryResult(event), 'На проверке');
});

test('deal stage and manual rejection are shown as rejected', () => {
  assert.equal(uniquenessHistoryLabel({ action: 'UNIQUENESS_RESOLVED', payload: { trigger: 'SALES_REACHED_DEAL_STAGE' } }), '⛔ Фиксация отклонена');
  assert.equal(uniquenessHistoryLabel({ action: 'UNIQUENESS_RESOLVED', payload: { status: 'REJECTED' } }), '⛔ Фиксация отклонена');
});

test('approval and unrelated actions keep accurate labels', () => {
  assert.equal(uniquenessHistoryLabel({ action: 'UNIQUENESS_RESOLVED', payload: { trigger: 'AMO_KC_APPROVED' } }), '✅ Уникальность подтверждена');
  assert.equal(uniquenessHistoryLabel({ action: 'CLIENT_FIXATION' }), '🆕 Создана фиксация');
});

// 2026-09-15: правило владельца от 11.09 — брокер уникален, пока прикреплён
// к незакрытой карточке колл-центра. Сервер пишет отдельную причину.
test('uniqueness granted while attached to an open call-centre lead', () => {
  const event = {
    action: 'UNIQUENESS_RESOLVED',
    payload: { trigger: 'RULE_2_KC_LIFTED_WHILE_ATTACHED' },
  };
  assert.equal(uniquenessHistoryLabel(event), '✅ Уникальность подтверждена');
  assert.equal(uniquenessHistoryResult(event), 'Уникален');
});
