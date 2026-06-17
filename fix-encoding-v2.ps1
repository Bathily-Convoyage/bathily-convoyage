# Script PowerShell v2 - Correction d'encodage complète
# Corrige les caractères corrompus dans tous les fichiers HTML

Write-Host "Démarrage de la correction d'encodage..." -ForegroundColor Cyan

# Liste des fichiers à traiter (tous les HTML sauf ceux dans node_modules)
$htmlFiles = Get-ChildItem -Path "." -Filter "*.html" -Recurse | 
    Where-Object { $_.FullName -notmatch "node_modules" -and $_.FullName -notmatch "\.git" }

$totalFiles = 0
$fixedFiles = 0

foreach ($file in $htmlFiles) {
    $totalFiles++
    Write-Host "Traitement de: $($file.Name)" -ForegroundColor Gray
    
    try {
        # Lecture en UTF8
        $content = Get-Content -Path $file.FullName -Raw -Encoding UTF8
        $original = $content
        
        # Remplacements pour caractères accentués français corrompus
        # Pattern : caractère de remplacement ou encodage brisé
        $replacements = @(
            # Véhicules / Sécurisé
            @{ Pattern = "Convoyeur . Bathily"; Replacement = "Convoyeur | Bathily" },
            @{ Pattern = "rseau"; Replacement = "réseau" },
            @{ Pattern = "certifis"; Replacement = "certifiés" },
            @{ Pattern = "complte"; Replacement = "complète" },
            @{ Pattern = "validation"; Replacement = "validation" },
            @{ Pattern = "accs"; Replacement = "accès" },
            @{ Pattern = "digitale"; Replacement = "digitale" },
            @{ Pattern = "premium"; Replacement = "premium" },
            # Autres accents communs
            @{ Pattern = ""; Replacement = "é" },  # é générique
            @{ Pattern = ""; Replacement = "è" },  # è générique  
            @{ Pattern = ""; Replacement = "à" },  # à générique
            @{ Pattern = ""; Replacement = "ù" },  # ù générique
            @{ Pattern = ""; Replacement = "ç" },  # ç générique
            @{ Pattern = ""; Replacement = "ô" },  # ô générique
            @{ Pattern = ""; Replacement = "ê" },  # ê générique
            @{ Pattern = ""; Replacement = "î" },  # î générique
            @{ Pattern = ""; Replacement = "â" },  # â générique
            @{ Pattern = ""; Replacement = "û" },  # û générique
            @{ Pattern = ""; Replacement = "ï" },  # ï générique
            @{ Pattern = ""; Replacement = "ë" },  # ë générique
            @{ Pattern = ""; Replacement = "ü" },  # ü générique
            @{ Pattern = ""; Replacement = "ö" },  # ö générique
            @{ Pattern = ""; Replacement = "ä" },  # ä générique
            @{ Pattern = ""; Replacement = "É" },  # É générique
            @{ Pattern = ""; Replacement = "È" },  # È générique
            @{ Pattern = ""; Replacement = "À" },  # À générique
            @{ Pattern = ""; Replacement = "Ç" },  # Ç générique
            @{ Pattern = ""; Replacement = "€" },  # €
            @{ Pattern = ""; Replacement = "°" },  # °
            @{ Pattern = ""; Replacement = "'" },  # apostrophe typographique
            @{ Pattern = ""; Replacement = "\"" }, # guillemets
            @{ Pattern = ""; Replacement = "–" },  # tiret demi-cadratin
            @{ Pattern = ""; Replacement = "—" },  # tiret cadratin
            @{ Pattern = ""; Replacement = "…" },  # points de suspension
        )
        
        $modified = $false
        foreach ($rep in $replacements) {
            if ($content -match [regex]::Escape($rep.Pattern)) {
                $content = $content -replace [regex]::Escape($rep.Pattern), $rep.Replacement
                $modified = $true
            }
        }
        
        # Écriture si modifié
        if ($content -ne $original) {
            Set-Content -Path $file.FullName -Value $content -Encoding UTF8 -NoNewline
            $fixedFiles++
            Write-Host "  ✓ Corrigé: $($file.Name)" -ForegroundColor Green
        }
    }
    catch {
        Write-Host "  ✗ Erreur sur $($file.Name): $_" -ForegroundColor Red
    }
}

Write-Host "`n=== RÉSULTAT ===" -ForegroundColor Cyan
Write-Host "Fichiers traités: $totalFiles" -ForegroundColor White
Write-Host "Fichiers corrigés: $fixedFiles" -ForegroundColor Green
Write-Host "`nProchaines étapes:" -ForegroundColor Yellow
Write-Host "1. git add -A" -ForegroundColor White
Write-Host "2. git commit -m 'fix(encoding): corrige tous les accents v2'" -ForegroundColor White  
Write-Host "3. git push origin main" -ForegroundColor White
Write-Host "4. Vider le cache navigateur et tester" -ForegroundColor White
