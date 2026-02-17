import { useState } from "react";
import Login from "./Login";
import Register from "./Register";
import Chat from "./Chat";

export default function App() {
  const [token, setToken] = useState<string | null>(localStorage.getItem("zchat_token"));
  const [me, setMe] = useState<string>(localStorage.getItem("zchat_me") || "");

  function onAuthed(t: string, username: string) {
    setToken(t);
    setMe(username);
    localStorage.setItem("zchat_token", t);
    localStorage.setItem("zchat_me", username);
  }

  function logout() {
    setToken(null);
    setMe("");
    localStorage.removeItem("zchat_token");
    localStorage.removeItem("zchat_me");
  }

  if (!token) {
    return (
      <div style={{ maxWidth: 980, margin: "0 auto", padding: 16 }}>
        <h2>Zchat</h2>
        <div style={{ display: "grid", gap: 12 }}>
          <Register onAuthed={onAuthed} />
          <Login onAuthed={onAuthed} />
        </div>
      </div>
    );
  }

  return <Chat token={token} me={me} onLogout={logout} />;
}
