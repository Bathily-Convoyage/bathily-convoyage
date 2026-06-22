const fs = require('fs');
const path = require('path');

function walkDir(dir, callback) {
  fs.readdirSync(dir).forEach(f => {
    const dirPath = path.join(dir, f);
    const isDirectory = fs.statSync(dirPath).isDirectory();
    if (isDirectory) {
      if (f !== 'node_modules' && f !== '.git' && f !== 'dist' && f !== 'images' && f !== 'netlify') {
        walkDir(dirPath, callback);
      }
    } else {
      callback(path.join(dir, f));
    }
  });
}

let modifiedFiles = 0;
walkDir(__dirname, function(filePath) {
  if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.md')) {
    const originalContent = fs.readFileSync(filePath, 'utf8');
    
    // Remplacer "Bathily Convoyage" ou "Bathily convoyage" par "Bathily-Convoyage"
    // On exclut les cas où c'est déjà "Bathily-Convoyage" ou une URL
    const newContent = originalContent.replace(/Bathily\s+convoyage/gi, 'Bathily-Convoyage');
    
    if (newContent !== originalContent) {
      fs.writeFileSync(filePath, newContent, 'utf8');
      console.log('Modifié: ' + filePath);
      modifiedFiles++;
    }
  }
});

console.log('Total de fichiers modifiés: ' + modifiedFiles);
