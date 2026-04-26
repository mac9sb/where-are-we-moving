import { applyTranslations, fmt, initLocaleSwitcher, t } from "/i18n.js";
import { decodeOptions, encodeCredential } from "/webauthn.js";

// Apply translations before anything else renders
applyTranslations();
initLocaleSwitcher();

// Expose fmt on window so inline scripts / future modules can use it
// e.g. fmt.date(new Date()), fmt.relative(-2, "day")
globalThis.fmt = fmt;

// ── Nav: swap Sign in → Sign out if session is active ─────────────────────────

async function updateNav() {
  const navAuth = document.getElementById("nav-auth");
  if (!navAuth) return;
  try {
    const res = await fetch("/api/session");
    if (!res.ok) return;

    const form = document.createElement("form");
    form.method = "post";
    form.action = "/auth/logout";
    form.style.display = "contents";

    const btn = document.createElement("button");
    btn.type = "submit";
    btn.className = "btn-nav";
    btn.style.cssText = "border:none;cursor:pointer;font:inherit";
    btn.textContent = t("nav.sign_out");

    form.appendChild(btn);
    navAuth.replaceChildren(form);
  } catch {
    // Network error — leave default nav
  }
}

// ── Magic link form ────────────────────────────────────────────────────────────

function initMagicForm() {
  const form = document.getElementById("magic-form");
  const notice = document.getElementById("magic-notice");
  if (!form || !notice) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = new FormData(form).get("email");
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    btn.textContent = t("get_started.sending");
    notice.className = "notice hidden";

    try {
      const res = await fetch("/auth/magic-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      if (res.ok) {
        form.classList.add("hidden");
        notice.textContent = t("get_started.check_inbox");
        notice.className = "notice info";
      } else {
        const data = await res.json();
        notice.textContent = data.error ?? t("get_started.error_generic");
        notice.className = "notice error";
        btn.disabled = false;
        btn.textContent = t("get_started.send_link");
      }
    } catch {
      notice.textContent = t("get_started.error_network");
      notice.className = "notice error";
      btn.disabled = false;
      btn.textContent = t("get_started.send_link");
    }
  });
}

// ── Passkey sign-in ────────────────────────────────────────────────────────────

function initPasskeyLogin() {
  const btn = document.getElementById("passkey-login");
  if (!btn || !globalThis.PublicKeyCredential) return;

  btn.classList.remove("hidden");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const notice = document.getElementById("magic-notice");

    try {
      const { options, challengeId } = await fetch(
        "/auth/passkey/login/begin",
        { method: "POST" },
      ).then((r) => r.json());

      const cred = await navigator.credentials.get({
        publicKey: decodeOptions(options),
      });

      const res = await fetch("/auth/passkey/login/finish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId, response: encodeCredential(cred) }),
      });

      if (res.ok) {
        location.href = "/app";
      } else {
        const data = await res.json();
        if (notice) {
          notice.textContent = data.error ?? t("passkey.login_failed");
          notice.className = "notice error";
        }
      }
    } catch (err) {
      if (err.name !== "NotAllowedError" && err.name !== "AbortError") {
        console.error("Passkey login error:", err);
      }
    } finally {
      btn.disabled = false;
    }
  });
}

// ── Passkey registration ───────────────────────────────────────────────────────

function initPasskeyRegister() {
  const btn = document.getElementById("passkey-register");
  if (!btn || !globalThis.PublicKeyCredential) return;

  btn.classList.remove("hidden");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = t("auth_success.adding_passkey");

    try {
      const { options, challengeId } = await fetch(
        "/auth/passkey/register/begin",
        { method: "POST" },
      ).then((r) => r.json());

      const cred = await navigator.credentials.create({
        publicKey: decodeOptions(options),
      });

      const res = await fetch("/auth/passkey/register/finish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId, response: encodeCredential(cred) }),
      });

      if (res.ok) {
        btn.textContent = t("auth_success.passkey_added");
      } else {
        const data = await res.json();
        alert(data.error ?? t("passkey.register_failed"));
        btn.disabled = false;
        btn.textContent = t("auth_success.add_passkey");
      }
    } catch (err) {
      if (err.name !== "NotAllowedError" && err.name !== "AbortError") {
        console.error("Passkey registration error:", err);
      }
      btn.disabled = false;
      btn.textContent = t("auth_success.add_passkey");
    }
  });
}

// ── Sign in with Apple ─────────────────────────────────────────────────────────

function initAppleSignIn() {
  const btn = document.getElementById("apple-signin");
  const clientId = document.querySelector('meta[name="apple-client-id"]')
    ?.content;
  if (!btn || !clientId) return;

  if (document.querySelector('script[src*="appleid.cdn-apple.com"]')) return;
  const script = document.createElement("script");
  script.src =
    "https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js";
  script.onload = () => {
    AppleID.auth.init({
      clientId,
      scope: "name email",
      redirectURI: location.origin + "/auth/apple",
      usePopup: true,
    });

    btn.classList.remove("hidden");
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const notice = document.getElementById("magic-notice");
      try {
        const data = await AppleID.auth.signIn();
        const identityToken = data.authorization.id_token;
        const res = await fetch("/auth/apple", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identityToken }),
        });
        if (res.ok) {
          location.href = "/auth/success";
        } else {
          const body = await res.json();
          if (notice) {
            notice.textContent = body.error ?? t("get_started.apple_error");
            notice.className = "notice error";
          }
        }
      } catch (err) {
        if (err?.error !== "popup_closed_by_user" && notice) {
          notice.textContent = t("get_started.apple_error");
          notice.className = "notice error";
        }
      } finally {
        btn.disabled = false;
      }
    });
  };
  document.head.appendChild(script);
}

// ── Boot ───────────────────────────────────────────────────────────────────────

updateNav();
initMagicForm();
initPasskeyLogin();
initPasskeyRegister();
initAppleSignIn();
