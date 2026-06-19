$files = @("convoyage-bordeaux.html", "convoyage-lyon.html", "convoyage-marseille.html", "convoyage-montpellier.html", "convoyage-moto-voiture-france.html", "convoyage-moto-voiture-paris.html", "convoyage-toulouse.html", "convoyage-vehicule-lille.html", "convoyage-vehicule-nantes.html", "convoyage-vehicule-nice.html", "convoyage-vehicule-rennes.html", "convoyage-vehicule-strasbourg.html")
foreach ($file in $files) {
    if (Test-Path $file) {
        $content = Get-Content -Path $file -Raw -Encoding UTF8
        $content = $content -replace "ðŸš—\s*Auto", "🚗 Auto"
        $content = $content -replace "ðŸ\s*Moto", "🏍️ Moto"
        $content = $content -replace "ðŸ“\s*Suivi", "📍 Suivi"
        $content = $content -replace '</h1>`n\s*<div class="badge-trust"[^>]*>📍\s*Suivi GPS en temps reel</div>', '</h1><div class="badge-trust" style="margin-top: 10px; margin-bottom: 20px;">📍 Suivi GPS en temps réel</div>'
        Set-Content -Path $file -Value $content -Encoding UTF8
    }
}
