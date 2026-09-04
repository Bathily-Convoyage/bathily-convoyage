import { createClient } from '@supabase/supabase-js';
import { getCorsHeaders, jsonResponse, handleOptions, checkRateLimit, parseBody } from '../_utils.js';

function weakPasswordReasons(error) {
  if (!error || !Array.isArray(error.reasons)) return [];
  return error.reasons.filter(reason => ['length', 'characters', 'pwned'].includes(reason));
}

function isWeakPasswordError(error) {
  return Boolean(error) && (
    error.code === 'weak_password' ||
    error.name === 'AuthWeakPasswordError'
  );
}

// SEC-1F4: Generic response for duplicate/collision cases.
// Does NOT reveal whether the account actually exists.
// The frontend shows a neutral "check your inbox or log in" message.
const GENERIC_VERIFICATION_RESPONSE = {
  success: true,
  verification_required: true,
  account_may_exist: true
};

export async function onRequest(context) {
  const { request, env } = context;

  const optionsRes = handleOptions(request);
  if (optionsRes) return optionsRes;

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Méthode non autorisée. Utilisez POST.' }, 405, getCorsHeaders(request));
  }

  const rl = checkRateLimit(request, 'client-signup', 5, 3600000);
  if (rl) return rl;

  try {
    const { email, password, prenom, nom, telephone, societe, adresse, code_postal, ville, isPro } = await parseBody(request);
    if (!email || !password) {
      return jsonResponse({ error: 'Email et mot de passe requis.' }, 400, getCorsHeaders(request));
    }

    if (password.length < 8) {
      return jsonResponse({ error: 'weak_password', reasons: ['length'] }, 400, getCorsHeaders(request));
    }

    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.SUPABASE_ANON_KEY) {
      throw new Error('Configuration Supabase manquante.');
    }

    // SEC-1F4: Normalize email exactly once. Used for Auth signup,
    // profile lookup, and profile INSERT.
    const normalizedEmail = email.trim().toLowerCase();

    // SEC-1F4: Two clients — anon for auth.signUp, admin for profile ops.
    // Service role is NEVER used for self-service Auth user creation.
    const supabaseAnon = (context.supabaseAnon) || createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    const supabaseAdmin = (context.supabase) || createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    // SEC-1F4 Section 6: Pre-signup profile collision check.
    // Query public.clients by normalized email BEFORE calling auth.signUp.
    // If a profile already exists, do NOT call signUp, do NOT mutate Auth,
    // do NOT mutate the profile, and do NOT convert client↔pro.
    const { data: existingProfile } = await supabaseAdmin
      .from('clients')
      .select('id, email, auth_user_id, is_pro, pro_status')
      .eq('email', normalizedEmail)
      .maybeSingle();

    if (existingProfile) {
      // Generic response — does not reveal whether the account exists.
      return jsonResponse(GENERIC_VERIFICATION_RESPONSE, 200, getCorsHeaders(request));
    }

    // SEC-1F4 Section 7: auth.signUp with anon client.
    // This is the ONLY Auth primitive that sends a confirmation email
    // when mailer_autoconfirm=false. admin.createUser does NOT send emails.
    const emailRedirectTo = (env.SITE_URL || 'https://www.bathily-convoyage.fr') + '/confirmation-success.html';

    const { data: signUpData, error: signUpError } = await supabaseAnon.auth.signUp({
      email: normalizedEmail,
      password: password,
      options: {
        data: { prenom, nom, source: isPro ? 'pro_signup' : 'client_signup' },
        emailRedirectTo
      }
    });

    // SEC-1F4 Section 8: Signup error handling.
    if (signUpError) {
      // With mailer_autoconfirm=true, duplicates may return "User already registered".
      // With mailer_autoconfirm=false, duplicates return obfuscated user (no error).
      // This branch handles the autoconfirm=true transition period.
      if (signUpError.message && (signUpError.message.includes('already') || signUpError.message.includes('registered'))) {
        return jsonResponse(GENERIC_VERIFICATION_RESPONSE, 200, getCorsHeaders(request));
      }
      if (isWeakPasswordError(signUpError)) {
        return jsonResponse({
          error: 'weak_password',
          reasons: weakPasswordReasons(signUpError)
        }, 400, getCorsHeaders(request));
      }
      if (signUpError.status === 429) {
        return jsonResponse({ error: 'Trop de tentatives. Réessayez plus tard.' }, 429, getCorsHeaders(request));
      }
      return jsonResponse({ error: signUpError.message }, 400, getCorsHeaders(request));
    }

    // SEC-1F4 Section 9: Obfuscated duplicate detection.
    // If user is null or identities.length === 0, this is a confirmed/obfuscated
    // duplicate. Do NOT use the returned user.id (it is FAKE). Do NOT insert profile.
    if (!signUpData || !signUpData.user) {
      return jsonResponse(GENERIC_VERIFICATION_RESPONSE, 200, getCorsHeaders(request));
    }

    const signUpUser = signUpData.user;
    const identities = Array.isArray(signUpUser.identities) ? signUpUser.identities : [];

    if (identities.length === 0) {
      // Confirmed duplicate — GoTrue returned a faux user with random ID.
      // Do NOT insert profile. Do NOT use user.id. Do NOT delete anything.
      return jsonResponse(GENERIC_VERIFICATION_RESPONSE, 200, getCorsHeaders(request));
    }

    // SEC-1F4 Section 10: Auth user existence verification.
    // Before profile creation, verify via admin.getUserById that the Auth user
    // is real and matches the requested email.
    let authUserExistenceVerified = false;
    let verifiedAuthUser = null;
    try {
      const { data: adminUserData, error: adminUserError } = await supabaseAdmin.auth.admin.getUserById(signUpUser.id);
      if (!adminUserError && adminUserData && adminUserData.user) {
        const adminUser = adminUserData.user;
        const adminEmail = (adminUser.email || '').trim().toLowerCase();
        if (adminUser.id === signUpUser.id && adminEmail === normalizedEmail) {
          authUserExistenceVerified = true;
          verifiedAuthUser = adminUser;
        }
      }
    } catch (e) {
      // Defensive: if admin lookup fails, do NOT insert profile.
    }

    if (!authUserExistenceVerified || !verifiedAuthUser) {
      // Could not verify Auth user existence or email mismatch.
      // Do NOT insert profile. Do NOT delete Auth user (may be pre-existing).
      // Return generic safe response.
      return jsonResponse(GENERIC_VERIFICATION_RESPONSE, 200, getCorsHeaders(request));
    }

    // SEC-1F4 Section 11: Second collision check.
    // Immediately before profile INSERT, check both auth_user_id and email.
    const { data: profileByAuthUserId } = await supabaseAdmin
      .from('clients')
      .select('id, email, auth_user_id')
      .eq('auth_user_id', verifiedAuthUser.id)
      .maybeSingle();

    if (profileByAuthUserId) {
      // Profile already exists for this auth_user_id (retry / concurrent signup).
      // Do NOT insert. Do NOT delete Auth user.
      return jsonResponse(GENERIC_VERIFICATION_RESPONSE, 200, getCorsHeaders(request));
    }

    const { data: profileByEmail } = await supabaseAdmin
      .from('clients')
      .select('id, email, auth_user_id')
      .eq('email', normalizedEmail)
      .maybeSingle();

    if (profileByEmail) {
      // Profile already exists for this email (retry / concurrent signup / collision).
      // Do NOT insert. Do NOT delete Auth user.
      return jsonResponse(GENERIC_VERIFICATION_RESPONSE, 200, getCorsHeaders(request));
    }

    // SEC-1F4 Section 12: Profile insert.
    // Only when ALL preconditions are met:
    // 1. pre-signup profile lookup found nothing
    // 2. signUp succeeded
    // 3. user exists
    // 4. identities.length > 0
    // 5. admin.getUserById confirms real Auth user
    // 6. verified Auth email matches requested email
    // 7. no profile exists by auth_user_id
    // 8. no profile exists by normalized email
    const insertPayload = {
      prenom, nom,
      email: normalizedEmail,
      telephone: telephone || null,
      societe: societe || null,
      adresse: adresse || null,
      code_postal: code_postal || null,
      ville: ville || null,
      pays: 'France',
      role: 'client',
      auth_user_id: verifiedAuthUser.id
    };

    if (isPro) {
      insertPayload.is_pro = true;
      insertPayload.pro_status = 'pending';
    }

    const { error: insertError } = await supabaseAdmin.from('clients').insert([insertPayload]);

    if (insertError) {
      // SEC-1F4 Section 13: Conservative rollback.
      // Do NOT automatically delete Auth user unless we can prove it was
      // created by THIS request. auth.signUp may return a real pre-existing
      // unconfirmed user. Deleting it would be destructive.
      //
      // Ownership signals checked:
      // - No profile existed before signup (checked in Section 6)
      // - No profile exists by auth_user_id (checked in Section 11)
      // - No profile exists by email (checked in Section 11)
      // - identities.length > 0 (could be new user OR unconfirmed duplicate)
      //
      // The identities.length > 0 signal is NOT sufficient to prove ownership
      // because an unconfirmed duplicate also returns identities.length === 1.
      // We cannot reliably distinguish "new user created by this request"
      // from "existing unconfirmed user returned by this request".
      //
      // SAFETY: Do NOT delete. Return 500. Leave Auth user intact.
      // The orphan cleanup is a separate future chantier.
      return jsonResponse({ error: 'Erreur lors de la création du profil.' }, 500, getCorsHeaders(request));
    }

    // SEC-1F4 Section 15: Welcome email.
    // Do NOT send "Bienvenue / compte actif" email before email ownership
    // confirmation. The welcome email wording implies activation, which is
    // incorrect when verification is pending.
    //
    // When mailer_autoconfirm=false (future Production state):
    //   The user is NOT confirmed. Sending a "welcome" email would be misleading.
    //   GoTrue sends its own confirmation email — that is the first email the
    //   user should receive.
    //
    // When mailer_autoconfirm=true (current Production state / transition):
    //   The user IS immediately confirmed. However, to keep behavior consistent
    //   across the transition, we defer the welcome email.
    //
    // The welcome email is intentionally removed from the signup flow.
    // It can be reintroduced in a future chantier as a post-confirmation
    // webhook or callback, which is outside the scope of SEC-1F4A.

    // SEC-1F4 Section 14: Response contract.
    // When session == null (mailer_autoconfirm=false): verification required.
    // When session != null (mailer_autoconfirm=true transition): no verification needed.
    const session = signUpData.session;
    if (session) {
      return jsonResponse({ success: true, verification_required: false }, 200, getCorsHeaders(request));
    }
    return jsonResponse({ success: true, verification_required: true }, 200, getCorsHeaders(request));

  } catch (error) {
    console.error('Erreur client-signup:', error);
    return jsonResponse({ error: error.message || 'Erreur interne' }, 500, getCorsHeaders(request));
  }
}
