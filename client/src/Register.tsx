import { useState } from "react";
import type { FormEvent } from "react";
import { apiRegister } from "./api";

type RegisterProps = {
  onAuthed: (payload: { token: string; username: string; recoveryCode?: string }) => void;
  onShowLogin: () => void;
};

export default function Register({ onAuthed, onShowLogin }: RegisterProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload = await apiRegister(username, password);
      onAuthed(payload);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Register failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-card">
      <div className="auth-copy">
        <span className="eyebrow">Register</span>
        <h2>Create your account</h2>
        <p>Your recovery code is shown once after registration. Save it offline.</p>
      </div>

      <form className="auth-form" onSubmit={onSubmit}>
        <label className="field">
          <span>Username</span>
          <input
            placeholder="Choose a username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="username"
          />
        </label>

        <label className="field">
          <span>Password</span>
          <input
            placeholder="At least 6 characters"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="new-password"
          />
        </label>

        {error ? <div className="form-alert error">{error}</div> : null}

        <button className="primary-button" disabled={busy} type="submit">
          {busy ? "Creating account..." : "Create account"}
        </button>
      </form>

      <div className="auth-links">
        <button className="text-button" onClick={onShowLogin} type="button">
          Already have an account? Login
        </button>
      </div>
    </div>
  );
}

