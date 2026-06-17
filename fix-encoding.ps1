# Script PowerShell de correction d'encodage
# Remplace les caractères corrompus par les bons accents UTF-8

$replacements = @{
    # Caractères accentués français
    "Vhicules Scuris" = "Véhicules Sécurisé"
    "Scuris" = "Sécurisé"
    "hicule" = "éhicule"  # partie de véhicule
    "vhicule" = "véhicule"
    "Vhicule" = "Véhicule"
    "Vhicules" = "Véhicules"
    "temps rel" = "temps réel"
    "certifis" = "certifiés"
    "certifies" = "certifiées"
    "instantan" = "instantané"
    "instantané" = "instantané"  # cas double corrompu
    "dpart" = "départ"
    "arrive" = "arrivée"
    "prfrence" = "préférence"
    "prfrences" = "préférences"
    "Rseau" = "Réseau"
    "rseau" = "réseau"
    "mtropoles" = "métropoles"
    "mcanicien" = "mécanicien"
    "gnralement" = "généralement"
    "effectue" = "effectuée"
    "trajet commenc" = "trajet commencé"
    "partag" = "partagé"
    "mise jour" = "mise à jour"
    "vhicule" = "véhicule"
    "vhicules" = "véhicules"
    "zro" = "zéro"
    "kilomtre" = "kilomètre"
    "kilomtres" = "kilomètres"
    "dj" = "déjà"
    "Prt" = "Prêt"
    "dplacer" = "déplacer"
    "entire" = "entière"
    "rserve" = "réserve"
    "rservs" = "réservés"
    "Convoyage" = "Convoyage"
    "conomique" = "économique"
    "conomique" = "économique"
    "recommand" = "recommandé"
    "chou" = "échoué"
    "gocodage" = "géocodage"
    "Itinraire" = "Itinéraire"
    "l'appel" = "l'appel à"
    "dlai" = "délai"
    "co-responsable" = "éco-responsable"
    "automobiles" = "automobiles"  # correction emoji corrompu
    "Auto" = "Auto"  # correction emoji
    "Moto" = "Moto"  # correction emoji
    # Caractères monétaires
    "prix" = "prix€"
    "base" = "base€"
    "HT" = "HT€"
    "km" = "km€"
    "1.00" = "1.00€"
    "0.85" = "0.85€"
    "350" = "350€"
    "1100" = "1100€"
    # Autres caractères spéciaux
    "rel" = "réel"
    "scurit" = "sécurité"
    "prcdent" = "précédent"
    "prcdente" = "précédente"
    "dpart" = "départ"
    "arrive" = "arrivée"
    "numro" = "numéro"
    "tlcommande" = "télécommande"
    "tlphone" = "téléphone"
    "franais" = "français"
    "vnement" = "événement"
    "cr dit" = "crédit"
    "prt" = "prêt"
    "priode" = "période"
    "conomique" = "économique"
    "nergie" = "énergie"
    "socit" = "société"
    "garanti" = "garantie"
    "engags" = "engagés"
    "sjour" = "séjour"
    "tmoignages" = "témoignages"
    "anne" = "année"
    "mois" = "mois"
    "utilis" = "utilisé"
    "propos" = "proposé"
    "quipe" = "équipe"
    "confi" = "confié"
    "rserv" = "réservé"
    "niveau" = "niveau"
}

Get-ChildItem -Path . -Filter "*.html" -Recurse | ForEach-Object {
    $content = Get-Content -Path $_.FullName -Raw -Encoding UTF8
    $originalContent = $content
    
    foreach ($key in $replacements.Keys) {
        $content = $content -replace [regex]::Escape($key), $replacements[$key]
    }
    
    if ($content -ne $originalContent) {
        Set-Content -Path $_.FullName -Value $content -Encoding UTF8 -NoNewline
        Write-Host "Corrigé : $($_.FullName)" -ForegroundColor Green
    }
}

Write-Host "`nTerminé ! Tous les fichiers HTML ont été traités." -ForegroundColor Cyan
Write-Host "Vérifiez les changements avant de faire git add + commit + push"
