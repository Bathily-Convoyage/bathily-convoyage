(function exposeAuthPasswordErrors(global) {
  'use strict';

  const COMPROMISED_PASSWORD_MESSAGE =
    'Ce mot de passe est trop courant ou a été compromis. Veuillez en choisir un autre.';
  const WEAK_PASSWORD_MESSAGE =
    'Ce mot de passe ne respecte pas les critères de sécurité. Choisissez un mot de passe plus long et plus difficile à deviner.';

  // SEC-1F4: Message for unconfirmed email login attempts.
  const EMAIL_NOT_CONFIRMED_MESSAGE =
    'Votre adresse email n\'est pas encore confirmée. Consultez votre boîte mail ou renvoyez l\'email de confirmation.';

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

  global.BathilyAuthErrors = Object.freeze({
    COMPROMISED_PASSWORD_MESSAGE,
    WEAK_PASSWORD_MESSAGE,
    EMAIL_NOT_CONFIRMED_MESSAGE,
    getPasswordRejectionMessage,
    isWeakPasswordError,
    isEmailNotConfirmedError,
    getEmailNotConfirmedMessage
  });
})(window);
