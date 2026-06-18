# Correction des problèmes d'encodage UTF-8
$replacements = @{
    "â€"" = "—"      # em-dash
    "â€™" = "'"      # apostrophe
    "â€˜" = "'"      # guillemet simple ouvert
    "Ã©" = "é"
    "Ã¨" = "è"
    "Ãª" = "ê"
    "Ã " = "à"
    "Ã¢" = "â"
    "Ã´" = "ô"
    "Ã»" = "û"
    "Ã®" = "î"
    "Ã¯" = "ï"
    "Ã§" = "ç"
    "Ã‰" = "É"
    "Ãˆ" = "È"
    "ÃŠ" = "Ê"
    "Ã‚" = "Â"
}

Get-ChildItem -Path "." -Filter "*.html" -Recurse | Where-Object { $_.FullName -notlike "*node_modules*" -and $_.FullName -notlike "*.git*" } | ForEach-Object {
    $content = Get-Content $_.FullName -Raw
    $modified = $false
    
    foreach ($old in $replacements.Keys) {
        if ($content -contains $old) {
            $content = $content -replace $old, $replacements[$old]
            $modified = $true
        }
    }
    
    if ($modified) {
        Set-Content $_.FullName $content -Encoding UTF8
        Write-Output "Corrigé: $($_.Name)"
    }
}

Write-Output "Terminé!"
