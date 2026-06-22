$files = Get-ChildItem -Path . -Recurse -File -Include *.html,*.js,*.md | Where-Object { $_.FullName -notmatch '\\node_modules\\' -and $_.FullName -notmatch '\\\.git\\' }

$count = 0
foreach ($file in $files) {
    $content = [System.IO.File]::ReadAllText($file.FullName, [System.Text.Encoding]::UTF8)
    if ($content -match '(?i)Bathily\s+convoyage') {
        $newContent = [regex]::Replace($content, '(?i)Bathily\s+convoyage', 'Bathily-Convoyage')
        if ($newContent -cne $content) {
            [System.IO.File]::WriteAllText($file.FullName, $newContent, [System.Text.Encoding]::UTF8)
            Write-Host "Modifié: $($file.FullName)"
            $count++
        }
    }
}

Write-Host "Termine. Fichiers modifies: $count"
