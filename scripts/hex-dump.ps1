$lines = Get-Content 'design\plaquette.html' -Encoding UTF8
for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match 'des lieux photo') {
        Write-Output "Line $i : $($lines[$i])"
    }
}
