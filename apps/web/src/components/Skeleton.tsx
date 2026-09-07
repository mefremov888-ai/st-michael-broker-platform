'use client';

export function Skeleton({ className = '', height = 16 }: { className?: string; height?: number }) {
  return (
    <div
      className={`bg-surface-secondary rounded animate-pulse ${className}`}
      style={{ height }}
    />
  );
}

export function SkeletonCard({ rows = 3 }: { rows?: number }) {
  return (
    <div className="card space-y-3">
      <Skeleton height={20} className="w-1/3" />
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} height={14} className={i === rows - 1 ? 'w-2/3' : 'w-full'} />
      ))}
    </div>
  );
}

export function SkeletonRow() {
  return (
    <div className="flex items-center gap-3 py-3 border-b border-border last:border-0">
      <Skeleton height={40} className="w-10 rounded-lg" />
      <div className="flex-1 space-y-2">
        <Skeleton height={14} className="w-1/2" />
        <Skeleton height={12} className="w-1/3" />
      </div>
      <Skeleton height={24} className="w-20" />
    </div>
  );
}

export function SkeletonTable({ rows = 5 }: { rows?: number }) {
  return (
    <div>
      {Array.from({ length: rows }).map((_, i) => <SkeletonRow key={i} />)}
    </div>
  );
}
