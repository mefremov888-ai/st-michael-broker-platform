import { Logger } from '@nestjs/common';
import { telegramApiBase } from './telegram-api-base';

/**
 * 2026-09-30: общий вызов метода Telegram Bot API (sendMessage, sendPhoto,
 * editMessageText, answerCallbackQuery, …) для сервисов api.
 *
 * Тот же приём, что в OpsInboxService.reply: сначала fetch на TELEGRAM_API_BASE
 * (ретранслятор tg-relay), при сетевой ошибке — запасной путь через node:https
 * напрямую на api.telegram.org по IPv4. Ошибка API (ok=false) не бросается,
 * а возвращается — вызывающий решает, критична ли она.
 */

export type TelegramCallResult = { ok: boolean; status: number; payload: any };

const CALL_TIMEOUT_MS = 15_000;

export async function callTelegramApi(
  token: string,
  method: string,
  body: Record<string, unknown>,
  logger?: Logger,
): Promise<TelegramCallResult> {
  const json = JSON.stringify(body);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const response = await fetch(`${telegramApiBase()}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: json,
      signal: controller.signal,
    });
    const payload: any = await response.json().catch(() => null);
    return { ok: Boolean(response.ok && payload?.ok), status: response.status, payload };
  } catch (error) {
    const cause = (error as any)?.cause;
    logger?.warn(`[Telegram] ${method} fetch failed: ${(error as Error)?.message}; cause=${cause?.code || ''} ${cause?.message || ''}`);
    try {
      const fallback = await postViaHttps(`/bot${token}/${method}`, json);
      return { ok: Boolean(fallback.status >= 200 && fallback.status < 300 && fallback.payload?.ok), status: fallback.status, payload: fallback.payload };
    } catch (fallbackError) {
      logger?.warn(`[Telegram] ${method} https fallback failed: ${(fallbackError as Error)?.message}`);
      return { ok: false, status: 0, payload: { ok: false, description: (fallbackError as Error)?.message } };
    }
  } finally {
    clearTimeout(timer);
  }
}

function postViaHttps(path: string, body: string): Promise<{ status: number; payload: any }> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const https = require('node:https');
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: 'api.telegram.org',
        family: 4,
        method: 'POST',
        path,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        timeout: CALL_TIMEOUT_MS,
      },
      (res: any) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let payload: any = null;
          try {
            payload = JSON.parse(raw);
          } catch {
            payload = { raw: raw.slice(0, 200) };
          }
          resolve({ status: Number(res.statusCode || 0), payload });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (error: Error) => reject(error));
    req.write(body);
    req.end();
  });
}
