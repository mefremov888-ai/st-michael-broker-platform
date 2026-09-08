import { NextResponse } from "next/server";

// 2026-09-08: переход в amoCRM по ссылке из Excel/Word.
// Excel перед открытием гиперссылки сам делает запрос к адресу, а amoCRM
// отвечает офисному клиенту без авторизации ошибкой — Excel показывает
// «Не удается открыть… Не удается скачать нужные данные» и ссылку не
// открывает. Этот адрес всегда отвечает 200 и сразу перебрасывает браузер
// на нужную карточку amoCRM (лид / контакт / компания). Ничего не читает
// и не пишет — только редирект.
export const dynamic = "force-dynamic";

const AMO_BASE = "https://stmichael.amocrm.ru";

const PATHS: Record<string, string> = {
  lead: "/leads/detail/",
  leads: "/leads/detail/",
  contact: "/contacts/detail/",
  contacts: "/contacts/detail/",
  company: "/companies/detail/",
  companies: "/companies/detail/",
};

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ kind: string; id: string }> },
) {
  const { kind, id } = await context.params;
  const path = PATHS[String(kind || "").toLowerCase()];
  const numericId = String(id || "").replace(/\D/g, "");
  if (!path || !numericId) {
    return new NextResponse("Неверная ссылка на amoCRM", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  const target = `${AMO_BASE}${path}${numericId}`;
  const safeTarget = escapeHtml(target);
  const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0; url=${safeTarget}">
<title>Переход в amoCRM…</title>
<style>body{font-family:system-ui,sans-serif;padding:32px;color:#222}a{color:#0563c1}</style>
</head>
<body>
<p>Открываем карточку в amoCRM… Если страница не открылась сама,
<a href="${safeTarget}">нажмите сюда</a>.</p>
<script>window.location.replace(${JSON.stringify(target)});</script>
</body>
</html>`;
  return new NextResponse(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=3600",
      "x-robots-tag": "noindex",
    },
  });
}

// Excel проверяет ссылку запросом HEAD — отвечаем 200 без тела.
export async function HEAD() {
  return new NextResponse(null, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
