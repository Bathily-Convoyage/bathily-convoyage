$root = "c:\Users\bathi\Desktop\SITE DEFINITIF BATHILY-CONVOYAGE"
$files = @(
  "css\design-system.css",
  "css\mobile-nav.css",
  "js\avis.js",
  "js\address-autocomplete.js",
  "js\fidelite.js",
  "js\gamification.js",
  "js\lang-switcher.js",
  "js\mobile-nav.js",
  "js\newsletter.js",
  "js\pricing.js",
  "js\vehicule-autocomplete.js",
  "sw.js",
  "robots.txt",
  "manifest.json",
  "logo.svg",
  "logo.png",
  "favicon.png",
  "favicon.ico",
  "_headers",
  "_redirects",
  "sitemap.xml"
)

foreach ($f in $files) {
  $p1 = Join-Path $root $f
  $p2 = Join-Path "$root\public" $f
  if ((Test-Path $p1) -and (Test-Path $p2)) {
    $h1 = (Get-FileHash $p1).Hash
    $h2 = (Get-FileHash $p2).Hash
    if ($h1 -eq $h2) {
      Write-Host "OK   $f"
    } else {
      Write-Host "DIFF $f"
    }
  } elseif (Test-Path $p1) {
    Write-Host "ROOT_ONLY $f"
  } elseif (Test-Path $p2) {
    Write-Host "PUBLIC_ONLY $f"
  } else {
    Write-Host "MISSING $f"
  }
}
