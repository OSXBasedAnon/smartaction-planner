"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase-browser";

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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

    router.push("/app");
    router.refresh();
  }

  return (
    <main className="container grid" style={{ maxWidth: 460 }}>
      <h1>Sign up</h1>
      <form onSubmit={onSubmit} className="panel grid">
        <input type="email" placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input type="password" placeholder="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} />
        <button type="submit">Create account</button>
        {error ? <p className="error">{error}</p> : null}
      </form>
      <p className="small">
        Have account? <Link href="/login">Login</Link>
      </p>
    </main>
  );
}
