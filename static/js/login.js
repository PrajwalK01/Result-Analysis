/* ── Toggle password visibility ── */
document.getElementById("toggleEye").addEventListener("click", function () {
  const input = document.getElementById("password");
  const icon  = document.getElementById("eyeIcon");
  const show  = input.type === "password";

  input.type = show ? "text" : "password";

  // Swap icon: open eye ↔ eye-off
  icon.innerHTML = show
    ? `<path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/>
       <path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/>
       <line x1="1" y1="1" x2="23" y2="23"/>`
    : `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
       <circle cx="12" cy="12" r="3"/>`;
});

/* ── Enter key submits form ── */
document.getElementById("loginForm").addEventListener("submit", function (e) {
  e.preventDefault();
  doLogin();
});

/* ── Login handler ── */
async function doLogin() {
  const username  = document.getElementById("username").value.trim();
  const password  = document.getElementById("password").value;
  const msgEl     = document.getElementById("message");
  const btn       = document.getElementById("loginBtn");
  const btnText   = document.getElementById("loginBtnText");
  const btnArrow  = document.getElementById("loginBtnArrow");
  const spinner   = document.getElementById("loginSpinner");

  clearMessage(msgEl);

  if (!username || !password) {
    showMessage(msgEl, "Please enter your username and password.", "err");
    return;
  }

  // Loading state
  btn.disabled = true;
  btnText.textContent = "Signing in…";
  btnArrow.classList.add("hidden");
  spinner.classList.remove("hidden");

  try {
    const res  = await fetch("/login", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ username, password }),
    });

    const data = await res.json();

    if (data.success) {
      showMessage(msgEl, "✓ Login successful. Redirecting…", "ok");
      btnText.textContent = "Redirecting…";
      setTimeout(() => { window.location.href = "/user"; }, 600);
    } else {
      showMessage(msgEl, data.message || "Login failed.", "err");
      resetBtn(btn, btnText, btnArrow, spinner);
      // Shake the card on error
      document.querySelector(".login-card").classList.add("shake");
      setTimeout(() => document.querySelector(".login-card").classList.remove("shake"), 500);
    }
  } catch (err) {
    showMessage(msgEl, "Network error. Please check your connection.", "err");
    resetBtn(btn, btnText, btnArrow, spinner);
  }
}

function showMessage(el, text, type) {
  el.textContent = text;
  el.className   = `login-message login-message--${type}`;
}

function clearMessage(el) {
  el.textContent = "";
  el.className   = "login-message hidden";
}

function resetBtn(btn, btnText, btnArrow, spinner) {
  btn.disabled = false;
  btnText.textContent = "Sign In";
  btnArrow.classList.remove("hidden");
  spinner.classList.add("hidden");
}
