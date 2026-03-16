import { useMemo, useState } from "react";
import "./App.css";
import Chat from "./Chat";
import Login from "./Login";
import Register from "./Register";
import ResetPassword from "./ResetPassword";

type AuthMode = "login" | "register" | "reset";

type AuthPayload = {
  token: string;
  username: string;
  recoveryCode?: string;
};

export default function App() {
  const [token, setToken] = useState<string | null>(localStorage.getItem("zchat_token"));
  const [me, setMe] = useState<string>(localStorage.getItem("zchat_me") || "");
  const [authMode, setAuthMode] = useState<AuthMode>("login");
  const [recoveryCodeNotice, setRecoveryCodeNotice] = useState<string | null>(null);

  function onAuthed(payload: AuthPayload) {
    setToken(payload.token);
    setMe(payload.username);
    setRecoveryCodeNotice(payload.recoveryCode ?? null);
    localStorage.setItem("zchat_token", payload.token);
    localStorage.setItem("zchat_me", payload.username);
  }

  function logout() {
    setToken(null);
    setMe("");
    setRecoveryCodeNotice(null);
    localStorage.removeItem("zchat_token");
    localStorage.removeItem("zchat_me");
  }

  const authTitle = useMemo(() => {
    if (authMode === "register") return "Create a secure account";
    if (authMode === "reset") return "Reset your password";
    return "Sign in to your encrypted workspace";
  }, [authMode]);

  if (!token) {
    return (
      <div className="app-shell">
        <div className="auth-layout">
          <section className="auth-hero surface-panel">
            <span className="eyebrow">Zchat Secure Sessions</span>
            <h1>{authTitle}</h1>
            <p>
              End-to-end encrypted peer sessions, live drafts, explicit chat requests, and recovery-code based password reset.
            </p>
            <div className="hero-grid">
              <div>
                <strong>Session-first chat</strong>
                <span>Request, accept, chat, then end the session cleanly.</span>
              </div>
              <div>
                <strong>Recovery built in</strong>
                <span>Every account gets a recovery code so password resets do not depend on email infrastructure.</span>
              </div>
              <div>
                <strong>Mobile-safe auth</strong>
                <span>Focused auth screens with reduced input friction for phones and tablets.</span>
              </div>
            </div>
          </section>

          <section className="auth-pane surface-panel">
            {authMode === "login" ? (
              <Login onAuthed={onAuthed} onShowRegister={() => setAuthMode("register")} onShowReset={() => setAuthMode("reset")} />
            ) : null}
            {authMode === "register" ? (
              <Register onAuthed={onAuthed} onShowLogin={() => setAuthMode("login")} />
            ) : null}
            {authMode === "reset" ? (
              <ResetPassword onShowLogin={() => setAuthMode("login")} />
            ) : null}
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <Chat
        token={token}
        me={me}
        onLogout={logout}
        recoveryCodeNotice={recoveryCodeNotice}
        onDismissRecoveryCode={() => setRecoveryCodeNotice(null)}
      />
    </div>
  );
}
