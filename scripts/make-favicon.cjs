const sharp = require('sharp');
const fs = require('fs');

const BG = '#FDFBF7';

function generateWithBg(input, output, size) {
  const svg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="${BG}"/></svg>`;
  return sharp(input)
    .resize(size - 20, size - 20, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer()
    .then(logoBuf => {
      return sharp(Buffer.from(svg))
        .composite([{ input: logoBuf, gravity: 'center', blend: 'over' }])
        .png()
        .toBuffer();
    })
    .then(buf => {
      fs.writeFileSync(output, buf);
      console.log(`Done: ${output} (${buf.length} bytes, ${size}x${size})`);
    });
}

Promise.all([
  generateWithBg('logo final.png', 'favicon.png', 256),
  generateWithBg('logo final.png', 'public/favicon.png', 256),
  generateWithBg('logo final.png', 'logo.png', 512),
  generateWithBg('logo final.png', 'public/logo.png', 512),
]).catch(e => console.error(e));
