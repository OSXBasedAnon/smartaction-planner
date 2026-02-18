"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase-browser";

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const supabase = createSupabaseBrowserClient();

    const { error: signupError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/api/auth/callback`
      }
    });

    if (signupError) {
      setError(signupError.message);
      return;
    }

    router.push("/");
    router.refresh();
  }

  return (
    <main className="auth-wrap">
      <section className="auth-shell">
        <aside className="auth-side">
          <p className="auth-kicker">SupplyFlare</p>
          <h1>Create your account</h1>
          <p className="small">Join to keep quote history, capture team workflows, and improve site ranking through usage signals.</p>
          <ul className="auth-list">
            <li>Secure email/password auth</li>
            <li>Private run history</li>
            <li>Continuous model + catalog improvements</li>
          </ul>
          <Link href="/" className="small auth-home">
            Back to search
          </Link>
        </aside>

        <section className="auth-card auth-card-strong">
          <form onSubmit={onSubmit} className="auth-form">
            <label>Email</label>
            <input type="email" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <label>Password</label>
            <div className="auth-password">
              <input
                type={show ? "text" : "password"}
                placeholder="At least 6 characters"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={6}
              />
              <button type="button" className="auth-toggle" onClick={() => setShow((v) => !v)}>
                {show ? "Hide" : "Show"}
              </button>
            </div>
            <button type="submit" className="search-btn auth-submit">
              Sign up
            </button>
            {error ? <p className="error">{error}</p> : null}
          </form>
          <p className="small auth-switch">
            Have account? <Link href="/login">Login</Link>
          </p>
        </section>
      </section>
    </main>
  );
}
