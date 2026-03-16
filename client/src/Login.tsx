import { useState } from "react";
import type { FormEvent } from "react";
import { apiLogin } from "./api";

type LoginProps = {
  onAuthed: (payload: { token: string; username: string }) => void;
  onShowRegister: () => void;
  onShowReset: () => void;
};

export default function Login({ onAuthed, onShowRegister, onShowReset }: LoginProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload = await apiLogin(username, password);
      onAuthed({ token: payload.token, username: payload.username });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-card">
      <div className="auth-copy">
        <span className="eyebrow">Login</span>
        <h2>Welcome back</h2>
        <p>Use your username and password to open your secure session workspace.</p>
      </div>

      <form className="auth-form" onSubmit={onSubmit}>
        <label className="field">
          <span>Username</span>
          <input
            placeholder="your username"
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
            placeholder="Enter password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="current-password"
          />
        </label>

        {error ? <div className="form-alert error">{error}</div> : null}

        <button className="primary-button" disabled={busy} type="submit">
          {busy ? "Signing in..." : "Login"}
        </button>
      </form>

      <div className="auth-links">
        <button className="text-button" onClick={onShowReset} type="button">
          Reset password with recovery code
        </button>
        <button className="text-button" onClick={onShowRegister} type="button">
          Need an account? Create one
        </button>
      </div>
    </div>
  );
}

