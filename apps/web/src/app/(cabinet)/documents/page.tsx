'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { apiGet } from '@/lib/api';
import { FileText, Download, FileSignature, ChevronRight, CheckCircle2 } from 'lucide-react';

interface DocItem {
  id: string;
  name: string;
  description: string | null;
  type: string;
  fileUrl: string;
  fileSize: number | null;
  isPublic: boolean;
}

interface OfferStatus {
  accepted: boolean;
  acceptance: { acceptedAt: string } | null;
  offer: { title: string; version: string };
}

function formatSize(bytes: number | null): string {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function DocumentsPage() {
  const [documents, setDocuments] = useState<DocItem[]>([]);
  const [offerStatus, setOfferStatus] = useState<OfferStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true); setError('');
    try {
      const [docs, offer] = await Promise.all([
        apiGet('/documents?category=cooperation&limit=200'),
        apiGet<OfferStatus>('/offer/my').catch(() => null),
      ]);
      setDocuments(docs.documents || []);
      setOfferStatus(offer);
    } catch (e: any) {
      setError(e.message || 'Ошибка загрузки');
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl md:text-3xl font-bold">Документы</h1>
        <p className="text-text-muted text-sm mt-1">Договор-оферта, регламенты и условия сотрудничества</p>
      </div>

      {/* Offer status banner */}
      {offerStatus && (
        <Link href="/documents/offer" className="block mb-6 group">
          <div className={`card hover:border-accent transition flex items-center gap-4 ${offerStatus.accepted ? '' : 'border-warning/40 bg-warning/5'}`}>
            <div className={`w-12 h-12 rounded-lg flex items-center justify-center flex-shrink-0 ${offerStatus.accepted ? 'bg-success/20 text-success' : 'bg-warning/20 text-warning'}`}>
              {offerStatus.accepted ? <CheckCircle2 className="w-6 h-6" /> : <FileSignature className="w-6 h-6" />}
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-semibold">{offerStatus.offer.title}</div>
              <div className="text-sm text-text-muted">
                {offerStatus.accepted && offerStatus.acceptance
                  ? `✓ Подписан ${new Date(offerStatus.acceptance.acceptedAt).toLocaleDateString('ru-RU')} · версия ${offerStatus.offer.version}`
                  : `Не подписан · требуется акцепт публичной оферты`}
              </div>
            </div>
            <ChevronRight className="w-5 h-5 text-text-muted group-hover:text-accent transition" />
          </div>
        </Link>
      )}

      {error && <div className="mb-4 p-4 rounded-lg bg-error/20 text-error text-sm">{error}</div>}

      <div className="card" data-tour="documents-list">
        {loading ? (
          <div className="text-center py-8 text-text-muted">Загрузка...</div>
        ) : documents.length === 0 ? (
          <div className="text-center py-8 text-text-muted">
            <FileText className="w-12 h-12 mx-auto mb-3 text-text-muted/50" />
            Документы пока не добавлены
          </div>
        ) : (
          <div className="space-y-3">
            {documents.map((doc) => (
              <div
                key={doc.id}
                className="flex items-center justify-between py-3 border-b border-border last:border-0 hover:bg-surface-secondary rounded-lg px-3 -mx-3 transition"
              >
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <div className="w-10 h-10 bg-accent/10 rounded-lg flex items-center justify-center flex-shrink-0">
                    <FileText className="w-5 h-5 text-accent" />
                  </div>
                  <div className="min-w-0">
                    <div className="font-medium text-sm truncate">{doc.name}</div>
                    <div className="text-xs text-text-muted">
                      {doc.type}{doc.fileSize ? ` · ${formatSize(doc.fileSize)}` : ''}
                      {/* Bug fix 2026-06-02: [seed:...] маркер — техника
                          для идемпотентности seed-скрипта, не для UI. */}
                      {doc.description && !/^\[seed:/i.test(doc.description) ? ` · ${doc.description}` : ''}
                    </div>
                  </div>
                </div>
                <a
                  href={doc.fileUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-secondary flex items-center gap-2 ml-3"
                >
                  <Download className="w-4 h-4" />
                  Открыть
                </a>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
