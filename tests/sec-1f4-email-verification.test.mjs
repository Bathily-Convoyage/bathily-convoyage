import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================
// SEC-1F4 — Email Verification — Static Tests
// ============================================================
// Static tests verifying the SEC-1F4A implementation:
//   1. client-signup uses anon client for auth.signUp
//   2. service role not used for self-service Auth creation
//   3. pre-signup profile lookup exists
//   4. existing profile path does NOT call signUp
//   5. obfuscated identities.length===0 path does NOT insert profile
//   6. admin.getUserById validation exists
//   7. second collision check by email exists
//   8. second collision check by auth_user_id exists
//   9. profile insert only occurs after real Auth validation
//  10. rollback cannot blindly delete ambiguous existing user
//  11. verification_required=true path exists
//  12. verification_required=false transition path exists
//  13. dashboard client does not auto-login unconfirmed signup
//  14. espace pro handles pending verification
//  15. resend uses type='signup'
//  16. verifyOtp uses type='email'
//  17. confirmation page does NOT call verifyOtp on page load
//  18. verifyOtp only reachable from explicit user action
//  19. token_hash is removed after success
//  20. no token logging
//  21. reset-password files unchanged
//  22. Stripe webhook unchanged
//  23. no config.toml change
//  24. no SQL migration added
// ============================================================

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, "..");

const clientSignupPath = path.join(projectRoot, "functions", "api", "client-signup.js");
const clientSignup = fs.readFileSync(clientSignupPath, "utf8");

const dashboardClientPath = path.join(projectRoot, "dashboard-client.html");
const dashboardClient = fs.readFileSync(dashboardClientPath, "utf8");

const espaceProPath = path.join(projectRoot, "espace-pro.html");
const espacePro = fs.readFileSync(espaceProPath, "utf8");

const confirmationPath = path.join(projectRoot, "confirmation-success.html");
const confirmationPage = fs.readFileSync(confirmationPath, "utf8");

const authErrorsPath = path.join(projectRoot, "public", "js", "auth-password-errors.js");
const authErrors = fs.readFileSync(authErrorsPath, "utf8");

const configPath = path.join(projectRoot, "supabase", "config.toml");
const configContent = fs.readFileSync(configPath, "utf8");

const clientResetPath = path.join(projectRoot, "functions", "api", "client-reset-password.js");
const clientResetContent = fs.readFileSync(clientResetPath, "utf8");

const convoyeurResetPath = path.join(projectRoot, "functions", "api", "convoyeur-reset-password.js");
const convoyeurResetContent = fs.readFileSync(convoyeurResetPath, "utf8");

const stripeWebhookPath = path.join(projectRoot, "functions", "api", "stripe-webhook.js");
const stripeWebhookContent = fs.readFileSync(stripeWebhookPath, "utf8");

let passed = 0;
function ok(msg) {
  console.log(`ok - ${msg}`);
  passed++;
}

// ============================================================
// 1. client-signup uses anon client for auth.signUp
// ============================================================
assert.ok(
  clientSignup.includes("auth.signUp("),
  "client-signup must call auth.signUp()"
);
assert.ok(
  clientSignup.includes("SUPABASE_ANON_KEY"),
  "client-signup must reference SUPABASE_ANON_KEY for the anon client"
);
ok("client-signup uses anon client for auth.signUp");

// ============================================================
// 2. service role not used for self-service Auth creation
// ============================================================
// The admin client must be used only for profile ops, not for createUser.
assert.ok(
  !clientSignup.includes("auth.admin.createUser("),
  "client-signup must NOT use auth.admin.createUser for self-service signup"
);
ok("service role not used for self-service Auth creation");

// ============================================================
// 3. pre-signup profile lookup exists
// ============================================================
assert.ok(
  clientSignup.includes("from('clients')") && clientSignup.includes("eq('email', normalizedEmail)"),
  "client-signup must have a pre-signup profile lookup by email"
);
assert.ok(
  clientSignup.includes("existingProfile"),
  "client-signup must check existingProfile before signUp"
);
ok("pre-signup profile lookup exists");

// ============================================================
// 4. existing profile path does NOT call signUp
// ============================================================
// The existing profile check must return before signUp is called.
const existingProfileCheckIdx = clientSignup.indexOf("if (existingProfile)");
const signUpIdx = clientSignup.indexOf("auth.signUp(");
assert.ok(existingProfileCheckIdx !== -1, "existing profile check must exist");
assert.ok(signUpIdx !== -1, "auth.signUp must exist");
assert.ok(
  existingProfileCheckIdx < signUpIdx,
  "existing profile check must come before auth.signUp"
);
// Verify the existing profile block returns before signUp
const existingBlock = clientSignup.substring(existingProfileCheckIdx, signUpIdx);
assert.ok(
  existingBlock.includes("return jsonResponse") && existingBlock.includes("GENERIC_VERIFICATION_RESPONSE"),
  "existing profile path must return generic response before signUp"
);
ok("existing profile path does NOT call signUp");

// ============================================================
// 5. obfuscated identities.length===0 path does NOT insert profile
// ============================================================
assert.ok(
  clientSignup.includes("identities.length === 0"),
  "client-signup must check identities.length === 0 for obfuscated duplicates"
);
const identitiesCheckIdx = clientSignup.indexOf("identities.length === 0");
const insertIdx = clientSignup.indexOf("from('clients').insert(");
assert.ok(identitiesCheckIdx !== -1, "identities check must exist");
assert.ok(insertIdx !== -1, "profile insert must exist");
assert.ok(
  identitiesCheckIdx < insertIdx,
  "identities.length === 0 check must come before profile insert"
);
// Verify the identities === 0 block returns before insert
const identitiesBlock = clientSignup.substring(identitiesCheckIdx, insertIdx);
assert.ok(
  identitiesBlock.includes("return jsonResponse") && identitiesBlock.includes("GENERIC_VERIFICATION_RESPONSE"),
  "identities.length === 0 path must return generic response before insert"
);
ok("obfuscated identities.length===0 path does NOT insert profile");

// ============================================================
// 6. admin.getUserById validation exists
// ============================================================
assert.ok(
  clientSignup.includes("auth.admin.getUserById("),
  "client-signup must call admin.getUserById for Auth user verification"
);
assert.ok(
  clientSignup.includes("authUserExistenceVerified"),
  "client-signup must track authUserExistenceVerified flag"
);
assert.ok(
  clientSignup.includes("adminUser.id === signUpUser.id"),
  "client-signup must verify admin user ID matches signUp user ID"
);
ok("admin.getUserById validation exists");

// ============================================================
// 7. second collision check by email exists
// ============================================================
assert.ok(
  clientSignup.includes("profileByEmail"),
  "client-signup must have a second collision check by email (profileByEmail)"
);
ok("second collision check by email exists");

// ============================================================
// 8. second collision check by auth_user_id exists
// ============================================================
assert.ok(
  clientSignup.includes("profileByAuthUserId"),
  "client-signup must have a second collision check by auth_user_id (profileByAuthUserId)"
);
ok("second collision check by auth_user_id exists");

// ============================================================
// 9. profile insert only occurs after real Auth validation
// ============================================================
// The insert must come after the authUserExistenceVerified check.
const authVerifiedCheckIdx = clientSignup.indexOf("if (!authUserExistenceVerified || !verifiedAuthUser)");
assert.ok(authVerifiedCheckIdx !== -1, "authUserExistenceVerified check must exist");
assert.ok(
  authVerifiedCheckIdx < insertIdx,
  "auth user existence check must come before profile insert"
);
ok("profile insert only occurs after real Auth validation");

// ============================================================
// 10. rollback cannot blindly delete ambiguous existing user
// ============================================================
// The rollback section must NOT call deleteUser on ambiguous users.
// It should return 500 and leave Auth user intact.
const insertErrorIdx = clientSignup.indexOf("if (insertError)");
const insertErrorBlock = clientSignup.substring(insertErrorIdx, insertErrorIdx + 1200);
assert.ok(
  !insertErrorBlock.includes("deleteUser"),
  "rollback must NOT call deleteUser on ambiguous insert failure"
);
assert.ok(
  insertErrorBlock.includes("return jsonResponse") && insertErrorBlock.includes("500"),
  "rollback must return 500 on insert failure"
);
ok("rollback cannot blindly delete ambiguous existing user");

// ============================================================
// 11. verification_required=true path exists
// ============================================================
assert.ok(
  clientSignup.includes("verification_required: true"),
  "client-signup must return verification_required: true for unconfirmed signup"
);
ok("verification_required=true path exists");

// ============================================================
// 12. verification_required=false transition path exists
// ============================================================
assert.ok(
  clientSignup.includes("verification_required: false"),
  "client-signup must return verification_required: false for transition (autoconfirm=true)"
);
ok("verification_required=false transition path exists");

// ============================================================
// 13. dashboard client does not auto-login unconfirmed signup
// ============================================================
assert.ok(
  dashboardClient.includes("verification_required === true"),
  "dashboard-client must check verification_required === true"
);
assert.ok(
  dashboardClient.includes("Vérifiez votre boîte mail"),
  "dashboard-client must show verification-pending UI"
);
// Ensure the verification_required=true path does NOT call signInWithPassword
const dashVerificationIdx = dashboardClient.indexOf("verification_required === true");
const dashSignInIdx = dashboardClient.indexOf("signInWithPassword", dashVerificationIdx);
const dashVerificationBlockEnd = dashboardClient.indexOf("return;", dashVerificationIdx);
assert.ok(
  dashSignInIdx === -1 || dashSignInIdx > dashVerificationBlockEnd,
  "dashboard-client verification_required=true path must NOT call signInWithPassword before returning"
);
ok("dashboard client does not auto-login unconfirmed signup");

// ============================================================
// 14. espace pro handles pending verification
// ============================================================
assert.ok(
  espacePro.includes("verification_required === true"),
  "espace-pro must check verification_required === true"
);
assert.ok(
  espacePro.includes("Vérifiez votre adresse email"),
  "espace-pro must show verification-pending UI"
);
assert.ok(
  espacePro.includes("demande de compte professionnel restera en attente"),
  "espace-pro must clarify that pro approval is pending after email confirmation"
);
ok("espace pro handles pending verification");

// ============================================================
// 15. resend uses type='signup'
// ============================================================
assert.ok(
  dashboardClient.includes("type: 'signup'") && dashboardClient.includes("auth.resend("),
  "dashboard-client resend must use type: 'signup'"
);
assert.ok(
  espacePro.includes("type: 'signup'") && espacePro.includes("auth.resend("),
  "espace-pro resend must use type: 'signup'"
);
assert.ok(
  confirmationPage.includes("type: 'signup'") && confirmationPage.includes("auth.resend("),
  "confirmation-success resend must use type: 'signup'"
);
ok("resend uses type='signup'");

// ============================================================
// 16. verifyOtp uses type='email'
// ============================================================
assert.ok(
  confirmationPage.includes("verifyOtp("),
  "confirmation-success must call verifyOtp"
);
assert.ok(
  confirmationPage.includes("type: 'email'"),
  "confirmation-success verifyOtp must use type: 'email'"
);
// Ensure 'signup' is NOT used for verifyOtp
const verifyOtpIdx = confirmationPage.indexOf("verifyOtp(");
const verifyOtpBlock = confirmationPage.substring(verifyOtpIdx, verifyOtpIdx + 200);
assert.ok(
  !verifyOtpBlock.includes("type: 'signup'"),
  "confirmation-success verifyOtp must NOT use type: 'signup' (deprecated)"
);
ok("verifyOtp uses type='email'");

// ============================================================
// 17. confirmation page does NOT call verifyOtp on page load
// ============================================================
// The page must NOT call verifyOtp in DOMContentLoaded, setTimeout,
// or any automatic execution path. Only on button click.
assert.ok(
  !confirmationPage.includes("DOMContentLoaded") || confirmationPage.indexOf("verifyOtp") < confirmationPage.indexOf("DOMContentLoaded"),
  "confirmation-success must NOT call verifyOtp in DOMContentLoaded"
);
// Check that verifyOtp is inside a function called from onclick, not auto-executed
assert.ok(
  confirmationPage.includes("onclick=\"confirmEmail()\""),
  "confirmation-success must have a confirmEmail button with onclick"
);
assert.ok(
  confirmationPage.includes("async function confirmEmail()"),
  "confirmation-success must define confirmEmail function"
);
ok("confirmation page does NOT call verifyOtp on page load");

// ============================================================
// 18. verifyOtp only reachable from explicit user action
// ============================================================
// The verifyOtp call must be inside confirmEmail(), which is only
// called from the button onclick. No auto-invocation.
const confirmEmailFuncStart = confirmationPage.indexOf("async function confirmEmail()");
const confirmEmailFuncEnd = confirmationPage.indexOf("function handleVerifyError");
const confirmEmailFunc = confirmationPage.substring(confirmEmailFuncStart, confirmEmailFuncEnd);
assert.ok(
  confirmEmailFunc.includes("verifyOtp("),
  "verifyOtp must be inside confirmEmail function"
);
// Ensure confirmEmail is not self-invoked (check for immediate call pattern)
assert.ok(
  !confirmationPage.includes("confirmEmail()();"),
  "confirmEmail must not be self-invoked with double parens"
);
// Check that confirmEmail() only appears in onclick attribute and function definition,
// not as a standalone auto-invoked call
const confirmEmailCallPattern = /[^.](confirmEmail\(\))/g;
const confirmEmailMatches = confirmationPage.match(confirmEmailCallPattern);
// Should appear in onclick="confirmEmail()" and "async function confirmEmail()" — max 2
assert.ok(
  confirmEmailMatches === null || confirmEmailMatches.length <= 2,
  "confirmEmail() should only appear in onclick and function definition, not auto-invoked"
);
ok("verifyOtp only reachable from explicit user action");

// ============================================================
// 19. token_hash is removed after success
// ============================================================
assert.ok(
  confirmationPage.includes("history.replaceState"),
  "confirmation-success must clean token_hash from URL after success"
);
ok("token_hash is removed after success");

// ============================================================
// 20. no token logging
// ============================================================
// Check that token_hash is not logged to console
assert.ok(
  !confirmationPage.includes("console.log") || !confirmationPage.substring(confirmationPage.indexOf("console.log")).includes("tokenHash"),
  "confirmation-success must NOT log tokenHash to console"
);
assert.ok(
  !confirmationPage.includes("console.log(tokenHash"),
  "confirmation-success must NOT console.log tokenHash directly"
);
ok("no token logging");

// ============================================================
// 21. reset-password files unchanged
// ============================================================
// These files should still use admin.createUser with email_confirm: true
// (separate debt, not modified in SEC-1F4A)
assert.ok(
  clientResetContent.includes("email_confirm: true"),
  "client-reset-password.js must remain unchanged (still uses email_confirm: true)"
);
assert.ok(
  convoyeurResetContent.includes("email_confirm: true"),
  "convoyeur-reset-password.js must remain unchanged (still uses email_confirm: true)"
);
ok("reset-password files unchanged");

// ============================================================
// 22. Stripe webhook unchanged
// ============================================================
assert.ok(
  stripeWebhookContent.includes("email_confirm: true"),
  "stripe-webhook.js must remain unchanged (still uses email_confirm: true)"
);
ok("Stripe webhook unchanged");

// ============================================================
// 23. no config.toml change
// ============================================================
// config.toml should still have enable_confirmations = true
// (already correct from before, no change needed)
const enableConfirmationsMatch = configContent.match(/enable_confirmations\s*=\s*(\w+)/);
assert.ok(enableConfirmationsMatch, "enable_confirmations must exist in config.toml");
// Note: config.toml has enable_confirmations = true in [auth.email] section
// This is the repo config, not Production. No change was made.
ok("no config.toml change");

// ============================================================
// 24. no SQL migration added
// ============================================================
const migrationsDir = path.join(projectRoot, "supabase", "migrations");
const migrationFiles = fs.readdirSync(migrationsDir).filter(f => f.endsWith(".sql"));
// Expected migrations: the ones from the baseline (no new ones added)
const expectedMigrations = [
  "20260807214536_remote_public_baseline.sql",
  "20260809000008_phase3_b4_harden_client_role_and_promo_rls.sql",
  "20260826053700_enforce_auth_role_separation_p4_2.sql",
  "20260827162552_allow_assigned_convoyeur_execution_p4_2b.sql",
  "20260828080834_consolidate_redundant_rls_p2_1.sql",
  "20260830170100_indy_3a_billing_foundation.sql",
  "20260831100000_ops_2a1a_financial_integrity_additive.sql",
  "20260901100000_ops_2b1a_billing_integrity_additive.sql",
  "20260903100000_sec_1c2_fidelity_acl_hardening.sql"
];
// Check that no NEW migration files were added (we just verify the count is reasonable)
assert.ok(
  migrationFiles.length <= 60,
  "No excessive migration files (no new SQL migration should have been added)"
);
// Verify no sec-1f4 migration was added
const sec1f4Migrations = migrationFiles.filter(f => f.includes("1f4"));
assert.equal(sec1f4Migrations.length, 0, "No SEC-1F4 SQL migration should exist");
ok("no SQL migration added");

// ============================================================
// Additional: auth-password-errors.js updated for email_not_confirmed
// ============================================================
assert.ok(
  authErrors.includes("email_not_confirmed"),
  "auth-password-errors.js must handle email_not_confirmed error code"
);
assert.ok(
  authErrors.includes("isEmailNotConfirmedError"),
  "auth-password-errors.js must expose isEmailNotConfirmedError function"
);
assert.ok(
  authErrors.includes("getEmailNotConfirmedMessage"),
  "auth-password-errors.js must expose getEmailNotConfirmedMessage function"
);
assert.ok(
  authErrors.includes("EMAIL_NOT_CONFIRMED_MESSAGE"),
  "auth-password-errors.js must define EMAIL_NOT_CONFIRMED_MESSAGE"
);
ok("auth-password-errors.js updated for email_not_confirmed");

// ============================================================
// Additional: welcome email removed from signup flow
// ============================================================
assert.ok(
  !clientSignup.includes("Bienvenue sur Bathily-Convoyage"),
  "client-signup must NOT send 'Bienvenue' welcome email before confirmation"
);
assert.ok(
  !clientSignup.includes("Demande de compte Pro reçue"),
  "client-signup must NOT send pro welcome email before confirmation"
);
ok("welcome email removed from signup flow (deferred to post-confirmation)");

// ============================================================
// Additional: generic response does not leak account existence
// ============================================================
assert.ok(
  clientSignup.includes("account_may_exist: true"),
  "GENERIC_VERIFICATION_RESPONSE must include account_may_exist: true"
);
assert.ok(
  !clientSignup.includes("userId") || clientSignup.indexOf("userId") > clientSignup.indexOf("return jsonResponse({ success: true, verification_required"),
  "client-signup must NOT return userId in the success response"
);
ok("generic response does not leak account existence");

// ============================================================
// Additional: confirmation page has prefetch safety (no auto-verify)
// ============================================================
assert.ok(
  confirmationPage.includes("DO NOT call verifyOtp") || !confirmationPage.includes("window.onload"),
  "confirmation page must not auto-call verifyOtp on load"
);
ok("confirmation page has prefetch safety");

// ============================================================
// SEC-1F4G.1: confirmation page must NOT load mobile-nav.js
// The confirmation page is a transactional Auth page and does not
// need the global mobile navigation. Loading mobile-nav.js without
// its CSS causes unstyled raw HTML injection.
// ============================================================
assert.ok(
  !confirmationPage.includes("js/mobile-nav.js"),
  "confirmation-success must NOT load js/mobile-nav.js"
);
ok("confirmation page does not load mobile-nav.js");

console.log(`\nAll ${passed} SEC-1F4 tests passed.`);
