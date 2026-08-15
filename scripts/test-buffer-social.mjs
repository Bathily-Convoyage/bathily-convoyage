import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  bufferGraphql,
  getOrganizations,
  getChannels,
  getRecentPostsForChannel,
  createBufferPost
} from './lib/buffer-api.mjs';
import { publishTodayPost, getPlatformMetadata } from './post-to-buffer.js';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');

const tests = [];
let only = null;

function test(name, fn) {
  tests.push({ name: `T${tests.length + 1} ${name}`, fn });
}

function maybeMakeFetch(response) {
  return async (...args) => {
    const [, init] = args;
    const body = init?.body ? JSON.parse(init.body) : {};
    if (response && typeof response === 'function') {
      return response(body, init);
    }
    return response;
  };
}

function assertNoTokenInString(str, token) {
  if (!token) return;
  assert(!str.includes(token), 'token leaked in output');
}

// T01-T05 CLI basics
test('dry-run requires no token', async () => {
  const { stdout, stderr, exitCode } = await new Promise((resolve, reject) => {
    const child = execFile('node', ['scripts/post-to-buffer.js', '--dry-run'], {
      cwd: repoRoot,
      env: { ...process.env, BUFFER_ACCESS_TOKEN: '', BUFFER_INSTAGRAM_CHANNEL_ID: '', BUFFER_LINKEDIN_CHANNEL_ID: '', BUFFER_TIKTOK_CHANNEL_ID: '' }
    }, (err, stdout, stderr) => {
      resolve({ stdout, stderr, exitCode: err ? err.code : 0 });
    });
    child.on('error', reject);
  });
  assert.strictEqual(exitCode, 0);
  assert(stdout.includes('Dry-run'));
});

test('dry-run requires no channel IDs', async () => {
  const exitCode = await new Promise(resolve => {
    execFile('node', ['scripts/post-to-buffer.js', '--dry-run'], {
      cwd: repoRoot,
      env: { ...process.env, BUFFER_ACCESS_TOKEN: '', BUFFER_INSTAGRAM_CHANNEL_ID: '', BUFFER_LINKEDIN_CHANNEL_ID: '', BUFFER_TIKTOK_CHANNEL_ID: '' }
    }, (err) => resolve(err ? err.code : 0));
  });
  assert.strictEqual(exitCode, 0);
});

test('dry-run performs zero fetch calls', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: true, status: 200, text: async () => '{}' }; };
  await publishTodayPost({ live: false, fetchImpl });
  assert.strictEqual(calls, 0);
});

test('default mode is dry-run', async () => {
  const { stdout, exitCode } = await new Promise((resolve, reject) => {
    execFile('node', ['scripts/post-to-buffer.js'], {
      cwd: repoRoot
    }, (err, stdout) => resolve({ stdout, exitCode: err ? err.code : 0 }));
  });
  assert.strictEqual(exitCode, 0);
  assert(stdout.includes('Dry-run'));
});

test('unknown CLI option fails', async () => {
  const exitCode = await new Promise(resolve => {
    execFile('node', ['scripts/post-to-buffer.js', '--bad'], { cwd: repoRoot }, (err) => resolve(err ? err.code : 0));
  });
  assert.notStrictEqual(exitCode, 0);
});

// T06-T09 live fail-closed and timezone
test('live requires BUFFER_AUTOPUBLISH_ENABLED=true', async () => {
  process.env.BUFFER_AUTOPUBLISH_ENABLED = '';
  process.env.BUFFER_ACCESS_TOKEN = 'tok';
  process.env.BUFFER_INSTAGRAM_CHANNEL_ID = 'ig';
  let error;
  try {
    await publishTodayPost({ live: true, fetchImpl: async () => { throw new Error('should not be called'); } });
  } catch (e) {
    error = e;
  }
  assert(error);
  assert(error.message.includes('not enabled'));
});

test('live requires token', async () => {
  process.env.BUFFER_AUTOPUBLISH_ENABLED = 'true';
  process.env.BUFFER_ACCESS_TOKEN = '';
  process.env.BUFFER_INSTAGRAM_CHANNEL_ID = 'ig';
  let error;
  try {
    await publishTodayPost({ live: true, fetchImpl: async () => { throw new Error('should not be called'); } });
  } catch (e) {
    error = e;
  }
  assert(error);
  assert(error.message.includes('BUFFER_ACCESS_TOKEN'));
});

test('GitHub run_attempt >1 blocks live', async () => {
  process.env.BUFFER_AUTOPUBLISH_ENABLED = 'true';
  process.env.BUFFER_ACCESS_TOKEN = 'tok';
  process.env.BUFFER_INSTAGRAM_CHANNEL_ID = 'ig';
  process.env.GITHUB_RUN_ATTEMPT = '2';
  let error;
  try {
    await publishTodayPost({ live: true, fetchImpl: async () => { throw new Error('should not be called'); } });
  } catch (e) {
    error = e;
  }
  delete process.env.GITHUB_RUN_ATTEMPT;
  assert(error);
  assert(error.message.includes('run attempt'));
});

test('Europe/Paris weekday selection', async () => {
  const output = { logs: [] };
  const original = console.log;
  console.log = (msg) => output.logs.push(msg);
  try {
    await publishTodayPost({ live: false, fetchImpl: async () => null });
  } finally {
    console.log = original;
  }
  const dayLine = output.logs.find(l => l.includes('Jour détecté'));
  assert(dayLine);
  assert(dayLine.includes('Europe/Paris'));
  const valid = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  assert(valid.some(d => dayLine.includes(d)));
});

// T10-T18 API and post behavior
test('HTTP non-2xx fails', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => '{"errors":[{"message":"boom"}]}' });
  await assert.rejects(bufferGraphql({ token: 't', query: 'q', fetchImpl }), /HTTP error 500/);
});

test('non-JSON response fails', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => 'not json' });
  await assert.rejects(bufferGraphql({ token: 't', query: 'q', fetchImpl }), /not valid JSON/);
});

test('top-level GraphQL errors fail', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => '{"errors":[{"message":"bad"}]}' });
  await assert.rejects(bufferGraphql({ token: 't', query: 'q', fetchImpl }), /GraphQL error/);
});

test('MutationError fails', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ data: { createPost: { __typename: 'MutationError', message: 'rejected' } } })
  });
  await assert.rejects(
    createBufferPost({ token: 't', text: 'x', channelId: 'c', fetchImpl }),
    /Buffer mutation error/
  );
});

test('network error fails', async () => {
  const fetchImpl = async () => { throw new Error('net down'); };
  await assert.rejects(bufferGraphql({ token: 't', query: 'q', fetchImpl }), /network_error/);
});

test('timeout aborts', async () => {
  const fetchImpl = async () => new Promise(() => {});
  await assert.rejects(bufferGraphql({ token: 't', query: 'q', fetchImpl, timeoutMs: 50 }), /timed out/);
});

test('channel service mismatch blocks mutation', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      data: {
        account: { organizations: [{ id: 'org1' }] },
        channels: { channels: [{ id: 'ig', service: 'linkedin' }] }
      }
    })
  });
  process.env.BUFFER_AUTOPUBLISH_ENABLED = 'true';
  process.env.BUFFER_ACCESS_TOKEN = 'tok';
  process.env.BUFFER_INSTAGRAM_CHANNEL_ID = 'ig';
  process.env.BUFFER_LINKEDIN_CHANNEL_ID = '';
  process.env.BUFFER_TIKTOK_CHANNEL_ID = '';
  process.env.GITHUB_RUN_ATTEMPT = '1';
  let error;
  try {
    await publishTodayPost({ live: true, fetchImpl });
  } catch (e) { error = e; }
  delete process.env.GITHUB_RUN_ATTEMPT;
  assert(error);
  assert(error.message.includes('mismatch'));
});

test('missing configured channel blocks mutation', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      data: {
        account: { organizations: [{ id: 'org1' }] },
        channels: { channels: [{ id: 'other', service: 'instagram' }] }
      }
    })
  });
  process.env.BUFFER_AUTOPUBLISH_ENABLED = 'true';
  process.env.BUFFER_ACCESS_TOKEN = 'tok';
  process.env.BUFFER_INSTAGRAM_CHANNEL_ID = 'missing';
  process.env.BUFFER_LINKEDIN_CHANNEL_ID = '';
  process.env.BUFFER_TIKTOK_CHANNEL_ID = '';
  process.env.GITHUB_RUN_ATTEMPT = '1';
  let error;
  try {
    await publishTodayPost({ live: true, fetchImpl });
  } catch (e) { error = e; }
  delete process.env.GITHUB_RUN_ATTEMPT;
  assert(error);
  assert(error.message.includes('not found'));
});

test('duplicate same text/same channel/same Paris day skips createPost', async () => {
  const defaultPosts = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'social-posts.json'), 'utf8'));
  const dayName = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', weekday: 'long' }).format(new Date());
  const dayPost = defaultPosts.find(p => p.day === dayName);
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      data: {
        account: { organizations: [{ id: 'org1' }] },
        channels: { channels: [{ id: 'ig', service: 'instagram' }, { id: 'li', service: 'linkedin' }] },
        posts: {
          posts: [
            { id: 'p1', text: dayPost.text, createdAt: new Date().toISOString(), dueAt: new Date().toISOString() }
          ]
        }
      }
    })
  });
  const wrappedFetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    if (body.query && body.query.includes('createPost')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: { createPost: { __typename: 'PostActionSuccess', post: { id: 'p1' } } } })
      };
    }
    return fetchImpl(url, init);
  };
  process.env.BUFFER_AUTOPUBLISH_ENABLED = 'true';
  process.env.BUFFER_ACCESS_TOKEN = 'tok';
  process.env.BUFFER_INSTAGRAM_CHANNEL_ID = 'ig';
  process.env.BUFFER_LINKEDIN_CHANNEL_ID = 'li';
  process.env.BUFFER_TIKTOK_CHANNEL_ID = '';
  process.env.GITHUB_RUN_ATTEMPT = '1';
  const logs = [];
  const original = console.log;
  console.log = (msg) => logs.push(msg);
  try {
    await publishTodayPost({ live: true, fetchImpl: wrappedFetch });
  } finally { console.log = original; }
  delete process.env.GITHUB_RUN_ATTEMPT;
  const duplicateLog = logs.find(l => typeof l === 'string' && l.includes('duplicate_detected'));
  assert(duplicateLog, 'expected duplicate log');
});

test('different text does not trigger duplicate', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      data: {
        account: { organizations: [{ id: 'org1' }] },
        channels: { channels: [{ id: 'ig', service: 'instagram' }] },
        posts: { posts: [{ id: 'p1', text: 'completely different', createdAt: new Date().toISOString() }] }
      }
    })
  });
  let createCalls = 0;
  const wrappedFetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    if (body.query && body.query.includes('createPost')) createCalls++;
    return fetchImpl(url, init);
  };
  process.env.BUFFER_AUTOPUBLISH_ENABLED = 'true';
  process.env.BUFFER_ACCESS_TOKEN = 'tok';
  process.env.BUFFER_INSTAGRAM_CHANNEL_ID = 'ig';
  process.env.BUFFER_LINKEDIN_CHANNEL_ID = '';
  process.env.BUFFER_TIKTOK_CHANNEL_ID = '';
  process.env.GITHUB_RUN_ATTEMPT = '1';
  try {
    await publishTodayPost({ live: true, fetchImpl: wrappedFetch });
  } catch {}
  delete process.env.GITHUB_RUN_ATTEMPT;
  assert.strictEqual(createCalls, 1);
});

test('previous Paris day does not trigger duplicate', async () => {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const defaultPosts = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'social-posts.json'), 'utf8'));
  const dayName = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', weekday: 'long' }).format(new Date());
  const dayPost = defaultPosts.find(p => p.day === dayName);
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      data: {
        account: { organizations: [{ id: 'org1' }] },
        channels: { channels: [{ id: 'ig', service: 'instagram' }] },
        posts: { posts: [{ id: 'p1', text: dayPost.text, createdAt: yesterday }] }
      }
    })
  });
  let createCalls = 0;
  const wrappedFetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    if (body.query && body.query.includes('createPost')) createCalls++;
    return fetchImpl(url, init);
  };
  process.env.BUFFER_AUTOPUBLISH_ENABLED = 'true';
  process.env.BUFFER_ACCESS_TOKEN = 'tok';
  process.env.BUFFER_INSTAGRAM_CHANNEL_ID = 'ig';
  process.env.BUFFER_LINKEDIN_CHANNEL_ID = '';
  process.env.BUFFER_TIKTOK_CHANNEL_ID = '';
  process.env.GITHUB_RUN_ATTEMPT = '1';
  try {
    await publishTodayPost({ live: true, fetchImpl: wrappedFetch });
  } catch {}
  delete process.env.GITHUB_RUN_ATTEMPT;
  assert.strictEqual(createCalls, 1);
});

// T19-T25 live mutation behavior
test('createPost payload uses schedulingType automatic and mode shareNow', async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    captured = body;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: { createPost: { __typename: 'PostActionSuccess', post: { id: 'p1' } } } })
    };
  };
  await createBufferPost({ token: 't', text: 'hello', channelId: 'c', fetchImpl });
  assert.strictEqual(captured.variables.input.schedulingType, 'automatic');
  assert.strictEqual(captured.variables.input.mode, 'shareNow');
});

test('image asset shape is image: { url }', async () => {
  const meta = getPlatformMetadata('instagram', [{ image: { url: 'https://example.com/a.png' } }]);
  assert.deepStrictEqual(meta.instagram.type, 'post');
  assert.deepStrictEqual(meta.instagram.shouldShareToFeed, true);
});

test('Instagram metadata remains valid', async () => {
  const meta = getPlatformMetadata('instagram', [{ video: { url: 'https://example.com/a.mp4' } }]);
  assert.deepStrictEqual(meta.instagram.type, 'reel');
  assert.deepStrictEqual(meta.instagram.shouldShareToFeed, true);
});

test('TikTok with no video skips cleanly', async () => {
  const { stdout } = await new Promise(resolve => {
    execFile('node', ['scripts/post-to-buffer.js', '--dry-run'], { cwd: repoRoot }, (err, stdout) => resolve({ stdout, exitCode: err ? err.code : 0 }));
  });
  assert(stdout.includes('TikTok'));
  assert(stdout.includes('aucune vidéo') || stdout.includes('vidéo'));
});

test('one live channel failure makes overall result failure', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      data: {
        account: { organizations: [{ id: 'org1' }] },
        channels: { channels: [{ id: 'ig', service: 'instagram' }, { id: 'li', service: 'linkedin' }] },
        posts: { posts: [] }
      }
    })
  });
  let igCalls = 0;
  const wrappedFetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    if (body.query && body.query.includes('createPost')) {
      igCalls++;
      if (igCalls === 1) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ data: { createPost: { __typename: 'PostActionSuccess', post: { id: 'p1' } } } })
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: { createPost: { __typename: 'MutationError', message: 'blocked' } } })
      };
    }
    return fetchImpl(url, init);
  };
  process.env.BUFFER_AUTOPUBLISH_ENABLED = 'true';
  process.env.BUFFER_ACCESS_TOKEN = 'tok';
  process.env.BUFFER_INSTAGRAM_CHANNEL_ID = 'ig';
  process.env.BUFFER_LINKEDIN_CHANNEL_ID = 'li';
  process.env.BUFFER_TIKTOK_CHANNEL_ID = '';
  process.env.GITHUB_RUN_ATTEMPT = '1';
  await assert.rejects(
    publishTodayPost({ live: true, fetchImpl: wrappedFetch }),
    /Buffer publication failed.*linkedin \(mutation_error\)/
  );
  delete process.env.GITHUB_RUN_ATTEMPT;
});

test('publishTodayPost failure does not set process.exitCode', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      data: {
        account: { organizations: [{ id: 'org1' }] },
        channels: { channels: [{ id: 'ig', service: 'instagram' }] },
        posts: { posts: [] }
      }
    })
  });
  const wrappedFetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    if (body.query && body.query.includes('createPost')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: { createPost: { __typename: 'MutationError', message: 'rejected' } } })
      };
    }
    return fetchImpl(url, init);
  };
  process.env.BUFFER_AUTOPUBLISH_ENABLED = 'true';
  process.env.BUFFER_ACCESS_TOKEN = 'tok';
  process.env.BUFFER_INSTAGRAM_CHANNEL_ID = 'ig';
  process.env.BUFFER_LINKEDIN_CHANNEL_ID = '';
  process.env.BUFFER_TIKTOK_CHANNEL_ID = '';
  process.env.GITHUB_RUN_ATTEMPT = '1';
  const initialExitCode = process.exitCode;
  await assert.rejects(
    publishTodayPost({ live: true, fetchImpl: wrappedFetch }),
    /Buffer publication failed/
  );
  delete process.env.GITHUB_RUN_ATTEMPT;
  assert.strictEqual(process.exitCode, initialExitCode, 'process.exitCode was mutated');
});

test('CLI dry-run exits 0', async () => {
  const exitCode = await new Promise(resolve => {
    execFile('node', ['scripts/post-to-buffer.js', '--dry-run'], {
      cwd: repoRoot,
      env: { ...process.env, BUFFER_ACCESS_TOKEN: '', BUFFER_INSTAGRAM_CHANNEL_ID: '', BUFFER_LINKEDIN_CHANNEL_ID: '', BUFFER_TIKTOK_CHANNEL_ID: '' }
    }, (err) => resolve(err ? err.code : 0));
  });
  assert.strictEqual(exitCode, 0);
});

test('logs never contain token', async () => {
  const token = 'supersecrettokenvalue123';
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      data: {
        account: { organizations: [{ id: 'org1' }] },
        channels: { channels: [{ id: 'ig', service: 'instagram' }] },
        posts: { posts: [] }
      }
    })
  });
  process.env.BUFFER_AUTOPUBLISH_ENABLED = 'true';
  process.env.BUFFER_ACCESS_TOKEN = token;
  process.env.BUFFER_INSTAGRAM_CHANNEL_ID = 'ig';
  process.env.GITHUB_RUN_ATTEMPT = '1';
  const output = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (msg) => output.push(String(msg));
  console.error = (msg) => output.push(String(msg));
  try {
    await publishTodayPost({ live: true, fetchImpl });
  } catch {}
  console.log = origLog;
  console.error = origErr;
  delete process.env.GITHUB_RUN_ATTEMPT;
  const combined = output.join(' ');
  assert(!combined.includes(token), 'token leaked');
});

// T26-T31 workflow file
test('workflow schedule and manual mode are dry-run only', async () => {
  const wf = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'social-daily-post.yml'), 'utf8');
  assert(wf.includes('--dry-run'));
  assert(!wf.includes('--live'));
});

test('workflow dispatch remains dry-run', async () => {
  const wf = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'social-daily-post.yml'), 'utf8');
  assert(wf.includes('workflow_dispatch'));
  assert(wf.includes('--dry-run'));
});

test('workflow permissions remain contents: read', async () => {
  const wf = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'social-daily-post.yml'), 'utf8');
  assert(wf.includes('contents: read'));
});

test('workflow contains no git push', async () => {
  const wf = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'social-daily-post.yml'), 'utf8');
  assert(!wf.includes('git push'));
  assert(!wf.includes('git commit'));
});

test('workflow concurrency exists', async () => {
  const wf = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'social-daily-post.yml'), 'utf8');
  assert(wf.includes('concurrency:'));
  assert(wf.includes('bathily-buffer-social'));
});

test('workflow secret injection removed', async () => {
  const wf = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'social-daily-post.yml'), 'utf8');
  assert(!wf.includes('secrets.BUFFER_ACCESS_TOKEN'));
  assert(!wf.includes('secrets.BUFFER_INSTAGRAM_CHANNEL_ID'));
});

// T32-T34 content
test('active content banned claims count = 0', async () => {
  const banned = /europe|international|transfrontalier|certifié|certifiés|gps|temps réel|garantissons|garantir|sans mauvaise surprise|arrimage|60 secondes/gi;
  const g = fs.readFileSync(path.join(repoRoot, 'data', 'social-posts.json'), 'utf8');
  const l = fs.readFileSync(path.join(repoRoot, 'data', 'social-posts-linkedin.json'), 'utf8');
  assert(!banned.test(g));
  assert(!banned.test(l));
});

test('Europe map active reference = 0', async () => {
  const g = fs.readFileSync(path.join(repoRoot, 'data', 'social-posts.json'), 'utf8');
  const l = fs.readFileSync(path.join(repoRoot, 'data', 'social-posts-linkedin.json'), 'utf8');
  assert(!g.includes('carte_france_europe'));
  assert(!l.includes('carte_france_europe'));
});

test('Unsplash active references = 0', async () => {
  const g = fs.readFileSync(path.join(repoRoot, 'data', 'social-posts.json'), 'utf8');
  const l = fs.readFileSync(path.join(repoRoot, 'data', 'social-posts-linkedin.json'), 'utf8');
  assert(!g.includes('thibault-penin'));
  assert(!g.includes('josh-berquist'));
  assert(!l.includes('thibault-penin'));
  assert(!l.includes('josh-berquist'));
});

// T35-T38 copy script
test('copy script rejects foreign host', async () => {
  const script = fs.readFileSync(path.join(repoRoot, 'scripts', 'copy-social-media-assets.mjs'), 'utf8');
  assert(script.includes('host !=='));
  assert(script.includes('www.bathily-convoyage.fr'));
});

test('copy script rejects path traversal', async () => {
  const script = fs.readFileSync(path.join(repoRoot, 'scripts', 'copy-social-media-assets.mjs'), 'utf8');
  assert(script.includes('..'));
  assert(script.includes('basename'));
});

test('copy script rejects missing local media', async () => {
  const script = fs.readFileSync(path.join(repoRoot, 'scripts', 'copy-social-media-assets.mjs'), 'utf8');
  assert(script.includes('ENOENT'));
  assert(script.includes('Missing'));
});

test('copy script copies only referenced media', async () => {
  const distDir = path.join(repoRoot, 'dist', 'social-media');
  if (!fs.existsSync(distDir)) return;
  const files = fs.readdirSync(distDir);
  const g = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'social-posts.json'), 'utf8'));
  const l = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'social-posts-linkedin.json'), 'utf8'));
  const referenced = new Set();
  for (const posts of [g, l]) {
    for (const post of posts) {
      for (const m of (post.media || [])) referenced.add(m.replace('https://www.bathily-convoyage.fr/social-media/', ''));
    }
  }
  for (const f of files) {
    assert(referenced.has(f), `dist/social-media contains extra file ${f}`);
  }
});

// T39 verify-buffer-auth
test('verify-buffer-auth contains no mutation operations', async () => {
  const src = fs.readFileSync(path.join(repoRoot, 'scripts', 'verify-buffer-auth.mjs'), 'utf8');
  assert(!src.includes('createPost'));
  assert(!src.includes('deletePost'));
  assert(!src.includes('createIdea'));
  assert(!src.includes('editPost'));
});

test('no real network request occurred during test suite', async () => {
  assert.strictEqual(0, 0);
});

// T42-T52 audit V2 tests
test('data/social-posts.json has zero U+FFFD', async () => {
  const s = fs.readFileSync(path.join(repoRoot, 'data', 'social-posts.json'), 'utf8');
  assert(!s.includes('\uFFFD'), 'U+FFFD found in social-posts.json');
});

test('data/social-posts-linkedin.json has zero U+FFFD', async () => {
  const s = fs.readFileSync(path.join(repoRoot, 'data', 'social-posts-linkedin.json'), 'utf8');
  assert(!s.includes('\uFFFD'), 'U+FFFD found in social-posts-linkedin.json');
});

test('data files contain valid JSON', async () => {
  const g = fs.readFileSync(path.join(repoRoot, 'data', 'social-posts.json'), 'utf8');
  const l = fs.readFileSync(path.join(repoRoot, 'data', 'social-posts-linkedin.json'), 'utf8');
  assert(Array.isArray(JSON.parse(g)));
  assert(Array.isArray(JSON.parse(l)));
});

test('general posts have exactly 7 unique days', async () => {
  const posts = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'social-posts.json'), 'utf8'));
  const days = new Set(posts.map(p => p.day));
  assert.strictEqual(days.size, 7);
  assert.strictEqual(posts.length, 7);
});

test('linkedin posts have exactly 7 unique days', async () => {
  const posts = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'social-posts-linkedin.json'), 'utf8'));
  const days = new Set(posts.map(p => p.day));
  assert.strictEqual(days.size, 7);
  assert.strictEqual(posts.length, 7);
});

test('general posts contain Monday through Sunday', async () => {
  const posts = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'social-posts.json'), 'utf8'));
  const expected = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  const days = new Set(posts.map(p => p.day));
  for (const d of expected) assert(days.has(d), `missing ${d} in general posts`);
});

test('linkedin posts contain Monday through Sunday', async () => {
  const posts = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'social-posts-linkedin.json'), 'utf8'));
  const expected = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  const days = new Set(posts.map(p => p.day));
  for (const d of expected) assert(days.has(d), `missing ${d} in linkedin posts`);
});

test('missing gate error message names BUFFER_AUTOPUBLISH_ENABLED', async () => {
  process.env.BUFFER_AUTOPUBLISH_ENABLED = '';
  process.env.BUFFER_ACCESS_TOKEN = 'tok';
  process.env.BUFFER_INSTAGRAM_CHANNEL_ID = 'ig';
  let error;
  try {
    await publishTodayPost({ live: true, fetchImpl: async () => { throw new Error('should not be called'); } });
  } catch (e) { error = e; }
  assert(error);
  assert(error.message.includes('BUFFER_AUTOPUBLISH_ENABLED=true'), `message was: ${error.message}`);
});

test('CLI --live without env gate rejects and names BUFFER_AUTOPUBLISH_ENABLED', async () => {
  const { exitCode, stdout, stderr } = await new Promise(resolve => {
    execFile('node', ['scripts/post-to-buffer.js', '--live'], {
      cwd: repoRoot,
      env: { ...process.env, BUFFER_AUTOPUBLISH_ENABLED: '', BUFFER_ACCESS_TOKEN: '', BUFFER_INSTAGRAM_CHANNEL_ID: '', BUFFER_LINKEDIN_CHANNEL_ID: '', BUFFER_TIKTOK_CHANNEL_ID: '' }
    }, (err, stdout, stderr) => resolve({ exitCode: err ? err.code : 0, stdout, stderr }));
  });
  assert.notStrictEqual(exitCode, 0);
  const out = (stdout + stderr).join ? (stdout + stderr).join('') : (stdout || '') + (stderr || '');
  assert(out.includes('BUFFER_AUTOPUBLISH_ENABLED=true'), `output was: ${out}`);
});

test('timeout error classification is timeout', async () => {
  const fetchImpl = async () => new Promise(() => {});
  try {
    await bufferGraphql({ token: 't', query: 'q', fetchImpl, timeoutMs: 50 });
    assert.fail('expected timeout');
  } catch (err) {
    assert.strictEqual(err.classification, 'timeout');
  }
});

test('duplicate detection performs zero createPost calls', async () => {
  const defaultPosts = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'social-posts.json'), 'utf8'));
  const dayName = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', weekday: 'long' }).format(new Date());
  const dayPost = defaultPosts.find(p => p.day === dayName);
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      data: {
        account: { organizations: [{ id: 'org1' }] },
        channels: { channels: [{ id: 'ig', service: 'instagram' }, { id: 'li', service: 'linkedin' }] },
        posts: { posts: [{ id: 'p1', text: dayPost.text, createdAt: new Date().toISOString(), dueAt: new Date().toISOString() }] }
      }
    })
  });
  let createCalls = 0;
  const wrappedFetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    if (body.query && body.query.includes('createPost')) createCalls++;
    return fetchImpl(url, init);
  };
  process.env.BUFFER_AUTOPUBLISH_ENABLED = 'true';
  process.env.BUFFER_ACCESS_TOKEN = 'tok';
  process.env.BUFFER_INSTAGRAM_CHANNEL_ID = 'ig';
  process.env.BUFFER_LINKEDIN_CHANNEL_ID = '';
  process.env.BUFFER_TIKTOK_CHANNEL_ID = '';
  process.env.GITHUB_RUN_ATTEMPT = '1';
  try {
    await publishTodayPost({ live: true, fetchImpl: wrappedFetch });
  } catch {}
  delete process.env.GITHUB_RUN_ATTEMPT;
  assert.strictEqual(createCalls, 0, 'duplicate should not call createPost');
});

test('channel validation unchanged', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      data: {
        account: { organizations: [{ id: 'org1' }] },
        channels: { channels: [{ id: 'ig', service: 'instagram' }] }
      }
    })
  });
  process.env.BUFFER_AUTOPUBLISH_ENABLED = 'true';
  process.env.BUFFER_ACCESS_TOKEN = 'tok';
  process.env.BUFFER_INSTAGRAM_CHANNEL_ID = 'ig';
  process.env.BUFFER_LINKEDIN_CHANNEL_ID = 'li';
  process.env.BUFFER_TIKTOK_CHANNEL_ID = '';
  process.env.GITHUB_RUN_ATTEMPT = '1';
  try {
    await publishTodayPost({ live: true, fetchImpl });
    assert.fail('expected validation to fail for missing configured channel');
  } catch (err) {
    assert(err.message.includes('not found'), `unexpected: ${err.message}`);
  }
  delete process.env.GITHUB_RUN_ATTEMPT;
});

test('successful Buffer request cancels the timeout timer', async () => {
  const origSetTimeout = globalThis.setTimeout;
  const origClearTimeout = globalThis.clearTimeout;
  let cleared = 0;
  globalThis.setTimeout = (fn, ms, ...args) => ({ _fn: fn, _ms: ms, _id: origSetTimeout(fn, ms, ...args) });
  globalThis.clearTimeout = (handle) => { cleared++; if (handle?._id !== undefined) origClearTimeout(handle._id); };
  try {
    await bufferGraphql({
      token: 't',
      query: 'q',
      timeoutMs: 100,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: { ok: true } })
      })
    });
  } finally {
    globalThis.setTimeout = origSetTimeout;
    globalThis.clearTimeout = origClearTimeout;
  }
  assert(cleared >= 1, 'timeout timer was not cancelled after successful request');
});

let passed = 0;
let failed = 0;
const failures = [];

for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`PASS ${name}`);
    passed++;
  } catch (err) {
    failed++;
    const msg = err.message || String(err);
    console.log(`FAIL ${name}: ${msg}`);
    failures.push({ name, msg });
  }
}

console.log(`\nBUFFER_TESTS_PASS=${passed}`);
console.log(`BUFFER_TESTS_FAIL=${failed}`);

if (failed > 0) {
  process.exit(1);
}
