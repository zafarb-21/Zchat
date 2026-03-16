// client/src/Register.tsx
import { useState } from "react";
import { apiRegister } from "./api";

export default function Register(props: { onAuthed: (token: string, username: string) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function onRegister() {
    try {
      setBusy(true);
      const res = await apiRegister(username, password);
      props.onAuthed(res.token, res.username);
    } catch (e: any) {
      alert(e?.message || "Register failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ border: "1px solid #444", padding: 12, borderRadius: 8 }}>
      <h3 style={{ marginTop: 0 }}>Register</h3>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input placeholder="username" value={username} onChange={(e) => setUsername(e.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
        <input placeholder="password (min 6 chars)" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoCapitalize="none" autoCorrect="off" />
        <button disabled={busy} onClick={onRegister}>Create account</button>
      </div>
    </div>
  );
}

