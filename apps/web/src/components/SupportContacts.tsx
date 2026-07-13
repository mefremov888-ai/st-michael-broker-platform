// 2026-06-11: блок «Не получилось войти / зарегистрироваться» — телефон + email +
// Telegram поддержки. Брокер должен видеть куда писать ДО того как залогинится,
// иначе на проблеме «забыл email» и «забыл пароль» брокер просто уходит.
// Контакты совпадают с лендингом (apps/web/src/app/LandingClient.tsx). Если
// надо будет крутить из админки — вынести в SystemSetting.

export function SupportContacts({ title = 'Не получается войти?' }: { title?: string }) {
  return (
    <div className="mt-6 pt-4 border-t border-border text-sm text-text-muted">
      <div className="font-medium text-text mb-2">{title}</div>
      <div className="space-y-1">
        <div>
          Телефон:{' '}
          <a href="tel:+74992262249" className="text-accent hover:text-accent-hover">
            +7 (499) 226-22-49
          </a>
        </div>
        <div>
          Email:{' '}
          <a href="mailto:info@zorge9.com" className="text-accent hover:text-accent-hover">
            info@zorge9.com
          </a>
        </div>
        <div>
          Telegram:{' '}
          <a
            href="https://t.me/stmichaelBroker"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent hover:text-accent-hover"
          >
            @stmichaelBroker
          </a>
        </div>
      </div>
    </div>
  );
}
