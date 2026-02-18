"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase-browser";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const supabase = createSupabaseBrowserClient();
    const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
    if (authError) {
      setError(authError.message);
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
          <h1>Welcome back</h1>
          <p className="small">Sign in to unlock saved runs, faster reruns, and adaptive site ranking based on your usage.</p>
          <ul className="auth-list">
            <li>Saved quote history</li>
            <li>One-click rerun inputs</li>
            <li>Performance-learning site ranking</li>
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
                placeholder="Your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <button type="button" className="auth-toggle" onClick={() => setShow((v) => !v)}>
                {show ? "Hide" : "Show"}
              </button>
            </div>
            <button type="submit" className="search-btn auth-submit">
              Log in
            </button>
            {error ? <p className="error">{error}</p> : null}
          </form>
          <p className="small auth-switch">
            Need account? <Link href="/signup">Create one</Link>
          </p>
        </section>
      </section>
    </main>
  );
}
