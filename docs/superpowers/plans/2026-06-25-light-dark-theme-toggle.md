# Light/Dark Theme Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a global dark/light theme toggle button in the Navbar (placed directly under Logout), backed by a CSS-variable palette and a React context, defaulting to dark and persisting the user's choice in `localStorage`.

**Architecture:** A `ThemeProvider` (React context) sets a `data-theme` attribute on `<html>` and persists the choice to `localStorage`. A shared `theme.css` file defines CSS variables for both `dark` (current look) and `light` (new) palettes. `Navbar.jsx` gets a sun/moon toggle button under the existing Logout button, and `Navbar.css` is converted from hardcoded hex to the shared variables (Batch 1 of the rollout).

**Tech Stack:** React (Context API + hooks), plain CSS variables, FontAwesome icons (already a project dependency via `@fortawesome/react-fontawesome` / `@fortawesome/free-solid-svg-icons`).

## Global Constraints
- Default theme is `dark`; matches current design exactly (no visual change in dark mode).
- Persist via `localStorage.getItem('theme')` / `setItem('theme', ...)`, mirroring existing `localStorage` key patterns (`token`, `user`, `role`).
- Scope: pages that render the main `Navbar` component. Admin Dashboard (`SideNav`/`TopNav`/`ProfileInfo.jsx`) is out of scope.
- No automated test infra exists for frontend styling in this repo — verification is manual (run the dev server, toggle, confirm `data-theme` attribute and visuals).
- Toggle button must sit directly under the Logout `<li>` in `Navbar.jsx`.

---

### Task 1: ThemeContext + ThemeProvider

**Files:**
- Create: `Frontend/src/context/ThemeContext.jsx`
- Modify: `Frontend/src/App.jsx` (wrap app in `ThemeProvider`)

**Interfaces:**
- Produces: `ThemeProvider` (component, wraps children), `useTheme()` hook returning `{ theme: 'dark' | 'light', toggleTheme: () => void }`.

- [ ] **Step 1: Create the context file**

```jsx
import { createContext, useContext, useEffect, useState } from "react";

const ThemeContext = createContext(undefined);

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => localStorage.getItem("theme") || "dark");

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme((current) => (current === "dark" ? "light" : "dark"));
  };

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}

export default ThemeContext;
```

- [ ] **Step 2: Wrap `App.jsx` in `ThemeProvider`**

In `Frontend/src/App.jsx`, add the import:

```jsx
import { ThemeProvider } from "./context/ThemeContext";
```

Wrap the existing `<GoogleOAuthProvider>` return value with `<ThemeProvider>` as the outermost element:

```jsx
function App() {
  return (
    <ThemeProvider>
      <GoogleOAuthProvider clientId={CLIENT_ID}>
        <AuthProvider>
          {/* ...existing content unchanged... */}
        </AuthProvider>
      </GoogleOAuthProvider>
    </ThemeProvider>
  );
}
```

- [ ] **Step 3: Manual verification**

Run `npm run dev` in `Frontend/`, open the app in a browser, open devtools, and confirm `<html data-theme="dark">` is present on load and `localStorage.theme === "dark"`.

- [ ] **Step 4: Commit**

```bash
git add Frontend/src/context/ThemeContext.jsx Frontend/src/App.jsx
git commit -m "feat: add ThemeProvider context for dark/light theme state"
```

---

### Task 2: Shared CSS variable palette

**Files:**
- Create: `Frontend/src/styles/theme.css`
- Modify: `Frontend/src/index.css` (import the new file)

**Interfaces:**
- Produces: CSS variables consumable by any stylesheet: `--bg`, `--bg-elevated`, `--surface`, `--surface-2`, `--text`, `--text-muted`, `--accent`, `--accent-2`, `--border`, `--shadow`, `--danger`, `--success`.

- [ ] **Step 1: Create the palette file**

```css
:root {
  --bg: #0b0c2a;
  --bg-elevated: #0f1923;
  --surface: #131a36;
  --surface-2: #1a2348;
  --text: #f5f7ff;
  --text-muted: #aab4d4;
  --accent: #36d1dc;
  --accent-2: #5b86e5;
  --border: rgba(255, 255, 255, 0.12);
  --shadow: rgba(0, 0, 0, 0.4);
  --danger: #dc3545;
  --success: #28a745;
}

[data-theme="light"] {
  --bg: #f5f7fb;
  --bg-elevated: #ffffff;
  --surface: #ffffff;
  --surface-2: #eef1f8;
  --text: #1a1f36;
  --text-muted: #5b6479;
  --accent: #1fa6b0;
  --accent-2: #3d68c4;
  --border: rgba(0, 0, 0, 0.1);
  --shadow: rgba(0, 0, 0, 0.12);
  --danger: #dc3545;
  --success: #28a745;
}
```

- [ ] **Step 2: Import it globally**

In `Frontend/src/index.css`, add at the top:

```css
@import "./styles/theme.css";
```

- [ ] **Step 3: Manual verification**

In the browser devtools console, run `document.documentElement.setAttribute('data-theme', 'light')` and confirm `getComputedStyle(document.documentElement).getPropertyValue('--bg')` returns `#f5f7fb`. Then set it back to `dark`.

- [ ] **Step 4: Commit**

```bash
git add Frontend/src/styles/theme.css Frontend/src/index.css
git commit -m "feat: add shared dark/light CSS variable palette"
```

---

### Task 3: Toggle button in Navbar (under Logout)

**Files:**
- Modify: `Frontend/src/components/Navbar/Navbar.jsx:1-7` (imports), `:347-351` (after Logout `<li>`)
- Modify: `Frontend/src/components/Navbar/Navbar.css` (new `.theme-toggle-btn` rule)

**Interfaces:**
- Consumes: `useTheme()` from `Frontend/src/context/ThemeContext.jsx` (Task 1).

- [ ] **Step 1: Add imports to `Navbar.jsx`**

At the top of `Frontend/src/components/Navbar/Navbar.jsx`, change:

```jsx
import { faBell } from "@fortawesome/free-solid-svg-icons";
```

to:

```jsx
import { faBell, faSun, faMoon } from "@fortawesome/free-solid-svg-icons";
```

and add below the `AuthContext` import:

```jsx
import { useTheme } from "../../context/ThemeContext";
```

- [ ] **Step 2: Use the hook inside the component**

Inside `const Navbar = () => {`, near the existing `const { isAuthenticated, logout } = useContext(AuthContext);` line, add:

```jsx
  const { theme, toggleTheme } = useTheme();
```

- [ ] **Step 3: Add the toggle button after the Logout `<li>`**

Find this block (currently lines 347-351):

```jsx
                <li className="nav-item">
                  <button className="btn logout-btn" onClick={handleLogout}>
                    Logout
                  </button>
                </li>
```

Replace with:

```jsx
                <li className="nav-item">
                  <button className="btn logout-btn" onClick={handleLogout}>
                    Logout
                  </button>
                </li>

                <li className="nav-item">
                  <button
                    type="button"
                    className="btn theme-toggle-btn"
                    onClick={toggleTheme}
                    aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
                    title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
                  >
                    <FontAwesomeIcon icon={theme === "dark" ? faSun : faMoon} />
                  </button>
                </li>
```

- [ ] **Step 4: Style the button in `Navbar.css`**

Append to `Frontend/src/components/Navbar/Navbar.css`:

```css
.theme-toggle-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--accent);
  font-size: 14px;
  transition: background-color 0.2s ease, color 0.2s ease;
}

.theme-toggle-btn:hover {
  background: var(--surface);
  color: var(--accent-2);
}
```

- [ ] **Step 5: Manual verification**

With `npm run dev` running, log in (or use an authenticated session) so the Logout button is visible, confirm the sun/moon button appears directly under Logout, and clicking it toggles `data-theme` between `dark` and `light` and swaps the icon.

- [ ] **Step 6: Commit**

```bash
git add Frontend/src/components/Navbar/Navbar.jsx Frontend/src/components/Navbar/Navbar.css
git commit -m "feat: add theme toggle button under Logout in Navbar"
```

---

### Task 4: Convert `Navbar.css` hardcoded colors to shared variables (Batch 1)

**Files:**
- Modify: `Frontend/src/components/Navbar/Navbar.css`

**Interfaces:**
- Consumes: CSS variables from Task 2 (`--bg`, `--surface`, `--surface-2`, `--text`, `--text-muted`, `--accent`, `--accent-2`, `--border`, `--shadow`, `--danger`).

- [ ] **Step 1: Read the current file and map hardcoded colors**

Read `Frontend/src/components/Navbar/Navbar.css` in full. For each hardcoded hex/rgba color matching `#0b0c2a`, `#36d1dc`, `#5b86e5`, white/near-white text, gray muted text, or border/shadow colors, replace with the corresponding `var(--token)` from Task 2's palette (background → `--bg` or `--surface`, accent teal → `--accent`, accent blue → `--accent-2`, text → `--text`, muted text → `--text-muted`, borders → `--border`, shadows → `--shadow`). Leave the `logout-btn` and `danger`-style colors mapped to `--danger`.

- [ ] **Step 2: Manual verification**

With the dev server running, toggle the theme button added in Task 3 and confirm the Navbar background, text, and accents visibly switch between the dark look (unchanged from before this task) and a light look (white/near-white background, dark text, same accent hues).

- [ ] **Step 3: Commit**

```bash
git add Frontend/src/components/Navbar/Navbar.css
git commit -m "refactor: convert Navbar.css to shared theme variables"
```

---

### Task 5: End-to-end manual test pass

**Files:** none (verification only)

- [ ] **Step 1: Start the frontend dev server**

```bash
cd Frontend && npm run dev
```

- [ ] **Step 2: Verify default state**

Open the app in a browser. Confirm dark mode renders identically to before this feature (no visual regression). Check `localStorage.getItem('theme')` is `"dark"`.

- [ ] **Step 3: Verify toggle and persistence**

Log in, click the sun/moon button under Logout. Confirm: icon swaps, Navbar switches to light colors, `localStorage.getItem('theme')` becomes `"light"`. Reload the page — confirm it stays in light mode. Navigate to another page that renders `Navbar` (e.g. `/home`, `/call-room/available`) — confirm the Navbar stays light and the toggle still works there.

- [ ] **Step 4: Toggle back to dark and confirm round-trip**

Click the button again, confirm it returns to the original dark look pixel-for-pixel (same as Step 2) and `localStorage` updates back to `"dark"`.

- [ ] **Step 5: Report results**

No commit for this task — it's verification. If any step fails, fix the relevant earlier task before proceeding.
