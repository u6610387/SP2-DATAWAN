'use client';
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useLanguage } from '@/lib/i18n/context';
import { getSupabaseClient } from '@/lib/supabase';

export default function LoginPage() {
  const router = useRouter();
  const { t } = useLanguage();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error: err } = await getSupabaseClient().auth.signInWithPassword({ email, password });
    setLoading(false);
    if (err) {
      setError(t.login.error);
      return;
    }
    router.replace('/dashboard');
  }

  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <Card className="w-full max-w-sm">
        <h1 className="mb-4 text-center text-lg font-semibold">{t.login.title}</h1>
        <form onSubmit={onSubmit} className="space-y-3">
          <Input type="email" placeholder={t.login.email} required value={email} onChange={(e) => setEmail(e.target.value)} />
          <Input type="password" placeholder={t.login.password} required value={password} onChange={(e) => setPassword(e.target.value)} />
          {error && <p className="text-sm text-[var(--red)]">{error}</p>}
          <Button type="submit" size="lg" disabled={loading}>
            {loading ? t.login.submitting : t.login.submit}
          </Button>
        </form>
      </Card>
    </div>
  );
}
