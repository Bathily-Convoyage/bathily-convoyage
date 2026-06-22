$files = Get-ChildItem -Path . -Recurse -File | Where-Object { $_.Extension -match '\.(html|js|md)$' -and $_.FullName -notmatch '\\node_modules\\' -and $_.FullName -notmatch '\\\.git\\' }
foreach ($file in $files) {
    $content = [System.IO.File]::ReadAllText($file.FullName, [System.Text.Encoding]::UTF8)
    if ($content -match 'Bathily\s+convoyage') {
        $newContent = $content -replace '(?i)Bathily\s+convoyage', 'Bathily-Convoyage'
        [System.IO.File]::WriteAllText($file.FullName, $newContent, [System.Text.Encoding]::UTF8)
        Write-Host "Modified: $($file.FullName)"
    }
}
