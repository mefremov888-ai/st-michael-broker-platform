'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { apiGet, apiPost } from '@/lib/api';
import { ArrowLeft, FileSignature, Download, CheckCircle2 } from 'lucide-react';

interface Offer {
  version: string;
  title: string;
  body: string;
  updatedAt: string;
}

interface MyAcceptance {
  offer: Offer;
  accepted: boolean;
  acceptance: { id: string; offerVersion: string; acceptedAt: string; signedPdfUrl?: string | null } | null;
}

export default function OfferPage() {
  const [data, setData] = useState<MyAcceptance | null>(null);
  const [loading, setLoading] = useState(true);
  const [agreeChecked, setAgreeChecked] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [err, setErr] = useState('');

  const load = () => {
    setLoading(true);
    apiGet<MyAcceptance>('/offer/my')
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const accept = async () => {
    setErr(''); setAccepting(true);
    try {
      await apiPost('/offer/accept', {});
      load();
    } catch (e: any) { setErr(e.message || 'Ошибка'); }
    setAccepting(false);
  };

  const downloadSigned = () => {
    // Open in new tab — endpoint returns HTML the browser can print as PDF
    window.open('/api/offer/my/document', '_blank');
  };

  if (loading) return <div className="text-text-muted">Загрузка…</div>;
  if (!data) return <div className="text-error">Не удалось загрузить оферту</div>;

  const { offer, accepted, acceptance } = data;

  // Render plain-text body with paragraph breaks
  const paragraphs = offer.body.split(/\n\n+/);

  return (
    <div className="max-w-4xl">
      <Link href="/documents" className="inline-flex items-center gap-2 text-text-muted hover:text-text mb-4 text-sm">
        <ArrowLeft className="w-4 h-4" /> Документы
      </Link>

      <div className="card mb-6">
        <div className="flex items-start justify-between mb-2 gap-4">
          <div className="flex items-start gap-3">
            <FileSignature className="w-6 h-6 text-accent flex-shrink-0 mt-1" />
            <div>
              <h1 className="text-2xl font-bold">{offer.title}</h1>
              <p className="text-text-muted text-sm">Версия {offer.version}</p>
            </div>
          </div>
        </div>

        {accepted && acceptance && (
          <div className="bg-success/10 border border-success/30 rounded-lg p-4 mt-4 flex items-center gap-3">
            <CheckCircle2 className="w-5 h-5 text-success flex-shrink-0" />
            <div className="flex-1">
              <div className="font-medium text-success">Договор принят</div>
              <div className="text-xs text-text-muted">
                {new Date(acceptance.acceptedAt).toLocaleString('ru-RU')} · ID акцепта: {acceptance.id}
              </div>
            </div>
            <button className="btn btn-secondary flex items-center gap-2" onClick={downloadSigned}>
              <Download className="w-4 h-4" /> Скачать
            </button>
          </div>
        )}
      </div>

      <div className="card mb-6">
        <div className="prose max-w-none text-sm leading-relaxed">
          {paragraphs.map((p, i) => (
            <p key={i} className="whitespace-pre-line mb-3">{p}</p>
          ))}
        </div>
      </div>

      {!accepted && (
        <div className="card">
          {err && <div className="mb-3 p-3 bg-error/20 text-error rounded text-sm">{err}</div>}

          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              className="mt-1"
              checked={agreeChecked}
              onChange={(e) => setAgreeChecked(e.target.checked)}
            />
            <span className="text-sm">
              Я ознакомлен(а) с условиями договора-оферты и принимаю их в полном объёме.
              Согласен(на), что нажатие кнопки «Принять условия» является акцептом публичной оферты в соответствии со ст. 438 ГК РФ.
            </span>
          </label>

          <div className="mt-4">
            <button
              className="btn btn-primary"
              disabled={!agreeChecked || accepting}
              onClick={accept}
            >
              {accepting ? 'Подписание...' : 'Принять условия'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
