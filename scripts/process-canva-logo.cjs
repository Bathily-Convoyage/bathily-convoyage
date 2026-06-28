const sharp = require('sharp');
const fs = require('fs');

const SOURCE = 'logo.png';
const BG = { r: 253, g: 251, b: 247, alpha: 1 };

async function main() {
  const image = sharp(SOURCE);
  const meta = await image.metadata();
  const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  let minX = info.width;
  let minY = info.height;
  let maxX = 0;
  let maxY = 0;

  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const idx = (y * info.width + x) * info.channels;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const isNotWhite = !(r > 248 && g > 248 && b > 248);
      if (isNotWhite) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  const cropWidth = maxX - minX + 1;
  const cropHeight = maxY - minY + 1;
  const size = Math.max(cropWidth, cropHeight);
  const left = Math.max(0, minX - Math.floor((size - cropWidth) / 2));
  const top = Math.max(0, minY - Math.floor((size - cropHeight) / 2));
  const extractSize = Math.min(size, meta.width - left, meta.height - top);

  const cropped = await sharp(SOURCE)
    .extract({ left, top, width: extractSize, height: extractSize })
    .resize(1024, 1024, { fit: 'contain', background: BG })
    .png()
    .toBuffer();

  fs.writeFileSync('logo.png', cropped);
  fs.writeFileSync('public/logo.png', cropped);

  const favicon = await sharp(cropped)
    .resize(256, 256, { fit: 'contain', background: BG })
    .png()
    .toBuffer();

  fs.writeFileSync('favicon.png', favicon);
  fs.writeFileSync('public/favicon.png', favicon);

  console.log(`Processed ${SOURCE}: ${meta.width}x${meta.height} -> logo 1024x1024, favicon 256x256`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
