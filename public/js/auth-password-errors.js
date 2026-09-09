(function exposeAuthPasswordErrors(global) {
  'use strict';

  const COMPROMISED_PASSWORD_MESSAGE =
    'Ce mot de passe est trop courant ou a été compromis. Veuillez en choisir un autre.';
  const WEAK_PASSWORD_MESSAGE =
    'Ce mot de passe ne respecte pas les critères de sécurité. Choisissez un mot de passe plus long et plus difficile à deviner.';

  // SEC-1F4: Message for unconfirmed email login attempts.
  const EMAIL_NOT_CONFIRMED_MESSAGE =
    'Votre adresse email n\'est pas encore confirmée. Consultez votre boîte mail ou renvoyez l\'email de confirmation.';

  // P2A: Neutral message for network/transient failures.
  // Must NOT claim credentials are incorrect — the request never reached
  // the auth server or the server returned a transient error.
  const NETWORK_ERROR_MESSAGE =
    'Une erreur technique est survenue. Vérifiez votre connexion et réessayez.';

  function getReasons(error) {
    if (!error || !Array.isArray(error.reasons)) return [];
    return error.reasons.filter(reason => typeof reason === 'string');
  }

  function isWeakPasswordError(error) {
    return Boolean(error) && (
      error.code === 'weak_password' ||
      error.error === 'weak_password' ||
      error.name === 'AuthWeakPasswordError'
    );
  }

  // SEC-1F4: Detect "email not confirmed" errors from login attempts.
  // GoTrue returns this when mailer_autoconfirm=false and the user
  // tries to log in before clicking the confirmation link.
  function isEmailNotConfirmedError(error) {
    if (!error) return false;
    // Check error code first (most reliable).
    if (error.code === 'email_not_confirmed') return true;
    // Check error message for known variants (defensive, not sole reliance).
    var msg = (error.message || '').toLowerCase();
    if (msg.indexOf('email not confirmed') !== -1) return true;
    if (msg.indexOf('email not verified') !== -1) return true;
    return false;
  }

  function getPasswordRejectionMessage(error) {
    if (!isWeakPasswordError(error)) return null;

    const reasons = getReasons(error);
    if (reasons.includes('pwned')) return COMPROMISED_PASSWORD_MESSAGE;
    return WEAK_PASSWORD_MESSAGE;
  }

  // SEC-1F4: Get the email-not-confirmed message if applicable, else null.
  function getEmailNotConfirmedMessage(error) {
    if (!isEmailNotConfirmedError(error)) return null;
    return EMAIL_NOT_CONFIRMED_MESSAGE;
  }

  // P2A: Detect network/transient errors that are NOT credential rejections.
  // Supabase JS v2 returns AuthRetryableError for fetch/timeout/5xx failures.
  // These must not be shown as "Email ou mot de passe incorrect".
  function isNetworkOrTransientError(error) {
    if (!error) return false;
    // AuthRetryableError is Supabase JS v2's class for retryable errors
    if (error.name === 'AuthRetryableError') return true;
    // 5xx status or status 0 (network failure) — but NOT 4xx (client errors)
    if (typeof error.status === 'number' && (error.status >= 500 || error.status === 0)) return true;
    // No auth error code + message contains network/fetch/timeout keywords
    // (invalid_credentials always has code='invalid_credentials', so this won't catch it)
    if (!error.code) {
      var msg = (error.message || '').toLowerCase();
      if (msg.indexOf('fetch') !== -1) return true;
      if (msg.indexOf('network') !== -1) return true;
      if (msg.indexOf('timeout') !== -1) return true;
      if (msg.indexOf('abort') !== -1) return true;
      if (msg.indexOf('connection') !== -1) return true;
    }
    return false;
  }

  // P2A: Get the network/transient error message if applicable, else null.
  function getNetworkErrorMessage(error) {
    if (!isNetworkOrTransientError(error)) return null;
    return NETWORK_ERROR_MESSAGE;
  }

  global.BathilyAuthErrors = Object.freeze({
    COMPROMISED_PASSWORD_MESSAGE,
    WEAK_PASSWORD_MESSAGE,
    EMAIL_NOT_CONFIRMED_MESSAGE,
    NETWORK_ERROR_MESSAGE,
    getPasswordRejectionMessage,
    isWeakPasswordError,
    isEmailNotConfirmedError,
    getEmailNotConfirmedMessage,
    isNetworkOrTransientError,
    getNetworkErrorMessage
  });
})(window);
