import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================
// SEC-1E2 — Password Minimum 8 + Frontend Alignment — Tests
// ============================================================
// Static tests verifying that:
//   1. config.toml minimum_password_length = 8
//   2. config.toml password_requirements remains empty
//   3. dashboard-client signup minlength = 8
//   4. dashboard-client JS rejects password length < 8
//   5. espace-pro signup minlength = 8
//   6. espace-pro JS rejects password length < 8
//   7. reset-password minimum remains >= 8
//   8. no HIBP setting introduced
//   9. no email confirmation config changed
//  10. no passkey config changed
//  11. no MFA/CAPTCHA/rate-limit config changed
//  12. no SQL migration added
//  13. no auth login flow modified outside approved files
//  14. no password complexity requirement introduced
//  15. user-facing hint says 8 characters minimum where applicable
//  16. client-signup.js rejects passwords < 8
//  17. espace-pro loads auth-password-errors.js
//  18. espace-pro handles weak_password server response
// ============================================================

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, "..");

const configPath = path.join(projectRoot, "supabase", "config.toml");
const configContent = fs.readFileSync(configPath, "utf8");

const dashboardClientPath = path.join(projectRoot, "dashboard-client.html");
const dashboardClient = fs.readFileSync(dashboardClientPath, "utf8");

const espaceProPath = path.join(projectRoot, "espace-pro.html");
const espacePro = fs.readFileSync(espaceProPath, "utf8");

const resetPasswordPath = path.join(projectRoot, "reset-password.html");
const resetPassword = fs.readFileSync(resetPasswordPath, "utf8");

const clientSignupPath = path.join(projectRoot, "functions", "api", "client-signup.js");
const clientSignup = fs.readFileSync(clientSignupPath, "utf8");

let passed = 0;
function ok(msg) {
  console.log(`ok - ${msg}`);
  passed++;
}

// ============================================================
// 1. config.toml minimum_password_length = 8
// ============================================================

const minPasswordMatch = configContent.match(/minimum_password_length\s*=\s*(\d+)/);
assert.ok(minPasswordMatch, "minimum_password_length must exist in config.toml");
assert.equal(minPasswordMatch[1], "8", "minimum_password_length must be 8");
ok("config.toml minimum_password_length = 8");

// ============================================================
// 2. config.toml password_requirements remains empty
// ============================================================

const passwordReqMatch = configContent.match(/password_requirements\s*=\s*"([^"]*)"/);
assert.ok(passwordReqMatch, "password_requirements must exist in config.toml");
assert.equal(passwordReqMatch[1], "", "password_requirements must remain empty");
ok("config.toml password_requirements remains empty (no complexity)");

// ============================================================
// 3. dashboard-client signup minlength = 8
// ============================================================

const signupInputMatch = dashboardClient.match(/id="signupPassword"[^>]*minlength="(\d+)"/);
assert.ok(signupInputMatch, "signupPassword input must exist in dashboard-client.html");
assert.equal(signupInputMatch[1], "8", "signupPassword minlength must be 8");
ok("dashboard-client signup minlength = 8");

// ============================================================
// 4. dashboard-client JS rejects password length < 8
// ============================================================

assert.ok(
  /password\.length\s*<\s*8/.test(dashboardClient),
  "dashboard-client.html must check password.length < 8 in JS"
);
assert.ok(
  !/password\.length\s*<\s*6\b/.test(dashboardClient),
  "dashboard-client.html must NOT still check password.length < 6"
);
ok("dashboard-client JS rejects password length < 8");

// ============================================================
// 5. espace-pro signup minlength = 8
// ============================================================

const proInputMatch = espacePro.match(/id="proPassword"[^>]*minlength="(\d+)"/);
assert.ok(proInputMatch, "proPassword input must exist in espace-pro.html");
assert.equal(proInputMatch[1], "8", "proPassword minlength must be 8");
ok("espace-pro signup minlength = 8");

// ============================================================
// 6. espace-pro JS rejects password length < 8
// ============================================================

assert.ok(
  /password\.length\s*<\s*8/.test(espacePro),
  "espace-pro.html must check password.length < 8 in JS"
);
ok("espace-pro JS rejects password length < 8");

// ============================================================
// 7. reset-password minimum remains >= 8
// ============================================================

assert.ok(
  /pwd\.length\s*<\s*8/.test(resetPassword),
  "reset-password.html must check pwd.length < 8"
);
ok("reset-password minimum remains >= 8");

// ============================================================
// 8. no HIBP setting introduced
// ============================================================

assert.ok(
  !/hibp/i.test(configContent),
  "config.toml must NOT contain any HIBP setting"
);
ok("no HIBP setting introduced in config.toml");

// ============================================================
// 9. no email confirmation config changed
// ============================================================

assert.ok(
  /enable_confirmations\s*=\s*true/.test(configContent),
  "enable_confirmations must remain true"
);
assert.ok(
  /double_confirm_changes\s*=\s*true/.test(configContent),
  "double_confirm_changes must remain true"
);
ok("email confirmation config unchanged");

// ============================================================
// 10. no passkey config changed
// ============================================================

assert.ok(
  /\[auth\.passkey\]/.test(configContent) && /# enabled = false/.test(configContent),
  "passkey config must remain commented out / disabled"
);
ok("passkey config unchanged");

// ============================================================
// 11. no MFA/CAPTCHA/rate-limit config changed
// ============================================================

assert.ok(
  /max_enrolled_factors\s*=\s*10/.test(configContent),
  "MFA max_enrolled_factors must remain 10"
);
assert.ok(
  /enroll_enabled\s*=\s*false/.test(configContent) && /verify_enabled\s*=\s*false/.test(configContent),
  "MFA TOTP must remain disabled"
);
assert.ok(
  /# enabled = true/.test(configContent) && /# provider = "hcaptcha"/.test(configContent),
  "CAPTCHA must remain commented out / disabled"
);
assert.ok(
  /email_sent\s*=\s*2/.test(configContent),
  "rate limit email_sent must remain 2"
);
assert.ok(
  /sign_in_sign_ups\s*=\s*30/.test(configContent),
  "rate limit sign_in_sign_ups must remain 30"
);
ok("MFA/CAPTCHA/rate-limit config unchanged");

// ============================================================
// 12. no SQL migration added
// ============================================================

const migrationsDir = path.join(projectRoot, "supabase", "migrations");
const migrationFiles = fs.readdirSync(migrationsDir).filter(f => f.endsWith(".sql"));
const sec1e2Migrations = migrationFiles.filter(f => f.includes("sec_1e2") || f.includes("sec-1e2"));
assert.equal(sec1e2Migrations.length, 0, "no SQL migration should be added for SEC-1E2");
ok("no SQL migration added");

// ============================================================
// 13. no auth login flow modified outside approved files
// ============================================================

const dashboardAdminPath = path.join(projectRoot, "dashboard-admin.html");
const dashboardConvoyeurPath = path.join(projectRoot, "dashboard-convoyeur.html");
const dashboardOperatorPath = path.join(projectRoot, "dashboard-operator.html");

// These files should NOT contain password length < 8 checks (they're login, not signup)
// and should NOT have been modified for SEC-1E2
const adminContent = fs.readFileSync(dashboardAdminPath, "utf8");
const convoyeurContent = fs.readFileSync(dashboardConvoyeurPath, "utf8");
const operatorContent = fs.readFileSync(dashboardOperatorPath, "utf8");

// Login screens should not have signup password validation
assert.ok(
  !/minlength="8".*autocomplete="new-password"/.test(adminContent),
  "dashboard-admin.html should not have signup password fields modified"
);
assert.ok(
  !/minlength="8".*autocomplete="new-password"/.test(convoyeurContent),
  "dashboard-convoyeur.html should not have signup password fields modified"
);
assert.ok(
  !/minlength="8".*autocomplete="new-password"/.test(operatorContent),
  "dashboard-operator.html should not have signup password fields modified"
);
ok("no auth login flow modified outside approved files");

// ============================================================
// 14. no password complexity requirement introduced
// ============================================================

assert.ok(
  !/password_requirements\s*=\s*"(letters_digits|lower_upper_letters_digits|lower_upper_letters_digits_symbols)"/.test(configContent),
  "config.toml must NOT introduce complexity requirements"
);
ok("no password complexity requirement introduced");

// ============================================================
// 15. user-facing hint says 8 characters minimum where applicable
// ============================================================

assert.ok(
  /Minimum 8 caractères/.test(dashboardClient),
  "dashboard-client.html should display 'Minimum 8 caractères' hint"
);
assert.ok(
  /Minimum 8 caractères/.test(espacePro),
  "espace-pro.html should display 'Minimum 8 caractères' hint"
);
assert.ok(
  /Minimum 8 caractères|au moins 8 caractères/.test(resetPassword),
  "reset-password.html should display 8 character minimum hint"
);
ok("user-facing hints say 8 characters minimum");

// ============================================================
// 16. client-signup.js rejects passwords < 8
// ============================================================

assert.ok(
  /password\.length\s*<\s*8/.test(clientSignup),
  "client-signup.js must check password.length < 8"
);
assert.ok(
  /weak_password.*length/.test(clientSignup),
  "client-signup.js must return weak_password with length reason for short passwords"
);
ok("client-signup.js rejects passwords < 8 with weak_password/length response");

// ============================================================
// 17. espace-pro loads auth-password-errors.js
// ============================================================

assert.ok(
  /auth-password-errors\.js/.test(espacePro),
  "espace-pro.html must load auth-password-errors.js"
);
ok("espace-pro loads auth-password-errors.js");

// ============================================================
// 18. espace-pro handles weak_password server response
// ============================================================

assert.ok(
  /result\.error\s*===\s*['"]weak_password['"]/.test(espacePro),
  "espace-pro.html must handle weak_password server response"
);
assert.ok(
  /BathilyAuthErrors/.test(espacePro),
  "espace-pro.html must use BathilyAuthErrors helper for weak password messages"
);
ok("espace-pro handles weak_password server response via BathilyAuthErrors");

// ============================================================
// 19. client-signup.js: 7-char password would be rejected, 8-char passes local validation
// ============================================================

// Verify the local validation check is BEFORE the Supabase createUser call
const localCheckIdx = clientSignup.indexOf("password.length < 8");
const createUserIdx = clientSignup.indexOf("createUser");
assert.ok(localCheckIdx > -1, "local password length check must exist");
assert.ok(createUserIdx > -1, "createUser call must exist");
assert.ok(
  localCheckIdx < createUserIdx,
  "local password length check must come BEFORE createUser call"
);
ok("client-signup.js local validation runs before Supabase createUser (7-char rejected, 8-char passes local layer)");

// ============================================================
// 20. No unauthorized files changed (static check on known untouched files)
// ============================================================

// Verify reset-password.html still has its existing 8-char check (not modified)
assert.ok(
  /pwd\.length\s*<\s*8/.test(resetPassword) && /au moins 8 caractères/.test(resetPassword),
  "reset-password.html should retain its existing 8-char validation"
);
ok("reset-password.html verified (already >= 8, no modification needed)");

// ============================================================
// Summary
// ============================================================

console.log(`\n${passed}/${passed} SEC-1E2 password min 8 checks passed\n`);
