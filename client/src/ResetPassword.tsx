import { useState } from "react";
import type { FormEvent } from "react";
import { apiResetPassword } from "./api";

type ResetPasswordProps = {
  onShowLogin: () => void;
};

export default function ResetPassword({ onShowLogin }: ResetPasswordProps) {
  const [username, setUsername] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await apiResetPassword(username, recoveryCode, newPassword);
      setSuccess("Password reset complete. You can log in now.");
      setNewPassword("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Password reset failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-card">
      <div className="auth-copy">
        <span className="eyebrow">Recovery</span>
        <h2>Reset with recovery code</h2>
        <p>Support cannot retrieve your password. Use the recovery code issued during registration.</p>
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
          />
        </label>

        <label className="field">
          <span>Recovery code</span>
          <input
            placeholder="ABCD-EFGH-IJKL"
            value={recoveryCode}
            onChange={(event) => setRecoveryCode(event.target.value.toUpperCase())}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>

        <label className="field">
          <span>New password</span>
          <input
            placeholder="Choose a new password"
            type="password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="new-password"
          />
        </label>

        {error ? <div className="form-alert error">{error}</div> : null}
        {success ? <div className="form-alert success">{success}</div> : null}

        <button className="primary-button" disabled={busy} type="submit">
          {busy ? "Resetting..." : "Reset password"}
        </button>
      </form>

      <div className="auth-links">
        <button className="text-button" onClick={onShowLogin} type="button">
          Back to login
        </button>
      </div>
    </div>
  );
}

