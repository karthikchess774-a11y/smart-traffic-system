const loginTab = document.getElementById('loginTab');
const registerTab = document.getElementById('registerTab');
const loginForm = document.getElementById('loginForm');
const registerForm = document.getElementById('registerForm');
const otpForm = document.getElementById('otpForm');
const message = document.getElementById('formMessage');
let pendingEmail = '';

function hideLegacySmsFields() {
  // Keep compatibility with the previous dual-OTP HTML while removing SMS verification.
  const smsInput = document.getElementById('smsOtp');
  if (smsInput) {
    smsInput.required = false;
    smsInput.disabled = true;
    smsInput.closest('.form-group, .input-group, .field, .otp-field')?.classList.add('hidden');
    smsInput.classList.add('hidden');
  }
  const smsLabel = document.getElementById('otpPhoneLabel');
  if (smsLabel) smsLabel.closest('.form-group, .input-group, .field, .otp-field')?.classList.add('hidden');
  const resend = document.getElementById('resendOtp');
  if (resend) resend.textContent = 'Resend email code';
}
hideLegacySmsFields();

function showForm(which) {
  const isLogin = which === 'login';
  loginForm.classList.toggle('hidden', !isLogin);
  registerForm.classList.toggle('hidden', isLogin);
  otpForm.classList.add('hidden');
  loginTab.classList.toggle('active', isLogin);
  registerTab.classList.toggle('active', !isLogin);
  message.textContent = '';
  message.className = 'message';
}
loginTab.addEventListener('click', () => showForm('login'));
registerTab.addEventListener('click', () => showForm('register'));

async function apiPost(endpoint, payload) {
  const response = await fetch(endpoint, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || 'Request failed.');
  return data;
}
function setMessage(text, kind = 'error') {
  message.textContent = text;
  message.className = `message ${kind}`;
}
function busy(button, active, text) {
  button.disabled = active;
  if (active) {
    button.dataset.originalText = button.textContent;
    button.textContent = 'Please wait…';
  } else {
    button.textContent = button.dataset.originalText || text || 'Submit';
  }
}

loginForm.addEventListener('submit', async event => {
  event.preventDefault();
  const button = loginForm.querySelector('button[type="submit"]');
  busy(button, true);
  try {
    await apiPost('/api/auth/login', {
      email: document.getElementById('loginEmail').value,
      password: document.getElementById('loginPassword').value
    });
    setMessage('Login successful. Opening your dashboard…', 'success');
    window.location.replace('/app');
  } catch (error) {
    setMessage(error.message);
  } finally {
    busy(button, false);
  }
});

registerForm.addEventListener('submit', async event => {
  event.preventDefault();
  const button = registerForm.querySelector('button[type="submit"]');
  busy(button, true);
  try {
    const data = await apiPost('/api/auth/register', {
      name: document.getElementById('registerName').value,
      email: document.getElementById('registerEmail').value,
      password: document.getElementById('registerPassword').value
    });
    pendingEmail = data.email;
    const emailLabel = document.getElementById('otpEmailLabel');
    if (emailLabel) emailLabel.textContent = data.email;
    registerForm.classList.add('hidden');
    loginForm.classList.add('hidden');
    otpForm.classList.remove('hidden');
    hideLegacySmsFields();
    setMessage(data.message, 'success');
    document.getElementById('emailOtp').focus();
  } catch (error) {
    setMessage(error.message);
  } finally {
    busy(button, false);
  }
});

otpForm.addEventListener('submit', async event => {
  event.preventDefault();
  const button = otpForm.querySelector('button[type="submit"]');
  busy(button, true);
  try {
    await apiPost('/api/auth/verify-registration', {
      email: pendingEmail,
      emailOtp: document.getElementById('emailOtp').value.trim()
    });
    setMessage('Email verified. Your account is active. Opening dashboard…', 'success');
    window.location.replace('/app');
  } catch (error) {
    setMessage(error.message);
  } finally {
    busy(button, false);
  }
});

document.getElementById('resendOtp').addEventListener('click', async () => {
  const button = document.getElementById('resendOtp');
  busy(button, true);
  try {
    const data = await apiPost('/api/auth/resend-registration-otp', { email: pendingEmail });
    setMessage(data.message, 'success');
  } catch (error) {
    setMessage(error.message);
  } finally {
    busy(button, false, 'Resend email code');
  }
});

document.getElementById('backToRegister').addEventListener('click', () => {
  otpForm.classList.add('hidden');
  registerForm.classList.remove('hidden');
  setMessage('You can edit your registration details and request a new email code.', '');
});

fetch('/api/auth/me', { credentials: 'same-origin' })
  .then(response => {
    if (response.ok) window.location.replace('/app');
  })
  .catch(() => {});
