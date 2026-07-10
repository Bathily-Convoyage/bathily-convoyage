$root = "c:\Users\bathi\Desktop\SITE DEFINITIF BATHILY-CONVOYAGE"
$utf8 = [System.Text.UTF8Encoding]::new($false)
$count = 0

Get-ChildItem -Path $root -Filter "*.html" -Recurse | Where-Object { $_.FullName -notlike '*node_modules*' } | ForEach-Object {
    $c = [System.IO.File]::ReadAllText($_.FullName)
    if ($c -match '/logo\.svg') {
        $f = $c -replace '/logo\.svg', '/logo.png'
        [System.IO.File]::WriteAllText($_.FullName, $f, $utf8)
        Write-Host "Fixed: $($_.Name)"
        $count++
    }
}

Write-Host "`nTotal: $count files"
