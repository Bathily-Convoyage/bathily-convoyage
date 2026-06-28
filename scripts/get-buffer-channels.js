import fs from 'fs';
import path from 'path';

async function getBufferChannels() {
  const token = 'pu4Xem4CjrtuPt0jeQTlGuV7TAyRYwZoA7PqHwf40mf';
  const channelIds = ['6a36abc838b5579345b7f883', '6a419f085ab6d2f10681d3ac', '6a2bd39638b5579345898778'];

  console.log('🔍 Identification des channels Buffer...\n');

  for (const channelId of channelIds) {
    const query = `
      query {
        channel(id: "${channelId}") {
          id
          service
          name
          __typename
        }
      }
    `;

    try {
      const response = await fetch('https://api.buffer.com', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ query })
      });

      const data = await response.json();

      if (response.ok && data.data && data.data.channel) {
        const channel = data.data.channel;
        console.log(`✅ ${channel.service} (${channel.id}): ${channel.name || 'No name'}`);
      } else {
        console.log(`❌ Erreur pour ${channelId}:`, data.errors?.[0]?.message || 'Unknown error');
      }
    } catch (err) {
      console.log(`❌ Erreur de requête pour ${channelId}:`, err.message);
    }
  }
}

getBufferChannels();
