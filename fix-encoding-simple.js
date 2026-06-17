const fs = require('fs');

const files = fs.readdirSync('.').filter(f => f.endsWith('.html'));

const charMap = {
  '??': '⭐',
  'Ã©': 'é', 'Ã¨': 'è', 'Ãª': 'ê', 'Ã«': 'ë',
  'Ã´': 'ô', 'Ã¶': 'ö', 'Ã²': 'ò', 'Ã¹': 'ù',
  'Ã»': 'û', 'Ã¼': 'ü', 'Ã ': 'à', 'Ã¢': 'â',
  'Ã¤': 'ä', 'Ã£': 'ã', 'Ã¡': 'á', 'Ã§': 'ç',
  'Ã‡': 'Ç', 'Ã‰': 'É', 'Ãˆ': 'È', 'ÃŠ': 'Ê',
  'Ã€': 'À', 'Ã‚': 'Â', 'Ã–': 'Ö', 'Ãœ': 'Ü',
  'â€”': '—', 'â€“': '–', 'â€¢': '•', 'â€¦': '…',
  'â€œ': '"', 'â€': '"', 'â€™': "'", 'Â·': '·',
  'Â°': '°', 'Â®': '®', 'Â©': '©', 'Â«': '«',
  'Â»': '»', 'Â½': '½', 'Â¼': '¼', 'Â¾': '¾',
  'â‚¬': '€', 'Å“': 'œ', 'Å’': 'Œ', 'Ã˜': 'Ø',
  'Ã¸': 'ø', 'Ã…': 'Å', 'Ã¥': 'å', 'Ã†': 'Æ',
  'Ã¦': 'æ', 'ÃŸ': 'ß', 'âˆž': '∞', 'âˆ‘': '∑',
  'âˆ†': '∆', 'âˆš': '√', 'â‰ˆ': '≈', 'â‰ ': '≠',
  'â‰¤': '≤', 'â‰¥': '≥', 'â†’': '→', 'â†': '←',
  'â†‘': '↑', 'â†“': '↓', 'â„¢': '™'
};

files.forEach(file => {
  let content = fs.readFileSync(file, 'utf-8');
  let modified = false;
  for (const [bad, good] of Object.entries(charMap)) {
    if (content.includes(bad)) {
      content = content.split(bad).join(good);
      modified = true;
    }
  }
  if (modified) {
    fs.writeFileSync(file, content, 'utf-8');
    console.log('FIXED: ' + file);
  } else {
    console.log('OK: ' + file);
  }
});
