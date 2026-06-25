# Light/Dark Theme Toggle — Design

## Goal
Add a platform-wide light/dark theme toggle, keeping the current visual design intact in dark mode and introducing a matching light variant — without a redesign.

## Scope
Whole platform: every page reachable through the main `Navbar` component (public pages, profile, call-room/interview pages, reports). Pages rendered only inside the Admin Dashboard layout (which has its own `TopNav`/`SideNav` and does not render `Navbar`) are out of scope for this pass — they already use their own `--adm-*` CSS variables and can be wired into the shared palette in a later pass without blocking this one.

## Default & Persistence
- Default theme: `dark` (matches current design).
- User's choice persists in `localStorage` under key `theme` (`"dark" | "light"`), mirroring the existing `localStorage` patterns used for `token`/`user`/`role`.
- On load, `ThemeProvider` reads `localStorage.getItem('theme')`; if absent, falls back to `dark`.

## Architecture

### 1. `ThemeContext` (`Frontend/src/context/ThemeContext.jsx`)
- React context exposing `{ theme, toggleTheme }`.
- `ThemeProvider` wraps the app in `App.jsx` (alongside the existing `AuthProvider`).
- On mount and on every `theme` change, sets `document.documentElement.setAttribute('data-theme', theme)` and writes to `localStorage`.
- `useTheme()` hook for consuming components (just the toggle button needs it).

### 2. Shared palette (`Frontend/src/styles/theme.css`)
- Imported once, globally (e.g. from `index.css` or `App.jsx`).
- Defines shared CSS variables at `:root` (dark = current look, taken from existing hardcoded values): `--bg`, `--bg-elevated`, `--surface`, `--surface-2`, `--text`, `--text-muted`, `--accent`, `--accent-2`, `--border`, `--shadow`, `--danger`, `--success`.
- `[data-theme="light"]` block overrides each variable with a light equivalent that preserves the existing accent hues (e.g. keep the teal/blue accents, flip backgrounds from near-black to near-white, flip text from light-gray to dark-gray).
- `AdminDashboard.css`'s existing `--adm-*` variables are left as-is for this pass (out of scope), but should eventually `var()`-reference the shared tokens.

### 3. File-by-file conversion (incremental rollout)
Convert hardcoded hex colors to `var(--token)` references, batch by batch:
- **Batch 1 (this pass):** `Navbar.css`, root layout chrome, and whichever page the toggle is verified on first.
- **Batch 2+ (follow-up, can be separate PRs):** `Home.css`, `Login.css`, `JobDetails.css`, and the interview/report CSS files (`CallRoomActive`, `CallRoomAvailable`, `RecruiterIntegrityReport.css`, `IntegritySummaryCards`, `EventTimeline`, `profile.css`, etc.)
- Conversion rule: take each hardcoded hex value, classify which token it represents (background / surface / text / accent / border), replace with the matching `var(--token)`. The current hex becomes the dark-mode value of that token; light mode gets a newly chosen but design-consistent value.
- Pages/files not yet converted simply stay visually identical in both modes (no regression) until converted in a later batch — acceptable since the toggle is additive, not a hard cutover.

### 4. Toggle button placement
- In `Navbar.jsx`, inside the authenticated `nav-group-user` list, add a new `<li className="nav-item">` directly **after** the existing Logout `<li>` (line ~347-351), containing a sun/moon icon button that calls `toggleTheme()` from `useTheme()`.
- Icon: reuse the existing FontAwesome pattern already used for notifications (`faSun` / `faMoon` from `@fortawesome/free-solid-svg-icons`), swapping icon based on current `theme`.
- Styled via a new `.theme-toggle-btn` rule in `Navbar.css`, visually consistent with `.logout-btn` (same size/shape family, distinct color).

## Testing
- Manual verification in browser: toggle switches `data-theme` attribute, Navbar and converted Batch-1 files visibly change, choice survives a page reload and navigation across routes.
- No automated test infra exists for frontend styling in this repo; this is verified visually, not via unit tests.

## Out of scope
- Admin Dashboard area (`TopNav`/`SideNav`/`ProfileInfo.jsx`) — separate theming system already in place, left untouched.
- Full conversion of all 40+ legacy CSS files — done incrementally in follow-up batches after this pass ships the working toggle + Batch 1.
