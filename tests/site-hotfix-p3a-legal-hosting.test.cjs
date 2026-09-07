/**
 * SITE-HOTFIX-P3-A — Mentions légales hosting info regression test.
 *
 * Verifies that mentions-legales.html no longer identifies Netlify as the
 * active host and instead accurately references Cloudflare / Cloudflare Pages,
 * while preserving the hosting section structure and not introducing malformed
 * external links.
 *
 * Context:
 *   Production hosting was migrated from Netlify to Cloudflare Pages
 *   (see MIGRATION-CLOUDFLARE.md). The legal notice still stated Netlify.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const legalPath = path.join(repoRoot, 'mentions-legales.html');
const legal = fs.readFileSync(legalPath, 'utf8');

// =========================================================
// Hosting section presence & structure
// =========================================================

test('hosting section ("Hébergeur du site") remains present', () => {
  assert.ok(/Hébergeur du site/.test(legal), 'hosting section heading present');
});

test('hosting section still names a hosting provider entity line', () => {
  // The structure should keep an entity line (Cloudflare, Inc.) after the heading.
  const section = legal.match(/Hébergeur du site[\s\S]*?<h3>/);
  assert.ok(section, 'hosting section block found before next h3');
  assert.ok(/Cloudflare, Inc\./.test(section[0]), 'hosting entity line present');
});

test('hosting section still has a website link', () => {
  const section = legal.match(/Hébergeur du site[\s\S]*?<h3>/);
  assert.ok(section, 'hosting section block found');
  assert.ok(/Site Web :/.test(section[0]), 'website label preserved');
  assert.ok(/<a href="https:\/\/www\.cloudflare\.com"/.test(section[0]), 'cloudflare.com link present');
});

// =========================================================
// Netlify no longer referenced as active host
// =========================================================

test('mentions-legales.html does NOT mention Netlify as the active host', () => {
  // The hosting section must not reference Netlify. We check the whole document
  // for the hosting context to be safe, but the strongest signal is that
  // "Netlify" no longer appears in the hosting section.
  const section = legal.match(/Hébergeur du site[\s\S]*?<h3>/);
  assert.ok(section, 'hosting section block found');
  assert.ok(!/Netlify/i.test(section[0]), 'hosting section must not mention Netlify');
});

test('mentions-legales.html does NOT list the old Netlify address', () => {
  // Guard against a stale copy/paste of the old Netlify postal address.
  assert.ok(
    !/44 Tehama Street/.test(legal),
    'old Netlify postal address must be removed',
  );
});

// =========================================================
// Cloudflare / Cloudflare Pages accurately identified
// =========================================================

test('hosting section mentions Cloudflare', () => {
  const section = legal.match(/Hébergeur du site[\s\S]*?<h3>/);
  assert.ok(section, 'hosting section block found');
  assert.ok(/Cloudflare/.test(section[0]), 'hosting section mentions Cloudflare');
});

test('hosting section mentions Cloudflare Pages platform', () => {
  const section = legal.match(/Hébergeur du site[\s\S]*?<h3>/);
  assert.ok(section, 'hosting section block found');
  assert.ok(/Cloudflare Pages/.test(section[0]), 'hosting section mentions Cloudflare Pages');
});

// =========================================================
// No malformed external link
// =========================================================

test('hosting section external link is well-formed (https + cloudflare.com + noopener)', () => {
  const section = legal.match(/Hébergeur du site[\s\S]*?<h3>/);
  assert.ok(section, 'hosting section block found');
  assert.ok(
    /<a href="https:\/\/www\.cloudflare\.com" target="_blank" rel="noopener"/.test(section[0]),
    'hosting link is a well-formed https link to cloudflare.com with rel=noopener',
  );
});

test('hosting section contains the verified Cloudflare, Inc. entity line', () => {
  const section = legal.match(/Hébergeur du site[\s\S]*?<h3>/);
  assert.ok(section, 'hosting section block found');
  assert.ok(/Cloudflare, Inc\./.test(section[0]), 'hosting section names Cloudflare, Inc.');
});

test('hosting section contains the verified Cloudflare street address (101 Townsend)', () => {
  const section = legal.match(/Hébergeur du site[\s\S]*?<h3>/);
  assert.ok(section, 'hosting section block found');
  assert.ok(/101 Townsend/.test(section[0]), 'hosting section contains 101 Townsend St');
});

test('hosting section contains the verified Cloudflare city/state/zip (San Francisco, CA 94107)', () => {
  const section = legal.match(/Hébergeur du site[\s\S]*?<h3>/);
  assert.ok(section, 'hosting section block found');
  assert.ok(/San Francisco/.test(section[0]), 'hosting section contains San Francisco');
  assert.ok(/CA 94107/.test(section[0]), 'hosting section contains CA 94107');
});

test('hosting section contains the verified Cloudflare phone (+1 (650) 319-8930)', () => {
  const section = legal.match(/Hébergeur du site[\s\S]*?<h3>/);
  assert.ok(section, 'hosting section block found');
  assert.ok(
    /\+1 \(650\) 319-8930/.test(section[0]),
    'hosting section contains the official Cloudflare phone number',
  );
});

test('hosting section does NOT add a Cloudflare France address or French subsidiary', () => {
  // Per hotfix scope: only the Cloudflare, Inc. principal office is named.
  // No French subsidiary or France-specific address should be introduced.
  const section = legal.match(/Hébergeur du site[\s\S]*?<h3>/);
  assert.ok(section, 'hosting section block found');
  assert.ok(!/Cloudflare France/i.test(section[0]), 'no Cloudflare France entity introduced');
  assert.ok(
    !/Portugal|DSA|représentant/i.test(section[0]),
    'no Portugal DSA representative introduced',
  );
});
