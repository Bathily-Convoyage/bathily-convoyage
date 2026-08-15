import { getOrganizations, getChannels } from './lib/buffer-api.mjs';

function maskId(id) {
  if (!id || id.length < 8) return '***';
  return id.slice(0, 3) + '...' + id.slice(-3);
}

async function main() {
  const token = process.env.BUFFER_ACCESS_TOKEN;
  const instagram = process.env.BUFFER_INSTAGRAM_CHANNEL_ID;
  const linkedin = process.env.BUFFER_LINKEDIN_CHANNEL_ID;
  const tiktok = process.env.BUFFER_TIKTOK_CHANNEL_ID;

  if (!token) {
    console.error('BUFFER_ACCESS_TOKEN is required.');
    process.exit(1);
  }

  const configured = [
    { platform: 'instagram', id: instagram },
    { platform: 'linkedin', id: linkedin },
    { platform: 'tiktok', id: tiktok }
  ].filter(c => c.id);

  if (configured.length === 0) {
    console.error('At least one BUFFER_*_CHANNEL_ID is required.');
    process.exit(1);
  }

  const organizations = await getOrganizations({ token });
  if (organizations.length === 0) {
    console.error('No Buffer organizations found.');
    process.exit(1);
  }

  const organizationId = organizations[0].id;
  const channels = await getChannels({ token, organizationId });

  const found = new Map();
  for (const channel of channels) {
    found.set(channel.id, channel.service);
  }

  let allValid = true;
  for (const { platform, id } of configured) {
    const service = found.get(id);
    const masked = maskId(id);
    if (!service) {
      console.error(`Channel ${masked} not found in organization ${maskId(organizationId)}.`);
      allValid = false;
      continue;
    }
    if (service !== platform) {
      console.error(`Channel ${masked} service mismatch: expected ${platform}, got ${service}.`);
      allValid = false;
      continue;
    }
    console.log(`Channel ${masked} OK: ${platform}`);
  }

  if (!allValid) {
    process.exit(1);
  }

  console.log(`Organization ${maskId(organizationId)} verified with ${channels.length} channel(s).`);
}

main().catch(err => {
  console.error('Unexpected error:', err.message);
  process.exit(1);
});
