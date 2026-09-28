#!/usr/bin/env node
/**
 * 2026-09-28: одноразовый инспектор «касаний» контакта в amoCRM — для
 * проектирования ночного синка (звонки, выполненные задачи, ответственные,
 * лиды КЦ). Только чтение (GET). Не зависит от собранного адаптера —
 * ходит в amo напрямую, поэтому запускается на любом образе api.
 *
 * Вход (env):  PHONE=<телефон в любом формате>  или  CONTACT_ID=<id>
 * Запуск на проде: workflow inspect-amo-contact-touches.yml
 *   (docker compose exec -T -e PHONE=… api node /tmp/inspect-amo-contact-touches.js)
 *
 * PII: телефоны печатаются как +7912***74, ФИО — инициалами. Пользователи
 * amo (сотрудники) печатаются id+name — это не PII брокеров.
 */
const SUBDOMAIN = process.env.AMO_SUBDOMAIN || "stmichael";
const BASE = process.env.AMO_BASE_DOMAIN || "amocrm.ru";
const TOKEN = process.env.AMO_ACCESS_TOKEN;
const PHONE = String(process.env.PHONE || "").trim();
const CONTACT_ID = Number(process.env.CONTACT_ID || 0);
const KC_PIPELINE_ID = Number(process.env.AMO_KC_PIPELINE_ID || 7600542);

if (!TOKEN) {
  console.error("AMO_ACCESS_TOKEN не установлен");
  process.exit(2);
}
if (!PHONE && !CONTACT_ID) {
  console.error("Нужен PHONE или CONTACT_ID");
  process.exit(2);
}

const API = `https://${SUBDOMAIN}.${BASE}/api/v4`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CALL_STATUS_TEXT = {
  1: "оставил сообщение",
  2: "перезвонить позже",
  3: "нет на месте",
  4: "разговор состоялся",
  5: "неверный номер",
  6: "не дозвонился",
  7: "номер занят",
};
const TASK_TYPE_TEXT = { 1: "звонок", 2: "встреча" };

function maskPhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length < 6) return digits ? "***" : "";
  const d = digits.length === 11 && digits[0] === "8" ? "7" + digits.slice(1) : digits;
  return `+${d.slice(0, 4)}***${d.slice(-2)}`;
}

function maskName(raw) {
  const parts = String(raw || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return "(без имени)";
  return parts.map((p) => p[0].toUpperCase() + ".").join(" ");
}

function ts(unix) {
  const n = Number(unix);
  if (!Number.isFinite(n) || n <= 0) return "—";
  return new Date(n * 1000).toISOString().replace("T", " ").slice(0, 19);
}

async function get(path, attempt = 1) {
  const r = await fetch(`${API}${path}`, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/json",
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
  });
  if (r.status === 204) return null;
  if ((r.status === 429 || r.status >= 500) && attempt < 4) {
    await sleep(400 * attempt);
    return get(path, attempt + 1);
  }
  if (!r.ok) throw new Error(`amoCRM ${r.status} на ${path.split("?")[0]}`);
  return r.json();
}

async function getAllPages(pathWithQuery, embeddedKey, limit = 250, maxPages = 20) {
  const out = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const sep = pathWithQuery.includes("?") ? "&" : "?";
    const data = await get(`${pathWithQuery}${sep}limit=${limit}&page=${page}`);
    if (!data) break;
    const items = (data._embedded && data._embedded[embeddedKey]) || [];
    out.push(...items);
    const hasNext = data._links && data._links.next && data._links.next.href;
    if (!hasNext && items.length < limit) break;
    if (!items.length) break;
    await sleep(150);
  }
  return out;
}

function contactPhones(contact) {
  const out = [];
  for (const f of contact.custom_fields_values || []) {
    if (f.field_code !== "PHONE") continue;
    for (const v of f.values || []) if (v && v.value) out.push(String(v.value));
  }
  return out;
}

async function findContactByPhone(phone) {
  const target = phone.replace(/\D/g, "").slice(-10);
  if (target.length < 10) throw new Error("Телефон короче 10 цифр");
  const data = await get(`/contacts?query=${encodeURIComponent(target)}&with=leads&limit=50`);
  const list = (data && data._embedded && data._embedded.contacts) || [];
  const matched = list.filter((c) =>
    contactPhones(c).some((p) => p.replace(/\D/g, "").slice(-10) === target),
  );
  if (!matched.length) return null;
  if (matched.length > 1) {
    console.log(
      `  ⚠ по номеру ${maskPhone(phone)} найдено ${matched.length} контактов: ${matched
        .map((c) => c.id)
        .join(", ")} — берём первый`,
    );
  }
  return matched[0];
}

function printNotes(title, notes, users) {
  console.log(`\n── ${title}: ${notes.length} ──`);
  const sorted = [...notes].sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  for (const n of sorted.slice(0, 40)) {
    const p = n.params || {};
    const who = users.get(Number(p.call_responsible || n.responsible_user_id || n.created_by));
    const whoText = who ? `${who.id} ${who.name}` : String(p.call_responsible || n.created_by || "—");
    if (n.note_type === "call_in" || n.note_type === "call_out") {
      const dir = n.note_type === "call_in" ? "ВХОД" : "ИСХОД";
      const st =
        p.call_status !== undefined && p.call_status !== null
          ? `${p.call_status} (${CALL_STATUS_TEXT[p.call_status] || "?"})`
          : "—";
      console.log(
        `  note:${n.id} entity=${n.entity_id} ${ts(n.created_at)} ${dir} статус=${st} длит=${p.duration ?? "—"}с источник=${p.source || "—"} тел=${maskPhone(p.phone)} результат=${p.call_result ? JSON.stringify(String(p.call_result).slice(0, 60)) : "—"} кто=${whoText}`,
      );
    } else if (n.note_type === "service_message") {
      console.log(
        `  note:${n.id} entity=${n.entity_id} ${ts(n.created_at)} SERVICE service=${p.service || "—"} text=${JSON.stringify(String(p.text || "").slice(0, 60))} кто=${whoText}`,
      );
    } else {
      console.log(
        `  note:${n.id} entity=${n.entity_id} ${ts(n.created_at)} ${n.note_type} len=${String(p.text || "").length} кто=${whoText}`,
      );
    }
  }
  if (sorted.length > 40) console.log(`  … ещё ${sorted.length - 40}`);
  const byType = {};
  for (const n of notes) byType[n.note_type] = (byType[n.note_type] || 0) + 1;
  console.log(`  по типам: ${JSON.stringify(byType)}`);
}

function printTasks(title, tasks, users) {
  console.log(`\n── ${title}: ${tasks.length} ──`);
  const sorted = [...tasks].sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  for (const t of sorted.slice(0, 40)) {
    const who = users.get(Number(t.responsible_user_id));
    console.log(
      `  task:${t.id} ${t.entity_type}=${t.entity_id} тип=${t.task_type_id} (${TASK_TYPE_TEXT[t.task_type_id] || "другой"}) done=${t.is_completed ? "да" : "нет"} срок=${ts(t.complete_till)} обновл=${ts(t.updated_at)} отв=${who ? `${who.id} ${who.name}` : t.responsible_user_id} результат=${t.result && t.result.text ? JSON.stringify(String(t.result.text).slice(0, 60)) : "—"}`,
    );
  }
  if (sorted.length > 40) console.log(`  … ещё ${sorted.length - 40}`);
}

async function main() {
  console.log("=== Инспектор касаний amoCRM (только чтение) ===");

  const usersRaw = await getAllPages("/users", "users");
  const users = new Map();
  for (const u of usersRaw) {
    users.set(Number(u.id), {
      id: u.id,
      name: u.name,
      active: u.rights && typeof u.rights.is_active === "boolean" ? u.rights.is_active : u.is_active,
    });
  }
  console.log(`\n── Пользователи amo (сотрудники): ${users.size} ──`);
  for (const u of users.values()) {
    console.log(`  ${u.id}\t${u.active === false ? "[неактивен] " : ""}${u.name}`);
  }

  let contact;
  if (CONTACT_ID) {
    contact = await get(`/contacts/${CONTACT_ID}?with=leads`);
    if (!contact) throw new Error(`Контакт ${CONTACT_ID} не найден`);
  } else {
    contact = await findContactByPhone(PHONE);
    if (!contact) {
      console.log(`\nКонтакт по номеру ${maskPhone(PHONE)} не найден`);
      return;
    }
  }

  const leadRefs = (contact._embedded && contact._embedded.leads) || [];
  const leadIds = leadRefs.map((l) => Number(l.id)).filter((n) => Number.isSafeInteger(n) && n > 0);
  const resp = users.get(Number(contact.responsible_user_id));
  console.log(`\n── Контакт ${contact.id} ──`);
  console.log(`  имя: ${maskName(contact.name)}`);
  console.log(`  телефоны: ${contactPhones(contact).map(maskPhone).join(", ") || "—"}`);
  console.log(`  responsible_user_id: ${contact.responsible_user_id} ${resp ? `(${resp.name})` : ""}`);
  console.log(`  created_at: ${ts(contact.created_at)}  updated_at: ${ts(contact.updated_at)}`);
  console.log(`  closest_task_at: ${contact.closest_task_at ? ts(contact.closest_task_at) : "null"}`);
  console.log(`  теги: ${((contact._embedded && contact._embedded.tags) || []).map((t) => t.name).join(", ") || "—"}`);
  console.log(`  лиды (${leadIds.length}): ${leadIds.join(", ") || "—"}`);

  // Примечания контакта (все типы — чтобы увидеть, что вообще пишет телефония)
  const contactNotes = await getAllPages(
    `/contacts/notes?filter[entity_id][]=${contact.id}&order[updated_at]=desc`,
    "notes",
  );
  printNotes("Примечания контакта", contactNotes, users);

  // Примечания лидов (пачка ≤ 50)
  let leadNotes = [];
  for (let i = 0; i < leadIds.length; i += 50) {
    const chunk = leadIds.slice(i, i + 50);
    const q = chunk.map((id) => `filter[entity_id][]=${id}`).join("&");
    leadNotes = leadNotes.concat(await getAllPages(`/leads/notes?${q}&order[updated_at]=desc`, "notes"));
  }
  printNotes("Примечания лидов", leadNotes, users);

  // Задачи контакта и лидов
  const contactTasks = await getAllPages(
    `/tasks?filter[entity_type]=contacts&filter[entity_id][]=${contact.id}`,
    "tasks",
  );
  let leadTasks = [];
  for (let i = 0; i < leadIds.length; i += 50) {
    const chunk = leadIds.slice(i, i + 50);
    const q = chunk.map((id) => `filter[entity_id][]=${id}`).join("&");
    leadTasks = leadTasks.concat(await getAllPages(`/tasks?filter[entity_type]=leads&${q}`, "tasks"));
  }
  const allTasks = contactTasks.concat(leadTasks);
  printTasks("Задачи (контакт + лиды), выполненные", allTasks.filter((t) => t.is_completed), users);
  printTasks("Задачи (контакт + лиды), открытые", allTasks.filter((t) => !t.is_completed), users);

  // Лиды: воронка КЦ с ответственным
  let leads = [];
  for (let i = 0; i < leadIds.length; i += 250) {
    const chunk = leadIds.slice(i, i + 250);
    const q = chunk.map((id) => `filter[id][]=${id}`).join("&");
    const data = await get(`/leads?${q}&with=contacts&limit=250`);
    leads = leads.concat((data && data._embedded && data._embedded.leads) || []);
  }
  console.log(`\n── Лиды контакта: ${leads.length} (из них КЦ ${leads.filter((l) => l.pipeline_id === KC_PIPELINE_ID).length}) ──`);
  for (const l of [...leads].sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))) {
    const who = users.get(Number(l.responsible_user_id));
    const isKc = l.pipeline_id === KC_PIPELINE_ID;
    console.log(
      `  lead:${l.id} ${isKc ? "КЦ" : `pipeline=${l.pipeline_id}`} status=${l.status_id} отв=${who ? `${who.id} ${who.name}` : l.responsible_user_id} created=${ts(l.created_at)} updated=${ts(l.updated_at)} контакты=${((l._embedded && l._embedded.contacts) || []).map((c) => c.id).join(",")}`,
    );
  }
  const latestKc = leads
    .filter((l) => l.pipeline_id === KC_PIPELINE_ID)
    .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))[0];
  console.log(`\n  последний лид КЦ: ${latestKc ? `lead:${latestKc.id} отв=${latestKc.responsible_user_id}` : "—"}`);

  // Сводка «последнее касание»
  const calls = contactNotes.concat(leadNotes).filter((n) => n.note_type === "call_in" || n.note_type === "call_out");
  const lastCall = calls.sort((a, b) => (b.created_at || 0) - (a.created_at || 0))[0];
  const lastDone = allTasks.filter((t) => t.is_completed).sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))[0];
  console.log("\n── Сводка ──");
  console.log(`  последний звонок: ${lastCall ? `note:${lastCall.id} ${ts(lastCall.created_at)} ${lastCall.note_type} статус=${(lastCall.params || {}).call_status ?? "—"}` : "—"}`);
  console.log(`  последняя выполненная задача: ${lastDone ? `task:${lastDone.id} ${ts(lastDone.updated_at)} тип=${lastDone.task_type_id}` : "—"}`);
  console.log("=== Готово (только чтение) ===");
}

main().catch((e) => {
  console.error("Ошибка:", e && e.message ? e.message : e);
  process.exit(1);
});
