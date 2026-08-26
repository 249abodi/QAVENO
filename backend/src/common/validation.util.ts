export function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export function intVal(v: unknown, label = 'القيمة', opts: { min?: number | null } = {}): number {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) throw new Error(`${label} غير صالح`);
  if (opts.min != null && n < opts.min) throw new Error(`${label} يجب أن يكون ${opts.min} على الأقل`);
  return n;
}

export const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,40}$/;

export function validateUsername(u: unknown): string {
  const s = String(u ?? '').trim();
  if (!USERNAME_RE.test(s)) {
    throw new Error('اسم المستخدم غير صالح (3-40 حرفاً إنجليزياً/أرقام/._- فقط)');
  }
  return s;
}

export function validateNewPassword(pw: unknown): string {
  const s = String(pw ?? '');
  if (s.length < 8) throw new Error('كلمة المرور يجب أن تكون 8 أحرف على الأقل');
  if (s.length > 200) throw new Error('كلمة المرور طويلة جداً');
  return s;
}
