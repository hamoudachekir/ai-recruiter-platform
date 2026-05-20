import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { BrainCircuit, Eye, EyeOff } from "lucide-react";
import "../AdminDashboard.css";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!email || !password) {
      setError("Please fill in all fields.");
      return;
    }

    setLoading(true);
    setError("");

    try {
      const res = await fetch("http://localhost:3001/api/users");
      if (!res.ok) throw new Error("Could not reach server");
      const body = await res.json();
      const users = body.data || body;
      const admin = users.find((u) => u.role === "ADMIN");
      if (!admin) throw new Error("No admin account found");

      if (email === admin.email && password === admin.password) {
        localStorage.setItem("admin", JSON.stringify(admin));
        navigate("/dashboard");
      } else {
        setError("Invalid email or password.");
      }
    } catch (err) {
      setError(err.message || "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="adm-login">
      <div className="adm-login__card">
        {/* Logo */}
        <div className="adm-login__logo">
          <BrainCircuit size={22} />
        </div>

        <h1 className="adm-login__title">Admin Portal</h1>
        <p className="adm-login__sub">Sign in to access the admin backoffice</p>

        {error && <div className="adm-login__error">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="adm-login__field">
            <label className="adm-login__label" htmlFor="email">Email address</label>
            <input
              id="email"
              type="email"
              className="adm-input"
              placeholder="admin@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
            />
          </div>

          <div className="adm-login__field">
            <label className="adm-login__label" htmlFor="password">Password</label>
            <div style={{ position: "relative" }}>
              <input
                id="password"
                type={showPw ? "text" : "password"}
                className="adm-input"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
                style={{ paddingRight: 40 }}
              />
              <button
                type="button"
                onClick={() => setShowPw((v) => !v)}
                style={{
                  position: "absolute",
                  right: 10,
                  top: "50%",
                  transform: "translateY(-50%)",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: "var(--adm-muted)",
                  display: "flex",
                  alignItems: "center",
                }}
              >
                {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </div>

          <button
            type="submit"
            className="adm-login__submit"
            disabled={loading}
          >
            {loading ? "Signing in..." : "Sign in"}
          </button>
        </form>

        <p style={{ textAlign: "center", marginTop: 20, fontSize: "0.73rem", color: "var(--adm-muted)" }}>
          NextHire Admin · Restricted Access
        </p>
      </div>
    </div>
  );
}
