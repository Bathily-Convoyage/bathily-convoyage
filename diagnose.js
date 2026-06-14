const fs = require('fs');
const content = fs.readFileSync('convoyage-moto-voiture-france.html', 'utf8');
const lines = content.split(/\r?\n/);
const line = lines[848]; // 849 is index 848 (0-indexed)
console.log('Line 849 length:', line.length);
console.log('Line content:', line);
for (let i = 0; i < line.length; i++) {
  const code = line.charCodeAt(i);
  if (code < 32 || (code >= 127 && code <= 160) || code > 255) {
    console.log(`Char at index ${i} (col ${i+1}): '${line[i]}' (code: ${code} / 0x${code.toString(16)})`);
  }
}
