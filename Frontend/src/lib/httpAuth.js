import axios from "axios";

// ─── Global auth-failure handling ────────────────────────────────────────────
// When any API call comes back 401 the JWT is missing / invalid / expired, so
// the session can no longer be used. Previously nothing handled this: pages
// kept the dead token in a captured variable and their polling effects
// (e.g. the 15s interval on the interview-rooms / compare pages) re-fired the
// same request forever, flooding the console with "Invalid or expired token"
// 401s. Here we clear the stale session once and bounce the user to /login so
// they can obtain a fresh token.
//
// Notes:
//  - Guarded so we redirect at most once (concurrent requests all 401 together).
//  - Skipped on the auth pages themselves so a bad-credentials 401 on /login
//    doesn't cause a redirect loop.
//  - Only acts when a token actually existed — anonymous 401s (public pages)
//    are left for the caller to handle.

let handlingAuthFailure = false;

const clearSession = () => {
  localStorage.removeItem("token");
  localStorage.removeItem("user");
  localStorage.removeItem("userId");
  localStorage.removeItem("role");
};

axios.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error?.response?.status;

    if (status === 401 && !handlingAuthFailure) {
      const path = window.location.pathname;
      const onAuthPage = path === "/login" || path === "/register";
      const hadSession = Boolean(localStorage.getItem("token"));

      if (!onAuthPage && hadSession) {
        handlingAuthFailure = true;
        clearSession();
        // Full navigation tears down the app and stops any in-flight polling.
        window.location.assign("/login?session=expired");
      }
    }

    return Promise.reject(error);
  },
);

export default axios;
