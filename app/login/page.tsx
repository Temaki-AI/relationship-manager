'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Heart, LockKeyhole, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cloudAuthClient } from '@/lib/cloud/auth-client';

const googleAuthEnabled = process.env.NEXT_PUBLIC_AUTH_MODE === 'google';

function getSafeReturnPath(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    return '/';
  }
  return value;
}

export default function LoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [returnPath, setReturnPath] = useState('/');
  const [checkingSession, setCheckingSession] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryAfterSeconds, setRetryAfterSeconds] = useState(0);

  useEffect(() => {
    const nextPath = getSafeReturnPath(new URLSearchParams(window.location.search).get('next'));
    setReturnPath(nextPath);

    if (googleAuthEnabled) {
      cloudAuthClient.getSession()
        .then(({ data }) => {
          if (data?.session) {
            router.replace(nextPath);
            router.refresh();
          }
        })
        .catch(() => setError('Everclose CRM could not check the current session. Please try again.'))
        .finally(() => setCheckingSession(false));
      return;
    }

    fetch('/api/auth/session', { cache: 'no-store' })
      .then(async (response) => ({ response, data: await response.json() }))
      .then(({ response, data }) => {
        if (response.ok && (data.authenticated || data.mode === 'disabled')) {
          router.replace(nextPath);
          router.refresh();
          return;
        }
        if (data.mode === 'misconfigured') {
          setError('Authentication needs to be configured on the server before Everclose CRM can open.');
        }
      })
      .catch(() => setError('Everclose CRM could not check the current session. Please try again.'))
      .finally(() => setCheckingSession(false));
  }, [router]);

  async function handleGoogleSignIn() {
    setSubmitting(true);
    setError(null);
    const { error: signInError } = await cloudAuthClient.signIn.social({
      provider: 'google',
      callbackURL: returnPath,
    });
    if (signInError) {
      setError(signInError.message || 'Unable to start Google sign-in.');
      setSubmitting(false);
    }
  }

  useEffect(() => {
    if (retryAfterSeconds <= 0) return;
    const timer = window.setInterval(() => {
      setRetryAfterSeconds((seconds) => Math.max(0, seconds - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [retryAfterSeconds]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await response.json();

      if (!response.ok) {
        if (response.status === 429) {
          const retryAfter = Number(data.retryAfterSeconds || response.headers.get('Retry-After'));
          setRetryAfterSeconds(Number.isFinite(retryAfter) ? Math.max(1, Math.ceil(retryAfter)) : 60);
        }
        setPassword('');
        setError(data.error || 'Unable to sign in.');
        return;
      }

      router.replace(returnPath);
      router.refresh();
    } catch {
      setError('Unable to reach Everclose CRM. Check the connection and try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-[calc(100vh-3rem)] flex items-center justify-center py-8">
      <div className="w-full max-w-md animate-fade-in-up">
        <div className="relative mb-6 overflow-hidden rounded-3xl bg-gradient-to-br from-rose-500 via-red-400 to-amber-400 px-6 py-8 text-white shadow-xl shadow-rose-200/60">
          <div className="absolute -right-12 -top-14 h-36 w-36 rounded-full border border-white/20 bg-white/10" />
          <div className="absolute -bottom-16 -left-10 h-32 w-32 rounded-full bg-amber-200/20 blur-sm" />
          <div className="relative">
            <div className="mb-6 flex h-11 w-11 items-center justify-center rounded-2xl bg-white/20 backdrop-blur-sm">
              <Heart className="h-5 w-5 fill-white" />
            </div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/75">Private by design</p>
            <h1 className="mt-2 text-3xl font-bold tracking-tight">Welcome back to Everclose CRM</h1>
            <p className="mt-2 max-w-sm text-sm leading-relaxed text-white/85">
              Your relationship intelligence stays behind one secure door.
            </p>
          </div>
        </div>

        <Card className="border-0 shadow-lg shadow-stone-200/50">
          <CardContent className="pt-6">
            {checkingSession ? (
              <div className="flex items-center justify-center gap-3 py-10 text-sm text-muted-foreground">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                Checking your session...
              </div>
            ) : (
              googleAuthEnabled ? (
                <div className="space-y-5">
                  <div className="flex items-start gap-3 rounded-2xl bg-emerald-50 px-4 py-3 text-emerald-800">
                    <ShieldCheck className="mt-0.5 h-4 w-4 flex-shrink-0" />
                    <p className="text-xs leading-relaxed">
                      Each Google account gets a private workspace with isolated contacts and reminders.
                    </p>
                  </div>
                  {error && (
                    <p role="alert" aria-live="polite" className="rounded-xl bg-red-50 px-3 py-2.5 text-sm text-red-700">
                      {error}
                    </p>
                  )}
                  <Button
                    type="button"
                    className="h-11 w-full"
                    disabled={submitting}
                    onClick={handleGoogleSignIn}
                  >
                    {submitting ? 'Opening Google...' : 'Continue with Google'}
                  </Button>
                </div>
              ) : (
              <form onSubmit={handleSubmit} className="space-y-5">
                <div className="flex items-start gap-3 rounded-2xl bg-emerald-50 px-4 py-3 text-emerald-800">
                  <ShieldCheck className="mt-0.5 h-4 w-4 flex-shrink-0" />
                  <p className="text-xs leading-relaxed">
          Sessions are signed, HTTP-only, and automatically expire under your deployment policy.
                  </p>
                </div>

                <div>
                  <Label htmlFor="password">Account password</Label>
                  <div className="relative mt-1.5">
                    <LockKeyhole className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="password"
                      type="password"
                      autoComplete="current-password"
                      autoFocus
                      required
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      className="h-11 pl-10"
                    />
                  </div>
                </div>

                {error && (
                  <p role="alert" aria-live="polite" className="rounded-xl bg-red-50 px-3 py-2.5 text-sm text-red-700">
                    {retryAfterSeconds > 0
                      ? `Too many attempts. Try again in ${retryAfterSeconds >= 60 ? `${Math.ceil(retryAfterSeconds / 60)} min` : `${retryAfterSeconds} sec`}.`
                      : error}
                  </p>
                )}

                <Button
                  type="submit"
                  className="h-11 w-full"
                  disabled={submitting || retryAfterSeconds > 0 || Boolean(error?.includes('configured on the server'))}
                >
                  {submitting ? 'Signing in...' : retryAfterSeconds > 0 ? 'Temporarily locked' : 'Open my CRM'}
                </Button>
              </form>
              )
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
