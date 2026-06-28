const sharp = require('sharp');
const fs = require('fs');

const SIZE = 256;
const BG = '#FDFBF7';
const svg = `<svg width="${SIZE}" height="${SIZE}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="${BG}"/></svg>`;

sharp('logo final.png')
  .resize(SIZE - 20, SIZE - 20, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .toBuffer()
  .then(logoBuf => {
    return sharp(Buffer.from(svg))
      .composite([{ input: logoBuf, gravity: 'center', blend: 'over' }])
      .png()
      .toBuffer();
  })
  .then(buf => {
    fs.writeFileSync('favicon.png', buf);
    fs.writeFileSync('public/favicon.png', buf);
    console.log('Done: favicon.png ' + buf.length + ' bytes with beige background');
  })
  .catch(e => console.error(e));
