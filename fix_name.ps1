$files = Get-ChildItem -Path . -Recurse -Include *.html,*.js,*.md,*.txt,*.css,*.json -File -ErrorAction SilentlyContinue
$count = 0
foreach ($f in $files) {
    if ($f.FullName -match 'node_modules|\.git|\.gemini|supabase') { continue }
    $content = Get-Content -Raw -Path $f.FullName
    
    # Regex : ignore emails, URLs, repos
    $newContent = [regex]::Replace($content, '(?i)(?<![@/.-])\bbathily[\s-]*convoyage\b(?!\.fr|\.com|\.git|\.app|/)', 'Bathily-Convoyage')
    
    # C# string replace is fast but we need regex for boundaries.
    if ($content -cne $newContent) {
        [IO.File]::WriteAllText($f.FullName, $newContent, [System.Text.Encoding]::UTF8)
        $count++
    }
}
Write-Host "Opération terminée ! Fichiers mis à jour : $count"
