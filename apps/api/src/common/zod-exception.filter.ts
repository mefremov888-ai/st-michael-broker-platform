import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';
import { ZodError } from 'zod';

/**
 * 2026-06-03: глобальный фильтр для ZodError.
 *
 * Контекст: в контроллерах используется `schema.parse(body)` — он бросает
 * ZodError. NestJS по умолчанию конвертирует unknown exception в 500
 * Internal Server Error, и пользователь в UI видит «Internal server error»
 * вместо конкретной причины («Невалидный email», «Слишком короткое имя» и т.д.).
 *
 * Этот фильтр перехватывает ZodError и возвращает 400 Bad Request с
 * человекочитаемым сообщением (первая ошибка из массива issues).
 */
@Catch(ZodError)
export class ZodExceptionFilter implements ExceptionFilter {
  catch(exception: ZodError, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();

    const issues = exception.issues || [];
    const firstIssue = issues[0];
    const fieldPath = firstIssue?.path?.join('.') || '';
    const message = firstIssue
      ? `${fieldPath ? `Поле «${fieldPath}»: ` : ''}${humanizeMessage(firstIssue.message, fieldPath)}`
      : 'Невалидные данные';

    response.status(HttpStatus.BAD_REQUEST).json({
      statusCode: HttpStatus.BAD_REQUEST,
      message,
      errors: issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
  }
}

// Подменяем технические сообщения Zod на понятные русские.
function humanizeMessage(msg: string, field: string): string {
  const lower = msg.toLowerCase();
  if (lower.includes('invalid email')) return 'неверный формат email (нужно name@domain.tld)';
  if (lower.includes('invalid phone')) return 'неверный формат телефона (нужно +7XXXXXXXXXX)';
  if (lower.includes('inn')) return 'ИНН должен быть 10 цифр (юрлицо) или 12 цифр (физлицо/ИП)';
  if (lower.includes('required')) return 'обязательное поле';
  if (lower.includes('too small') && field.toLowerCase().includes('name')) return 'слишком короткое имя';
  return msg; // fallback на оригинал
}
