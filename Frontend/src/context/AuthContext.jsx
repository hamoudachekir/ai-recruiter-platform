import { createContext, useState, useEffect, useContext } from "react";
import PropTypes from "prop-types";

const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true); // ⏳ empêche les flashs

  const login = (userData, token) => {
    localStorage.setItem("token", token); // ✅ encore ici
    localStorage.setItem("user", JSON.stringify(userData));
    setIsAuthenticated(true);
    setUser(userData);
  };
  

  const logout = () => {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    setIsAuthenticated(false);
    setUser(null);
  };

  useEffect(() => {
    const token = localStorage.getItem("token");
    const cachedUser = localStorage.getItem("user");

    if (!token) {
      setLoading(false);
      return;
    }

    // Immediately restore session from cache so the UI doesn't flash a login screen
    if (cachedUser) {
      try {
        const parsed = JSON.parse(cachedUser);
        setIsAuthenticated(true);
        setUser(parsed);
      } catch (_) {
        // ignore malformed cache
      }
    }

    const checkAuth = async () => {
      try {
        const res = await fetch("http://localhost:3001/Frontend/me", {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (res.ok) {
          const userData = await res.json();
          setIsAuthenticated(true);
          setUser(userData);
          localStorage.setItem("user", JSON.stringify(userData));
        } else {
          // Only force logout on real auth failures (expired / invalid token)
          const data = await res.json().catch(() => ({}));
          if (
            res.status === 401 &&
            (data.code === "TOKEN_EXPIRED" || data.code === "TOKEN_INVALID")
          ) {
            logout();
          }
          // For other server errors (500, network issues) keep the cached session
        }
      } catch (_error) {
        // Network error — backend may be temporarily down.
        // Keep the cached session rather than forcing logout.
      } finally {
        setLoading(false);
      }
    };

    checkAuth();
  }, []);
  
  return (
    <AuthContext.Provider value={{ isAuthenticated, user, login, logout, loading }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within an AuthProvider");
  return context;
};

AuthProvider.propTypes = {
  children: PropTypes.node.isRequired,
};

export default AuthContext;
