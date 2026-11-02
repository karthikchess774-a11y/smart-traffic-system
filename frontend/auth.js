(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const forms = ["loginForm", "registerForm", "verifyForm", "forgotForm", "resetForm"];
  let pendingEmail = "";
  let resetEmail = "";

  function showMessage(message, type = "success") {
    const box = $("notice");
    box.textContent = message;
    box.className = `message show ${type}`;
  }
  function clearMessage() {
    const box = $("notice");
    box.textContent = "";
    box.className = "message";
  }
  function showForm(name) {
    clearMessage();
    forms.forEach((id) => $(id).classList.toggle("hidden", id !== name));
    const tabsVisible = name === "loginForm" || name === "registerForm";
    $("tabs").classList.toggle("hidden", !tabsVisible);
    $("loginTab").classList.toggle("active", name === "loginForm");
    $("registerTab").classList.toggle("active", name === "registerForm");
  }
  async function api(url, body) {
    const response = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(body)
    });
    let data = {};
    try { data = await response.json(); } catch (_) {}
    if (!response.ok || data.status === "error") throw new Error(data.message || "Request failed. Please try again.");
    return data;
  }
  function setBusy(form, busy, label) {
    const button = form.querySelector("button[type='submit']");
    if (!button) return;
    if (busy) {
      button.dataset.originalText = button.textContent;
      button.textContent = label || "Please wait…";
      button.disabled = true;
    } else {
      button.textContent = button.dataset.originalText || button.textContent;
      button.disabled = false;
    }
  }
  function passwordProblem(password) {
    if (password.length < 12) return "Password must contain at least 12 characters.";
    if (password.length > 128 || new TextEncoder().encode(password).length > 72) return "Password is too long. Use no more than 72 UTF-8 bytes.";
    if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
      return "Include uppercase, lowercase, a number and a special character.";
    }
    return "";
  }

  $("loginTab").addEventListener("click", () => showForm("loginForm"));
  $("registerTab").addEventListener("click", () => showForm("registerForm"));
  $("showRegister").addEventListener("click", () => showForm("registerForm"));
  $("showLogin").addEventListener("click", () => showForm("loginForm"));
  $("showForgot").addEventListener("click", () => {
    $("forgotEmail").value = $("loginEmail").value.trim();
    showForm("forgotForm");
  });
  $("backToLogin").addEventListener("click", () => showForm("loginForm"));
  $("backToForgot").addEventListener("click", () => showForm("forgotForm"));
  $("backToRegister").addEventListener("click", () => showForm("registerForm"));

  $("registerForm").addEventListener("submit", async (event) => {
    event.preventDefault(); clearMessage();
    const form = event.currentTarget;
    const name = $("regName").value.trim();
    const email = $("regEmail").value.trim().toLowerCase();
    const password = $("regPassword").value;
    if (password !== $("regConfirm").value) return showMessage("Passwords do not match.", "error");
    const problem = passwordProblem(password);
    if (problem) return showMessage(problem, "error");
    setBusy(form, true, "Sending code…");
    try {
      await api("/api/auth/register", { name, email, password });
      pendingEmail = email;
      $("verifyEmailLabel").textContent = email;
      $("registrationOtp").value = "";
      showForm("verifyForm");
      showMessage("Verification code sent. Check your inbox and spam folder.");
    } catch (error) { showMessage(error.message, "error"); }
    finally { setBusy(form, false); }
  });

  $("verifyForm").addEventListener("submit", async (event) => {
    event.preventDefault(); clearMessage();
    const form = event.currentTarget;
    const emailOtp = $("registrationOtp").value.trim();
    if (!/^\d{6}$/.test(emailOtp)) return showMessage("Enter the 6-digit code.", "error");
    setBusy(form, true, "Verifying…");
    try {
      await api("/api/auth/verify-registration", { email: pendingEmail, emailOtp });
      showMessage("Email verified. Opening your traffic dashboard…");
      window.location.assign("/app");
    } catch (error) { showMessage(error.message, "error"); }
    finally { setBusy(form, false); }
  });

  $("resendRegistration").addEventListener("click", async () => {
    clearMessage();
    try {
      await api("/api/auth/resend-registration-otp", { email: pendingEmail });
      showMessage("A new verification code has been sent.");
    } catch (error) { showMessage(error.message, "error"); }
  });

  $("loginForm").addEventListener("submit", async (event) => {
    event.preventDefault(); clearMessage();
    const form = event.currentTarget;
    setBusy(form, true, "Signing in…");
    try {
      await api("/api/auth/login", {
        email: $("loginEmail").value.trim().toLowerCase(),
        password: $("loginPassword").value
      });
      window.location.assign("/app");
    } catch (error) { showMessage(error.message, "error"); }
    finally { setBusy(form, false); }
  });

  $("forgotForm").addEventListener("submit", async (event) => {
    event.preventDefault(); clearMessage();
    const form = event.currentTarget;
    resetEmail = $("forgotEmail").value.trim().toLowerCase();
    setBusy(form, true, "Sending code…");
    try {
      const result = await api("/api/auth/forgot-password", { email: resetEmail });
      showForm("resetForm");
      showMessage(result.message || "If an account exists, a reset code has been sent.");
    } catch (error) { showMessage(error.message, "error"); }
    finally { setBusy(form, false); }
  });

  $("resetForm").addEventListener("submit", async (event) => {
    event.preventDefault(); clearMessage();
    const form = event.currentTarget;
    const newPassword = $("newPassword").value;
    if (newPassword !== $("confirmNewPassword").value) return showMessage("Passwords do not match.", "error");
    const problem = passwordProblem(newPassword);
    if (problem) return showMessage(problem, "error");
    setBusy(form, true, "Resetting…");
    try {
      const result = await api("/api/auth/reset-password", {
        email: resetEmail,
        otp: $("resetOtp").value.trim(),
        newPassword
      });
      $("loginEmail").value = resetEmail;
      $("loginPassword").value = "";
      showForm("loginForm");
      showMessage(result.message || "Password reset successfully. Log in with your new password.");
    } catch (error) { showMessage(error.message, "error"); }
    finally { setBusy(form, false); }
  });

  // If a valid session already exists, skip the login screen.
  fetch("/api/auth/me", { credentials: "same-origin", headers: { Accept: "application/json" } })
    .then((response) => { if (response.ok) window.location.replace("/app"); })
    .catch(() => {});
})();
