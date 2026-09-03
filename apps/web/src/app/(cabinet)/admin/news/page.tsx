'use client';

// 2026-05-26: админка для LandingNews (новости/публикации на лендинге).
// CRUD: список + редактор записи (заголовок, источник, дата, превью, ссылка,
// картинка, активность, sortOrder).

import { useEffect, useState } from 'react';
import { api, apiGet } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Newspaper, Plus, Trash2, Save, X, ExternalLink, RefreshCw } from 'lucide-react';

type NewsItem = {
  id: string;
  title: string;
  source: string | null;
  publishedAt: string;
  excerpt: string | null;
  imageUrl: string | null;
  url: string;
  sortOrder: number;
  isActive: boolean;
};

const empty: Partial<NewsItem> = {
  title: '',
  source: '',
  publishedAt: new Date().toISOString().slice(0, 10),
  excerpt: '',
  imageUrl: '',
  url: '',
  sortOrder: 0,
  isActive: true,
};

export default function AdminNewsPage() {
  const { broker } = useAuth();
  const [items, setItems] = useState<NewsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Partial<NewsItem> | null>(null);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState('');

  const syncFromStm = async () => {
    setSyncing(true);
    setMsg('');
    try {
      const res = await api('/admin/cms/news/sync-stm', { method: 'POST' });
      const data = res as any;
      setMsg(`Синхронизировано: добавлено ${data?.created ?? 0}, обновлено ${data?.updated ?? 0}`);
      load();
      setTimeout(() => setMsg(''), 4000);
    } catch (e: any) {
      setMsg(e.message || 'Ошибка синхронизации');
    } finally {
      setSyncing(false);
    }
  };

  if (broker && broker.role !== 'ADMIN' && broker.role !== 'MANAGER') {
    return <div className="card">Доступ запрещён</div>;
  }
  const canEdit = broker?.role === 'ADMIN';

  const load = () => {
    setLoading(true);
    apiGet<NewsItem[]>('/admin/cms/news')
      .then((d) => setItems(Array.isArray(d) ? d : []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    setMsg('');
    try {
      const payload = {
        title: editing.title,
        source: editing.source || null,
        publishedAt: new Date(editing.publishedAt + 'T00:00:00').toISOString(),
        excerpt: editing.excerpt || null,
        imageUrl: editing.imageUrl || null,
        url: editing.url,
        sortOrder: Number(editing.sortOrder) || 0,
        isActive: !!editing.isActive,
      };
      if (editing.id) {
        await api(`/admin/cms/news/${editing.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
        setMsg('Сохранено');
      } else {
        await api('/admin/cms/news', { method: 'POST', body: JSON.stringify(payload) });
        setMsg('Создано');
      }
      setEditing(null);
      load();
      setTimeout(() => setMsg(''), 2500);
    } catch (e: any) {
      setMsg(e.message || 'Ошибка');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm('Удалить новость?')) return;
    try {
      await api(`/admin/cms/news/${id}`, { method: 'DELETE' });
      load();
    } catch (e: any) {
      setMsg(e.message || 'Ошибка удаления');
    }
  };

  return (
    <div data-tour={'cms-news-page'}>
      <h1 className="text-2xl md:text-3xl font-bold mb-2 flex items-center gap-2">
        <Newspaper className="w-7 h-7 text-accent" /> Лендинг — Новости
      </h1>
      <p className="text-sm text-text-muted mb-4">
        Новости внизу лендинга. Синхронизируются с stmichael.ru/news (ежедневно в 08:00) или вручную кнопкой ниже.
      </p>

      {msg && <div className="mb-4 p-3 bg-info/20 text-info rounded text-sm">{msg}</div>}

      {canEdit && !editing && (
        <div className="flex gap-3 mb-4 flex-wrap">
          <button
            className="btn btn-primary inline-flex items-center gap-2"
            onClick={() => setEditing({ ...empty })}
          >
            <Plus className="w-4 h-4" /> Добавить новость
          </button>
          <button
            className="btn btn-secondary inline-flex items-center gap-2"
            onClick={syncFromStm}
            disabled={syncing}
          >
            <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Синхронизация...' : 'Синхронизировать с stmichael.ru'}
          </button>
        </div>
      )}

      {editing && (
        <div className="card mb-6">
          <div className="flex justify-between items-center mb-4">
            <h2 className="font-semibold">{editing.id ? 'Редактирование' : 'Новая новость'}</h2>
            <button className="text-text-muted hover:text-text" onClick={() => setEditing(null)}>
              <X className="w-5 h-5" />
            </button>
          </div>
          <div className="space-y-3">
            <div>
              <label className="label">Заголовок *</label>
              <input className="input" value={editing.title || ''} onChange={(e) => setEditing({ ...editing, title: e.target.value })} />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="label">Источник (РБК, Forbes …)</label>
                <input className="input" value={editing.source || ''} onChange={(e) => setEditing({ ...editing, source: e.target.value })} />
              </div>
              <div>
                <label className="label">Дата публикации</label>
                <input type="date" className="input" value={editing.publishedAt?.slice(0, 10) || ''} onChange={(e) => setEditing({ ...editing, publishedAt: e.target.value })} />
              </div>
            </div>
            <div>
              <label className="label">Короткий текст / превью</label>
              <textarea className="input" rows={2} value={editing.excerpt || ''} onChange={(e) => setEditing({ ...editing, excerpt: e.target.value })} />
            </div>
            <div>
              <label className="label">Ссылка на оригинал *</label>
              <input className="input" placeholder="https://..." value={editing.url || ''} onChange={(e) => setEditing({ ...editing, url: e.target.value })} />
            </div>
            <div>
              <label className="label">URL обложки (картинка)</label>
              <input className="input" placeholder="https://..." value={editing.imageUrl || ''} onChange={(e) => setEditing({ ...editing, imageUrl: e.target.value })} />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="label">Сортировка (меньше = выше)</label>
                <input type="number" className="input" value={editing.sortOrder ?? 0} onChange={(e) => setEditing({ ...editing, sortOrder: Number(e.target.value) })} />
              </div>
              <label className="flex items-center gap-2 mt-7">
                <input type="checkbox" checked={!!editing.isActive} onChange={(e) => setEditing({ ...editing, isActive: e.target.checked })} />
                Показывать на лендинге
              </label>
            </div>
            <div className="pt-3 border-t border-border">
              <button className="btn btn-primary inline-flex items-center gap-2" onClick={save} disabled={saving || !editing.title || !editing.url}>
                <Save className="w-4 h-4" /> {saving ? 'Сохранение…' : 'Сохранить'}
              </button>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="card text-text-muted">Загрузка…</div>
      ) : items.length === 0 ? (
        <div className="card text-text-muted">Новостей пока нет. Нажмите «Добавить новость».</div>
      ) : (
        <div className="space-y-2">
          {items.map((n) => (
            <div key={n.id} className="card flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="font-medium">{n.title}</div>
                <div className="text-xs text-text-muted mt-1">
                  {n.source && <span>{n.source} · </span>}
                  {new Date(n.publishedAt).toLocaleDateString('ru-RU')}
                  {!n.isActive && <span className="text-warning"> · скрыта</span>}
                </div>
                {n.excerpt && <div className="text-sm text-text-muted mt-1">{n.excerpt}</div>}
                <a href={n.url} target="_blank" rel="noreferrer" className="text-xs text-accent inline-flex items-center gap-1 mt-1">
                  <ExternalLink className="w-3 h-3" /> {n.url}
                </a>
              </div>
              {canEdit && (
                <div className="flex gap-1 flex-shrink-0">
                  <button className="btn btn-secondary text-xs px-2 py-1" onClick={() => setEditing({ ...n, publishedAt: n.publishedAt.slice(0, 10) })}>
                    Изменить
                  </button>
                  <button className="btn btn-secondary text-xs px-2 py-1 text-error" onClick={() => remove(n.id)}>
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
