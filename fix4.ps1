$files = Get-ChildItem -Path "c:\Users\bathi\Desktop\SITE DEFINITIF BATHILY-CONVOYAGE" -Recurse -File | Where-Object { 
    ($_.Extension -eq '.html' -or $_.Extension -eq '.js' -or $_.Extension -eq '.md') -and 
    ($_.FullName -notmatch 'node_modules') -and 
    ($_.FullName -notmatch '\.git') 
}

$count = 0
foreach ($f in $files) {
    $content = [System.IO.File]::ReadAllText($f.FullName, [System.Text.Encoding]::UTF8)
    
    if ($content -match 'Bathily\s+convoyage') {
        $newContent = [regex]::Replace($content, '(?i)Bathily\s+convoyage', 'Bathily-Convoyage')
        
        if ($newContent -cne $content) {
            [System.IO.File]::WriteAllText($f.FullName, $newContent, [System.Text.Encoding]::UTF8)
            Write-Output "Modified: $($f.FullName)"
            $count++
        }
    }
}
Write-Output "Total modified: $count"
