$now = Get-Date
$target = $now.Date.AddHours(2)
if ($now.Hour -ge 2) {
  $target = $target.AddDays(1)
}
$diff = ($target - $now).TotalSeconds
Write-Output "Attente de $([math]::Round($diff)) secondes..."
Start-Sleep -Seconds $diff
Write-Output "Demarrage du script..."
node scripts/schedule-juillet-2026.js
