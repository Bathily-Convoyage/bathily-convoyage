$files = @(
"c:\Users\bathi\Desktop\SITE DEFINITIF BATHILY-CONVOYAGE\tracking.html",
"c:\Users\bathi\Desktop\SITE DEFINITIF BATHILY-CONVOYAGE\supabase\README.md",
"c:\Users\bathi\Desktop\SITE DEFINITIF BATHILY-CONVOYAGE\scripts\generate-insta.js",
"c:\Users\bathi\Desktop\SITE DEFINITIF BATHILY-CONVOYAGE\reset-password.html",
"c:\Users\bathi\Desktop\SITE DEFINITIF BATHILY-CONVOYAGE\mission-tracker.html",
"c:\Users\bathi\Desktop\SITE DEFINITIF BATHILY-CONVOYAGE\mentions-legales.html",
"c:\Users\bathi\Desktop\SITE DEFINITIF BATHILY-CONVOYAGE\insta-v2\CAPTIONS.md",
"c:\Users\bathi\Desktop\SITE DEFINITIF BATHILY-CONVOYAGE\netlify\functions\create-checkout-session.js",
"c:\Users\bathi\Desktop\SITE DEFINITIF BATHILY-CONVOYAGE\netlify\functions\send-email.js",
"c:\Users\bathi\Desktop\SITE DEFINITIF BATHILY-CONVOYAGE\public\js\lang-switcher.js",
"c:\Users\bathi\Desktop\SITE DEFINITIF BATHILY-CONVOYAGE\js\lang-switcher.js",
"c:\Users\bathi\Desktop\SITE DEFINITIF BATHILY-CONVOYAGE\generate-charte-pdf.js",
"c:\Users\bathi\Desktop\SITE DEFINITIF BATHILY-CONVOYAGE\gps-emitter.html",
"c:\Users\bathi\Desktop\SITE DEFINITIF BATHILY-CONVOYAGE\identifiants.md",
"c:\Users\bathi\Desktop\SITE DEFINITIF BATHILY-CONVOYAGE\formation-convoyeur.html",
"c:\Users\bathi\Desktop\SITE DEFINITIF BATHILY-CONVOYAGE\fix-name.js",
"c:\Users\bathi\Desktop\SITE DEFINITIF BATHILY-CONVOYAGE\etat-des-lieux.html",
"c:\Users\bathi\Desktop\SITE DEFINITIF BATHILY-CONVOYAGE\devis.html",
"c:\Users\bathi\Desktop\SITE DEFINITIF BATHILY-CONVOYAGE\DESIGN-SYSTEM.md",
"c:\Users\bathi\Desktop\SITE DEFINITIF BATHILY-CONVOYAGE\dashboard-convoyeur.html",
"c:\Users\bathi\Desktop\SITE DEFINITIF BATHILY-CONVOYAGE\dashboard-client.html",
"c:\Users\bathi\Desktop\SITE DEFINITIF BATHILY-CONVOYAGE\dashboard-admin.html",
"c:\Users\bathi\Desktop\SITE DEFINITIF BATHILY-CONVOYAGE\design\carte.html",
"c:\Users\bathi\Desktop\SITE DEFINITIF BATHILY-CONVOYAGE\design\plaquette.html",
"c:\Users\bathi\Desktop\SITE DEFINITIF BATHILY-CONVOYAGE\convoyage-vehicule-rennes.html",
"c:\Users\bathi\Desktop\SITE DEFINITIF BATHILY-CONVOYAGE\convoyage-vehicule-strasbourg.html",
"c:\Users\bathi\Desktop\SITE DEFINITIF BATHILY-CONVOYAGE\convoyage-vehicule-nantes.html",
"c:\Users\bathi\Desktop\SITE DEFINITIF BATHILY-CONVOYAGE\convoyage-vehicule-lille.html",
"c:\Users\bathi\Desktop\SITE DEFINITIF BATHILY-CONVOYAGE\convoyage-toulouse.html",
"c:\Users\bathi\Desktop\SITE DEFINITIF BATHILY-CONVOYAGE\convoyage-moto-voiture-paris.html",
"c:\Users\bathi\Desktop\SITE DEFINITIF BATHILY-CONVOYAGE\convoyage-vehicule-nice.html",
"c:\Users\bathi\Desktop\SITE DEFINITIF BATHILY-CONVOYAGE\convoyage-moto-voiture-france.html",
"c:\Users\bathi\Desktop\SITE DEFINITIF BATHILY-CONVOYAGE\convoyage-montpellier.html",
"c:\Users\bathi\Desktop\SITE DEFINITIF BATHILY-CONVOYAGE\convoyage-marseille.html",
"c:\Users\bathi\Desktop\SITE DEFINITIF BATHILY-CONVOYAGE\convoyage-bordeaux.html",
"c:\Users\bathi\Desktop\SITE DEFINITIF BATHILY-CONVOYAGE\convoyage-lyon.html",
"c:\Users\bathi\Desktop\SITE DEFINITIF BATHILY-CONVOYAGE\contact.html",
"c:\Users\bathi\Desktop\SITE DEFINITIF BATHILY-CONVOYAGE\charte_graphique.md",
"c:\Users\bathi\Desktop\SITE DEFINITIF BATHILY-CONVOYAGE\charte-graphique-complete.html",
"c:\Users\bathi\Desktop\SITE DEFINITIF BATHILY-CONVOYAGE\AUDIT-UX-CONCURRENTS.md",
"c:\Users\bathi\Desktop\SITE DEFINITIF BATHILY-CONVOYAGE\bon-de-mission.html",
"c:\Users\bathi\Desktop\SITE DEFINITIF BATHILY-CONVOYAGE\AUDIT-CHARTE.md",
"c:\Users\bathi\Desktop\SITE DEFINITIF BATHILY-CONVOYAGE\AUDIT-AUTO-MOTO.md"
)

foreach ($f in $files) {
    if (Test-Path $f) {
        $c = Get-Content -Path $f -Raw
        $n = $c -ireplace 'Bathily\s+convoyage', 'Bathily-Convoyage'
        if ($n -cne $c) {
            # Use UTF8 encoding without BOM usually
            [System.IO.File]::WriteAllText($f, $n, [System.Text.Encoding]::UTF8)
            Write-Output "Modified: $f"
        }
    }
}
