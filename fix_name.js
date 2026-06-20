const fs = require('fs');
const path = require('path');

function walkDir(dir, callback) {
    fs.readdirSync(dir).forEach(f => {
        const dirPath = path.join(dir, f);
        const isDirectory = fs.statSync(dirPath).isDirectory();
        if (isDirectory && !['node_modules', '.git', '.gemini', 'supabase'].includes(f)) {
            walkDir(dirPath, callback);
        } else if (!isDirectory) {
            callback(path.join(dir, f));
        }
    });
}

let count = 0;
let filesUpdated = 0;
walkDir('.', function(filePath) {
    if (filePath.match(/\.(html|js|md|json|txt|css)$/)) {
        let content = fs.readFileSync(filePath, 'utf8');
        
        let newContent = content.replace(/(?<![@/.-])\bbathily[\s-]*convoyage\b(?!\.fr|\.com|\.git|\.app|\/)/gi, (match) => {
            if (match !== 'Bathily-Convoyage') {
                count++;
                return 'Bathily-Convoyage';
            }
            return match;
        });

        if (content !== newContent) {
            fs.writeFileSync(filePath, newContent, 'utf8');
            filesUpdated++;
            console.log(`Updated: ${filePath}`);
        }
    }
});
console.log(`Total occurrences replaced: ${count}`);
console.log(`Files updated: ${filesUpdated}`);
