(function exposeAuthPasswordErrors(global) {
  'use strict';

  const COMPROMISED_PASSWORD_MESSAGE =
    'Ce mot de passe est trop courant ou a été compromis. Veuillez en choisir un autre.';
  const WEAK_PASSWORD_MESSAGE =
    'Ce mot de passe ne respecte pas les critères de sécurité. Choisissez un mot de passe plus long et plus difficile à deviner.';

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

  function getPasswordRejectionMessage(error) {
    if (!isWeakPasswordError(error)) return null;

    const reasons = getReasons(error);
    if (reasons.includes('pwned')) return COMPROMISED_PASSWORD_MESSAGE;
    return WEAK_PASSWORD_MESSAGE;
  }

  global.BathilyAuthErrors = Object.freeze({
    COMPROMISED_PASSWORD_MESSAGE,
    WEAK_PASSWORD_MESSAGE,
    getPasswordRejectionMessage,
    isWeakPasswordError
  });
})(window);
