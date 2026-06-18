# Script pour corriger tous les </link>
Get-ChildItem -Path '.' -Filter '*.html' -Recurse | ForEach-Object {
    $content = Get-Content $_.FullName -Raw
    $newContent = $content -replace '</link>', ''
    if ($content -ne $newContent) {
        Set-Content $_.FullName $newContent
        Write-Output "Corrigé: $($_.Name)"
    }
}
Write-Output "Terminé!"
