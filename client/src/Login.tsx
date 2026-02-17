// client/src/Login.tsx
import { useState } from "react";
import { apiLogin } from "./api";

export default function Login(props: { onAuthed: (token: string, username: string) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function onLogin() {
    try {
      setBusy(true);
      const res = await apiLogin(username, password);
      props.onAuthed(res.token, res.username);
    } catch (e: any) {
      alert(e?.message || "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ border: "1px solid #444", padding: 12, borderRadius: 8 }}>
      <h3 style={{ marginTop: 0 }}>Login</h3>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input placeholder="username" value={username} onChange={(e) => setUsername(e.target.value)} />
        <input placeholder="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button disabled={busy} onClick={onLogin}>Login</button>
      </div>
    </div>
  );
}
