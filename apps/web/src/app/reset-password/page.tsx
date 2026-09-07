'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token') || '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    const prev = document.body.style.cssText;
    document.body.style.background = '#ffffff';
    document.body.style.color = '#1a1a1a';
    return () => { document.body.style.cssText = prev; };
  }, []);

  const handleSubmit = async () => {
    if (password.length < 6) { setError('Пароль минимум 6 символов'); return; }
    if (password !== confirm) { setError('Пароли не совпадают'); return; }
    setLoading(true); setError('');
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();
      if (res.ok) {
        setSuccess(true);
        setTimeout(() => router.push('/'), 2500);
      } else {
        setError(data.message || 'Ошибка сброса пароля');
      }
    } catch { setError('Ошибка соединения'); }
    setLoading(false);
  };

  return (
    <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',padding:20,background:'#f8f7f5'}}>
      <div style={{background:'#fff',borderRadius:8,maxWidth:420,width:'100%',padding:'36px 32px',boxShadow:'0 4px 24px rgba(0,0,0,0.08)'}}>
        <h2 style={{fontSize:24,fontWeight:700,marginBottom:4,color:'#1a1a1a'}}>Новый пароль</h2>
        <p style={{fontSize:13,color:'#8a8680',marginBottom:24}}>Введите новый пароль для вашего аккаунта</p>

        {!token && (
          <div style={{padding:'10px 14px',background:'rgba(220,60,60,0.1)',color:'#c33',borderRadius:4,fontSize:13,marginBottom:16}}>
            Ссылка недействительна
          </div>
        )}

        {error && <div style={{padding:'10px 14px',background:'rgba(220,60,60,0.1)',color:'#c33',borderRadius:4,fontSize:13,marginBottom:16}}>{error}</div>}

        {success ? (
          <div style={{padding:'14px',background:'rgba(60,140,80,0.1)',color:'#3a8a5c',borderRadius:4,fontSize:13}}>
            Пароль изменён! Перенаправляем на вход...
          </div>
        ) : (
          <div style={{display:'flex',flexDirection:'column',gap:12}}>
            <input placeholder="Новый пароль" type="password" value={password} onChange={e=>setPassword(e.target.value)}
              style={{padding:'12px 16px',border:'1px solid rgba(0,0,0,0.12)',borderRadius:4,fontSize:14,outline:'none'}} />
            <input placeholder="Повторите пароль" type="password" value={confirm} onChange={e=>setConfirm(e.target.value)}
              onKeyDown={e=>e.key==='Enter' && handleSubmit()}
              style={{padding:'12px 16px',border:'1px solid rgba(0,0,0,0.12)',borderRadius:4,fontSize:14,outline:'none'}} />
            <button onClick={handleSubmit} disabled={loading || !token || !password || password !== confirm}
              style={{padding:'14px',background:'#1a1a1a',color:'#fff',border:'none',borderRadius:50,fontSize:13,fontWeight:700,letterSpacing:1,cursor:'pointer',opacity:loading?0.6:1}}>
              {loading ? 'Подождите...' : 'СОХРАНИТЬ'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<div style={{padding:40}}>Загрузка...</div>}>
      <ResetPasswordForm />
    </Suspense>
  );
}
