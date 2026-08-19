import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_DEDUP_COOLDOWN_MS = 5 * 60_000;

export interface OpsAlertOptions {
  /** Repeated alerts with the same key are suppressed during the cooldown. */
  dedupKey?: string;
  /** Set to 0 to disable cooldown for this call. */
  cooldownMs?: number;
}

interface TelegramResponse {
  ok?: boolean;
}

@Injectable()
export class OpsAlertService {
  private readonly logger = new Logger(OpsAlertService.name);
  private readonly dedupExpirations = new Map<string, number>();

  constructor(private readonly config: ConfigService) {}

  /**
   * Sends a plain-text operations alert to every configured chat.
   * Returns false when delivery is skipped because configuration is missing or
   * an equivalent alert is still in its cooldown window.
   */
  async send(message: string, options: OpsAlertOptions = {}): Promise<boolean> {
    const token = this.getBotToken();
    const chatIds = this.getChatIds();

    if (!token || chatIds.length === 0) {
      this.logger.warn(
        '[OpsAlert] Telegram is not configured; set OPS_TELEGRAM_BOT_TOKEN (or TELEGRAM_BOT_TOKEN) and OPS_ALERT_CHAT_ID(S)',
      );
      return false;
    }

    const text = String(message ?? '').trim();
    if (!text) {
      this.logger.warn('[OpsAlert] Empty alert was not sent');
      return false;
    }

    const dedupKey = options.dedupKey?.trim();
    const cooldownMs = this.resolveCooldownMs(options.cooldownMs);
    const now = Date.now();
    let reservedUntil: number | undefined;

    if (dedupKey && cooldownMs > 0) {
      const currentExpiration = this.dedupExpirations.get(dedupKey);
      if (currentExpiration && currentExpiration > now) return false;

      reservedUntil = now + cooldownMs;
      this.dedupExpirations.set(dedupKey, reservedUntil);
      this.removeExpiredDedupEntries(now);
    }

    const results = await Promise.allSettled(chatIds.map((chatId) => this.sendToChat(token, chatId, text)));
    const failedCount = results.filter((result) => result.status === 'rejected').length;

    if (failedCount > 0) {
      const successCount = results.length - failedCount;

      // Release the reservation only when nobody received the alert. If even
      // one chat succeeded, retrying the same fan-out would spam that chat
      // while a permanently invalid chat keeps failing.
      if (
        successCount === 0 &&
        dedupKey &&
        reservedUntil !== undefined &&
        this.dedupExpirations.get(dedupKey) === reservedUntil
      ) {
        this.dedupExpirations.delete(dedupKey);
      }

      throw new Error(`Telegram delivery failed for ${failedCount} of ${chatIds.length} configured ops chats`);
    }

    return true;
  }

  async sendAlert(message: string, options: OpsAlertOptions = {}): Promise<boolean> {
    return this.send(message, options);
  }

  /** Best-effort variant for error paths where alerting must not mask the original failure. */
  async sendSafely(message: string, options: OpsAlertOptions = {}): Promise<boolean> {
    try {
      return await this.send(message, options);
    } catch (error) {
      this.logger.error(`[OpsAlert] Failed to deliver alert: ${this.safeErrorMessage(error)}`);
      return false;
    }
  }

  private async sendToChat(token: string, chatId: string, text: string): Promise<void> {
    const controller = new AbortController();
    const timeoutMs = this.resolveTimeoutMs();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      let response: Response;
      try {
        response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text }),
          signal: controller.signal,
        });
      } catch {
        if (controller.signal.aborted) {
          throw new Error(`Telegram request timed out after ${timeoutMs} ms`);
        }
        throw new Error('Telegram network request failed');
      }

      let payload: TelegramResponse | undefined;
      try {
        payload = (await response.json()) as TelegramResponse;
      } catch {
        // The status check below remains useful even when Telegram returned a
        // proxy/body that was not valid JSON.
      }

      if (!response.ok) {
        throw new Error(`Telegram request failed with HTTP ${response.status}`);
      }
      if (!payload || payload.ok !== true) {
        throw new Error('Telegram API rejected the request');
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private getBotToken(): string | undefined {
    return (
      this.config.get<string>('OPS_TELEGRAM_BOT_TOKEN')?.trim() ||
      this.config.get<string>('TELEGRAM_BOT_TOKEN')?.trim() ||
      undefined
    );
  }

  private getChatIds(): string[] {
    const configured = [this.config.get<string>('OPS_ALERT_CHAT_IDS'), this.config.get<string>('OPS_ALERT_CHAT_ID')];

    return [
      ...new Set(
        configured
          .flatMap((value) => String(value || '').split(/[\s,;]+/))
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ];
  }

  private resolveTimeoutMs(): number {
    return this.positiveNumber(this.config.get<string>('OPS_TELEGRAM_TIMEOUT_MS'), DEFAULT_TIMEOUT_MS);
  }

  private resolveCooldownMs(override?: number): number {
    if (override !== undefined) {
      return Number.isFinite(override) && override > 0 ? override : 0;
    }

    const configured =
      this.config.get<string>('OPS_ALERT_DEDUP_COOLDOWN_MS') || this.config.get<string>('OPS_ALERT_COOLDOWN_MS');
    return this.positiveNumber(configured, DEFAULT_DEDUP_COOLDOWN_MS);
  }

  private positiveNumber(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  private removeExpiredDedupEntries(now: number): void {
    if (this.dedupExpirations.size < 1_000) return;
    for (const [key, expiresAt] of this.dedupExpirations) {
      if (expiresAt <= now) this.dedupExpirations.delete(key);
    }
  }

  private safeErrorMessage(error: unknown): string {
    let message = error instanceof Error ? error.message : String(error);
    for (const secret of [
      this.config.get<string>('OPS_TELEGRAM_BOT_TOKEN'),
      this.config.get<string>('TELEGRAM_BOT_TOKEN'),
    ]) {
      if (secret) message = message.split(secret).join('[redacted]');
    }
    return message;
  }
}
