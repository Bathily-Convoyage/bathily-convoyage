import { createClient } from '@supabase/supabase-js';
import { getCorsHeaders, jsonResponse, handleOptions, checkRateLimit, parseBody } from '../_utils.js';

export async function onRequest(context) {
  const { request, env } = context;

  const optionsRes = handleOptions(request);
  if (optionsRes) return optionsRes;

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Méthode non autorisée. Utilisez POST.' }, 405, getCorsHeaders(request));
  }

  const rl = checkRateLimit(request, 'send-email', 20, 60000);
  if (rl) return rl;

  try {
    const parsedBody = await parseBody(request);
    const { trigger, id, notes, payment_url, temp_password, prenom, email: directEmail, nom: directNom, convoyeur_nom, convoyeur_email, client_email, depart, arrivee, date_mission, reference } = parsedBody;

    const PUBLIC_TRIGGERS = ['devis_created', 'candidature_submitted'];
    const AUTHENTICATED_TRIGGERS = ['edl_completed'];
    const ADMIN_ONLY_TRIGGERS = ['devis_confirmed', 'convoyeur_approved', 'payment_success', 'candidature_status_changed', 'mission_assigned', 'support_reply', 'pro_approved', 'pro_rejected'];
    const ALL_RESTRICTED = [...AUTHENTICATED_TRIGGERS, ...ADMIN_ONLY_TRIGGERS];

    if (ALL_RESTRICTED.includes(trigger)) {
      const internalSecret = request.headers.get('x-internal-secret') || '';
      if (internalSecret && internalSecret === env.INTERNAL_SECRET) {
        // Appel interne (webhook Stripe, cron, etc.) — autorisé
      } else {
        const authHeader = request.headers.get('authorization') || '';
        if (!authHeader.startsWith('Bearer ')) {
          return jsonResponse({ error: 'Authentification requise pour ce trigger.' }, 401, getCorsHeaders(request));
        }
        const token = authHeader.split(' ')[1];
        const sbAuth = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY || env.SUPABASE_SERVICE_ROLE_KEY);
        const { data: { user }, error: userErr } = await sbAuth.auth.getUser(token);
        if (userErr || !user) {
          return jsonResponse({ error: 'Token invalide.' }, 401, getCorsHeaders(request));
        }
        // Pour les triggers admin-only : vérifier le rôle admin
        if (ADMIN_ONLY_TRIGGERS.includes(trigger)) {
          const { data: profile } = await sbAuth.from('clients').select('role').eq('auth_user_id', user.id).maybeSingle();
          if (!profile || profile.role !== 'admin') {
            return jsonResponse({ error: 'Accès refusé : administrateur uniquement.' }, 403, getCorsHeaders(request));
          }
        }
      }
    }

    if (!trigger || (!id && trigger !== 'convoyeur_approved' && trigger !== 'mission_assigned')) {
      return jsonResponse({ error: 'Paramètres trigger et id requis.' }, 400, getCorsHeaders(request));
    }

    if (trigger === 'mission_assigned' && !client_email && !convoyeur_email && !directEmail) {
      return jsonResponse({ error: 'Au moins un email destinataire est requis.' }, 400, getCorsHeaders(request));
    }

    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("Variables de configuration Supabase manquantes dans l'environnement.");
    }
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

    const resendApiKey = env.RESEND_API_KEY;
    const FROM_EMAIL = env.EMAIL_FROM || 'onboarding@resend.dev';
    const ADMIN_EMAIL = env.EMAIL_ADMIN || 'contact@bathily-convoyage.fr';

    async function sendEmail({ to, subject, html }) {
      if (!resendApiKey) {
        console.log(`[SIMULATION EMAIL] A: ${to} Sujet: ${subject}`);
        return { simulated: true };
      }
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: `Bathily Convoyage <${FROM_EMAIL}>`, to: Array.isArray(to) ? to : [to], subject, html })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(`Erreur API Resend: ${data.message || response.statusText}`);
      return data;
    }

    function wrapEmailLayout(contentTitle, contentBody) {
      return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
        body{font-family:'Helvetica Neue',Arial,sans-serif;background-color:#FDFBF7;color:#2D2A24;margin:0;padding:20px}
        .container{max-width:600px;margin:0 auto;background:#fff;border-radius:20px;border:1px solid #E8E1D9;overflow:hidden;box-shadow:0 10px 30px rgba(0,0,0,.03)}
        .header{background-color:#0A4D68;padding:30px;text-align:center;color:#fff}
        .header h1{margin:0;font-size:24px;font-weight:800;letter-spacing:-.02em}
        .content{padding:40px 30px;line-height:1.6;font-size:15px}
        .footer{background-color:#F9F6F0;padding:20px;text-align:center;font-size:12px;color:#6B625A;border-top:1px solid #E8E1D9}
        .btn{display:inline-block;background-color:#0A4D68;color:#fff!important;text-decoration:none;padding:12px 28px;border-radius:40px;font-weight:700;margin-top:20px;font-size:14px}
        .highlight-box{background-color:#E6F0F4;border-left:4px solid #0A4D68;padding:15px;border-radius:8px;margin:20px 0}
        .meta-list{margin:0;padding:0;list-style:none}.meta-list li{padding:8px 0;border-bottom:1px solid #F3F4F6;display:flex;justify-content:space-between}
        .meta-list li strong{color:#0A4D68}
      </style></head><body><div class="container"><div class="header"><h1>Bathily Convoyage.</h1></div>
      <div class="content"><h2 style="color:#0A4D68;margin-top:0">${contentTitle}</h2>${contentBody}</div>
      <div class="footer">© 2025 Bathily Convoyage — Convoyage automobile & moto en France.<br>Besoin d'aide ? <a href="mailto:${ADMIN_EMAIL}" style="color:#0A4D68">Contactez-nous</a></div>
      </div></body></html>`;
    }

    let resultData = {};

    if (trigger === 'convoyeur_approved') {
      const email = parsedBody.email;
      const convoyeurPrenom = prenom || 'Convoyeur';
      const tempPwd = temp_password;
      const welcomeHtml = wrapEmailLayout("Votre compte convoyeur est activé ! 🚚",
        `<p>Bonjour ${convoyeurPrenom},</p><p>Nous avons le plaisir de vous annoncer que votre compte convoyeur a été <strong>activé</strong> !</p>
         <p>Vous pouvez désormais vous connecter à votre espace convoyeur et postuler aux missions disponibles.</p>
         <div class="highlight-box"><strong>Vos identifiants de connexion :</strong><br><strong>Email :</strong> ${email}<br>
         <strong>Mot de passe temporaire :</strong> <code style="background:#F9F6F0;padding:2px 8px;border-radius:4px;font-size:14px;font-weight:bold">${tempPwd}</code><br><br>
         <small>Nous vous recommandons de modifier ce mot de passe lors de votre première connexion.</small></div>
         <p style="text-align:center"><a href="https://bathily-convoyage.fr/dashboard-convoyeur.html" class="btn">Accéder à mon Espace Convoyeur</a></p>
         <h3>Pour bien démarrer :</h3><ul><li>✅ Consultez les missions disponibles dans l'onglet "Marché"</li>
         <li>✅ Postulez aux missions qui vous correspondent</li><li>✅ Activez votre GPS lors de chaque prise en charge</li>
         <li>✅ Réalisez les 20 photos d'état des lieux à chaque mission</li></ul>`);
      await sendEmail({ to: email, subject: "Votre compte convoyeur Bathily est activé ! 🚚", html: welcomeHtml });
      resultData = { success: true, message: 'Email de bienvenue convoyeur envoyé.' };
    }
    else if (trigger === 'devis_created') {
      const { data: devis, error } = await supabase.from('devis')
        .select('id, reference, client_prenom, client_nom, client_email, depart, arrivee, vehicule, mode, pack, total_ht, details, date_livraison, heure_livraison, status, created_at')
        .eq('reference', id).single();
      if (error || !devis) throw new Error(`Devis introuvable: ${error?.message}`);
      const details = devis.details || {};
      const devisURL = `https://bathily-convoyage.fr/dashboard-client.html`;
      const isPro = details.is_pro === true;
      const displayAmount = devis.total_ht;
      const clientHtml = wrapEmailLayout("Votre demande de devis est bien reçue !",
        `<p>Bonjour ${devis.client_prenom || ''},</p><p>Nous vous remercions pour votre demande de devis sur notre plateforme. Un conseiller étudie votre dossier. Vous recevrez une proposition de prix définitive sous 2h.</p>
         <div class="highlight-box"><strong>Référence du devis :</strong> ${devis.reference}<br><strong>Montant estimatif :</strong> ${displayAmount} €</div>
         <h3>Récapitulatif de votre demande :</h3><ul class="meta-list">
         <li><span>Véhicule :</span> <strong>${devis.vehicule}</strong></li><li><span>Départ :</span> <strong>${devis.depart}</strong></li>
         <li><span>Arrivée :</span> <strong>${devis.arrivee}</strong></li><li><span>Mode de transport :</span> <strong>${details.mode === 'plateau' ? 'Plateau' : 'Par la route'}</strong></li>
         <li><span>Pack choisi :</span> <strong>${details.pack || 'Starter'}</strong></li>
         ${devis.date_livraison ? `<li><span>Date de livraison :</span> <strong>${new Date(devis.date_livraison).toLocaleDateString('fr-FR')}</strong></li>` : ''}
         ${devis.heure_livraison ? `<li><span>Heure de livraison :</span> <strong>${devis.heure_livraison}</strong></li>` : ''}</ul>
         <p style="text-align:center"><a href="${devisURL}" class="btn">Accéder à mon Espace Client</a></p>`);
      const adminHtml = wrapEmailLayout("Nouvelle demande de devis à valider",
        `<p>Bonjour l'administrateur,</p><p>Un nouveau devis vient d'être soumis sur la plateforme et attend votre validation.</p>
         <div class="highlight-box"><strong>Référence :</strong> ${devis.reference}<br><strong>Client :</strong> ${devis.client_prenom} ${devis.client_nom} (${devis.client_email})${devis.date_livraison ? `<br><strong>Date de livraison :</strong> ${new Date(devis.date_livraison).toLocaleDateString('fr-FR')}${devis.heure_livraison ? ' à ' + devis.heure_livraison : ''}` : ''}</div>
         <p>Veuillez vous rendre sur le panel d'administration pour valider le tarif et assigner un convoyeur.</p>
         <p style="text-align:center"><a href="https://bathily-convoyage.fr/dashboard-admin.html" class="btn">Accéder au panel Admin</a></p>`);
      await sendEmail({ to: devis.client_email, subject: `Bathily Convoyage - Demande de devis ${devis.reference}`, html: clientHtml });
      await sendEmail({ to: ADMIN_EMAIL, subject: `[ADMIN] Nouveau devis à valider - ${devis.reference}`, html: adminHtml });
      resultData = { success: true, message: 'Emails devis envoyés.' };
    }
    else if (trigger === 'candidature_submitted') {
      const { data: candidat, error } = await supabase.from('convoyeur_candidatures')
        .select('id, prenom, nom, email, score_quiz, statut').eq('id', id).single();
      if (error || !candidat) throw new Error(`Candidat introuvable: ${error?.message}`);
      const candidatHtml = wrapEmailLayout("Félicitations pour votre réussite au quiz !",
        `<p>Bonjour ${candidat.prenom},</p><p>Nous avons le plaisir de vous confirmer que votre candidature a bien été reçue. Vous avez obtenu un score de <strong>${candidat.score_quiz}/12</strong> au quiz de formation.</p>
         <p>Votre dossier est en attente de vérification par notre équipe administrative. Nous reviendrons vers vous sous 24h à 48h ouvrées.</p>
         <div class="highlight-box"><strong>Statut de votre dossier :</strong> En cours d'examen<br><strong>Email de contact :</strong> ${candidat.email}</div>
         <p>Une fois votre compte validé, vous recevrez vos accès complets pour vous connecter à l'Espace Convoyeur.</p>`);
      const adminHtml = wrapEmailLayout("Nouveau candidat convoyeur à valider",
        `<p>Bonjour l'administrateur,</p><p>Un nouveau convoyeur vient de réussir le parcours de formation et son quiz.</p>
         <div class="highlight-box"><strong>Nom :</strong> ${candidat.prenom} ${candidat.nom}<br><strong>Email :</strong> ${candidat.email}<br><strong>Score Quiz :</strong> ${candidat.score_quiz}/12</div>
         <p>Veuillez examiner ses pièces et valider son profil dans l'onglet "Candidatures" du tableau de bord Admin.</p>
         <p style="text-align:center"><a href="https://bathily-convoyage.fr/dashboard-admin.html" class="btn">Voir la candidature</a></p>`);
      await sendEmail({ to: candidat.email, subject: "Bathily Convoyage - Candidature reçue avec succès", html: candidatHtml });
      await sendEmail({ to: ADMIN_EMAIL, subject: `[ADMIN] Nouveau candidat convoyeur - ${candidat.prenom} ${candidat.nom}`, html: adminHtml });
      resultData = { success: true, message: 'Emails candidature envoyés.' };
    }
    else if (trigger === 'candidature_status_changed') {
      const { data: candidat, error } = await supabase.from('convoyeur_candidatures')
        .select('id, prenom, nom, email, score_quiz, statut').eq('id', id).single();
      if (error || !candidat) throw new Error(`Candidat introuvable: ${error?.message}`);
      if (candidat.statut === 'approved') {
        const welcomeHtml = wrapEmailLayout("Bienvenue dans l'équipe Bathily Convoyage !",
          `<p>Bonjour ${candidat.prenom},</p><p>Nous avons le plaisir de vous annoncer que votre candidature de convoyeur a été <strong>approuvée</strong> par notre équipe !</p>
           <p>Votre profil est désormais actif. Vous recevrez prochainement vos accès pour vous connecter à l'Espace Convoyeur.</p>
           <div class="highlight-box"><strong>Étapes pour vous connecter :</strong><br>1. Attendez l'email avec vos identifiants<br>2. Cliquez sur le lien pour définir votre mot de passe<br>3. Connectez-vous sur votre Espace Convoyeur</div>
           <p style="text-align:center"><a href="https://bathily-convoyage.fr/dashboard-convoyeur.html" class="btn">Accéder à mon Espace Convoyeur</a></p>`);
        await sendEmail({ to: candidat.email, subject: "Votre candidature convoyeur a été approuvée", html: welcomeHtml });
      } else if (candidat.statut === 'rejected') {
        const rejectionHtml = wrapEmailLayout("Mise à jour concernant votre candidature",
          `<p>Bonjour ${candidat.prenom},</p><p>Nous vous remercions pour l'intérêt que vous portez à Bathily Convoyage.</p>
           <p>Après étude de votre dossier, nous avons le regret de vous informer que nous ne pouvons pas valider votre candidature pour le moment.</p>
           ${notes ? `<div class="highlight-box"><strong>Motif de l'équipe :</strong> ${notes}</div>` : ''}
           <p>Nous vous souhaitons une excellente continuation dans vos projets professionnels.</p>`);
        await sendEmail({ to: candidat.email, subject: "Mise à jour concernant votre candidature - Bathily Convoyage", html: rejectionHtml });
      }
      resultData = { success: true, message: 'Email de notification candidat envoyé.' };
    }
    else if (trigger === 'edl_completed') {
      const { data: edl, error } = await supabase.from('edls')
        .select('id, reference, type, mission_id, convoyeur_nom, email_client, kilometrage, niveau_carburant, conforme, dommages, signatures, photos, created_at, missions(id, reference, client_email, client_nom, depart, arrivee, vehicule)')
        .eq('mission_id', id).order('created_at', { ascending: false }).limit(1).single();
      if (error || !edl) throw new Error(`État des lieux introuvable: ${error?.message}`);
      const mission = edl.missions || {};
      const typeLabel = edl.type === 'depart' ? 'Départ' : 'Arrivée';
      const emailTo = edl.email_client || mission.client_email || 'client@email.fr';
      let damagesHtml = '<p>Aucun dommage signalé.</p>';
      if (edl.dommages && edl.dommages.length > 0) {
        damagesHtml = '<ul>' + edl.dommages.map(d => `<li><strong>${d.zone}</strong> (${d.type}) : ${d.desc}</li>`).join('') + '</ul>';
      }
      let signaturesHtml = '';
      if (edl.signatures) {
        signaturesHtml = `<h3>Signatures :</h3><div style="display:flex;gap:20px;flex-wrap:wrap">
          ${edl.signatures.convoyeur ? `<div style="flex:1;min-width:200px;border:1px solid #E8E1D9;border-radius:12px;padding:10px;background:#fff;text-align:center"><div style="font-size:11px;font-weight:bold;text-transform:uppercase;color:#0A4D68;margin-bottom:5px">Convoyeur</div><img src="${edl.signatures.convoyeur}" style="max-height:80px;max-width:100%" alt="Signature Convoyeur"/></div>` : ''}
          ${edl.signatures.client ? `<div style="flex:1;min-width:200px;border:1px solid #E8E1D9;border-radius:12px;padding:10px;background:#fff;text-align:center"><div style="font-size:11px;font-weight:bold;text-transform:uppercase;color:#0A4D68;margin-bottom:5px">Client</div><img src="${edl.signatures.client}" style="max-height:80px;max-width:100%" alt="Signature Client"/></div>` : ''}
        </div>`;
      }
      const clientHtml = wrapEmailLayout(`Votre État des lieux d'${typeLabel} est disponible`,
        `<p>Bonjour,</p><p>Nous vous confirmons la signature et la validation de l'état des lieux de <strong>${typeLabel.toLowerCase()}</strong> pour votre véhicule.</p>
         <div class="highlight-box"><strong>Référence EDL :</strong> ${edl.reference}<br><strong>Mission :</strong> ${mission.reference || '—'}<br><strong>Type :</strong> État des lieux de ${typeLabel.toLowerCase()}</div>
         <h3>Informations véhicule & trajet :</h3><ul class="meta-list">
         <li><span>Kilométrage relevé :</span> <strong>${edl.kilometrage} km</strong></li><li><span>Niveau de carburant :</span> <strong>${edl.niveau_carburant}%</strong></li>
         <li><span>État général :</span> <strong>${edl.conforme ? 'Conforme' : 'Non-conforme ou réserves'}</strong></li></ul>
         <h3>Dommages et anomalies signalés :</h3>${damagesHtml}${signaturesHtml}
         <p>Cet e-mail fait office de reçu contradictoire d'état des lieux.</p>
         <p style="text-align:center"><a href="https://bathily-convoyage.fr/dashboard-client.html" class="btn">Accéder à mon Espace Client</a></p>`);
      const adminHtml = wrapEmailLayout(`État des lieux d'${typeLabel} complété - ${edl.reference}`,
        `<p>Bonjour l'administrateur,</p><p>Un état des lieux de <strong>${typeLabel.toLowerCase()}</strong> vient d'être validé par le convoyeur <strong>${edl.convoyeur_nom}</strong>.</p>
         <div class="highlight-box"><strong>Référence EDL :</strong> ${edl.reference}<br><strong>Convoyeur :</strong> ${edl.convoyeur_nom}<br><strong>Kilométrage :</strong> ${edl.kilometrage} km · <strong>Carburant :</strong> ${edl.niveau_carburant}%</div>
         <h3>Anomalies / Dommages :</h3>${damagesHtml}${signaturesHtml}
         <p style="text-align:center"><a href="https://bathily-convoyage.fr/dashboard-admin.html" class="btn">Accéder au panel Admin</a></p>`);
      await sendEmail({ to: emailTo, subject: `Bathily Convoyage - État des lieux ${typeLabel} - Réf: ${edl.reference}`, html: clientHtml });
      await sendEmail({ to: ADMIN_EMAIL, subject: `[ADMIN] EDL ${typeLabel} complété - Réf: ${edl.reference}`, html: adminHtml });
      resultData = { success: true, message: 'Emails état des lieux envoyés.' };
    }
    else if (trigger === 'payment_success') {
      const { data: mission, error } = await supabase.from('missions')
        .select('id, reference, client_nom, client_email, client_telephone, depart, arrivee, vehicule, mode, pack, montant_ht, paiement_statut, status, convoyeur_nom, convoyeur_id, date_mission')
        .eq('id', id).single();
      if (error || !mission) throw new Error(`Mission introuvable: ${error?.message}`);
      const emailTo = mission.client_email || 'client@email.fr';
      const priceAmount = parseFloat(mission.montant_ht) || 0;
      const clientHtml = wrapEmailLayout("Votre paiement a été validé ! 🎉",
        `<p>Bonjour ${mission.client_nom.split(' ')[0] || ''},</p><p>Nous vous remercions pour votre règlement. Votre paiement a bien été traité avec succès et votre mission est désormais confirmée.</p>
         ${temp_password ? `<div class="highlight-box"><strong>Vos identifiants :</strong><br>Email : ${mission.client_email}<br>Mot de passe temporaire : <strong>${temp_password}</strong></div>` : ''}
         <div class="highlight-box"><strong>Référence Mission :</strong> ${mission.reference}<br><strong>Montant payé :</strong> ${priceAmount.toFixed(2)} €</div>
         <h3>Récapitulatif :</h3><ul class="meta-list">
         <li><span>Véhicule :</span> <strong>${mission.vehicule}</strong></li><li><span>Départ :</span> <strong>${mission.depart}</strong></li>
         <li><span>Arrivée :</span> <strong>${mission.arrivee}</strong></li><li><span>Mode :</span> <strong>${mission.mode === 'plateau' ? 'Plateau' : 'Par la route'}</strong></li>
         <li><span>Pack :</span> <strong>${mission.pack || 'Starter'}</strong></li></ul>
         <p style="text-align:center"><a href="https://bathily-convoyage.fr/dashboard-client.html" class="btn">Accéder à mon Espace Client</a></p>`);
      const adminHtml = wrapEmailLayout(`Paiement reçu pour la mission ${mission.reference}`,
        `<p>Bonjour l'administrateur,</p><p>Le paiement pour la mission <strong>${mission.reference}</strong> a été validé via Stripe.</p>
         <div class="highlight-box"><strong>Référence :</strong> ${mission.reference}<br><strong>Client :</strong> ${mission.client_nom}<br>
         <strong>Montant :</strong> ${priceAmount.toFixed(2)} €<br><strong>Convoyeur :</strong> ${mission.convoyeur_nom || 'Non assigné'}</div>
         <p style="text-align:center"><a href="https://bathily-convoyage.fr/dashboard-admin.html" class="btn">Accéder au panel Admin</a></p>`);
      await sendEmail({ to: emailTo, subject: `Bathily Convoyage - Confirmation de paiement ${mission.reference}`, html: clientHtml });
      await sendEmail({ to: ADMIN_EMAIL, subject: `[ADMIN] Paiement reçu pour la mission ${mission.reference}`, html: adminHtml });
      resultData = { success: true, message: 'Emails paiement validé envoyés.' };
    }
    else if (trigger === 'devis_confirmed') {
      const paymentUrl = payment_url;
      const { data: devis, error } = await supabase.from('devis')
        .select('id, reference, client_prenom, client_nom, client_email, depart, arrivee, vehicule, mode, pack, total_ht, details, date_livraison, heure_livraison, status, created_at')
        .eq('id', id).single();
      if (error || !devis) throw new Error(`Devis introuvable: ${error?.message}`);
      const clientHtml = wrapEmailLayout("Votre devis a été validé — Procédez au paiement",
        `<p>Bonjour ${devis.client_prenom || 'Client'},</p><p>Bonne nouvelle ! Votre devis a été validé. Vous pouvez maintenant procéder au paiement sécurisé.</p>
         <div class="highlight-box"><strong>Référence :</strong> ${devis.reference}<br><strong>Trajet :</strong> ${devis.depart} → ${devis.arrivee}<br><strong>Montant :</strong> ${devis.total_ht} €${devis.date_livraison ? `<br><strong>Date de livraison :</strong> ${new Date(devis.date_livraison).toLocaleDateString('fr-FR')}${devis.heure_livraison ? ' à ' + devis.heure_livraison : ''}` : ''}</div>
         <p style="text-align:center"><a href="${paymentUrl}" class="btn">Payer maintenant</a></p>`);
      await sendEmail({ to: devis.client_email, subject: `Bathily Convoyage - Votre devis ${devis.reference} est prêt`, html: clientHtml });
      resultData = { success: true, message: 'Email lien paiement envoyé.' };
    }
    else if (trigger === 'pro_approved') {
      const proEmail = directEmail || id;
      const proName = directNom || prenom || 'Professionnel';
      const proHtml = wrapEmailLayout("Votre compte Pro est activé ! 🎉",
        `<p>Bonjour <strong>${proName}</strong>,</p><p>Votre demande de compte Pro a été <strong>validée</strong>.</p>
         <ul class="meta-list"><li><span>Tarifs</span> <strong>0,90 €/km route · 1,05 €/km plateau</strong></li>
         <li><span>Facturation</span> <strong>TVA non applicable — franchise en base (art. 293 B CGI)</strong></li><li><span>Support</span> <strong>Dédié et prioritaire</strong></li></ul>
         <div class="highlight-box"><strong>Avantages Pro :</strong><br>✓ Remise de 10%<br>✓ Factures détaillées<br>✓ Interlocuteur unique<br>✓ Devis en ligne Pro</div>
         <p style="text-align:center"><a href="https://bathily-convoyage.fr/dashboard-client.html" class="btn">Accéder à mon Espace Pro</a></p>`);
      await sendEmail({ to: proEmail, subject: "Bathily Convoyage - Votre compte Pro est activé !", html: proHtml });
      resultData = { success: true, message: 'Email Pro validé envoyé.' };
    }
    else if (trigger === 'pro_rejected') {
      const proEmail = directEmail || id;
      const proName = directNom || prenom || 'Professionnel';
      const rejectHtml = wrapEmailLayout("Mise à jour de votre demande de compte Pro",
        `<p>Bonjour <strong>${proName}</strong>,</p><p>Après examen de votre demande, nous ne sommes pas en mesure de valider votre compte Pro pour le moment.</p>
         <div class="highlight-box"><strong>Contact :</strong> contact@bathily-convoyage.fr</div>
         <p>Vous pouvez toujours utiliser nos services au tarif public via notre site.</p>
         <p style="text-align:center"><a href="https://bathily-convoyage.fr" class="btn">Accéder au site</a></p>`);
      await sendEmail({ to: proEmail, subject: "Bathily Convoyage - Mise à jour de votre demande Pro", html: rejectHtml });
      resultData = { success: true, message: 'Email Pro refusé envoyé.' };
    }
    else if (trigger === 'mission_assigned') {
      const missionRef = reference || id;
      const missionDepart = depart || 'Non précisé';
      const missionArrivee = arrivee || 'Non précisé';
      const missionDate = date_mission ? new Date(date_mission).toLocaleDateString('fr-FR') : 'Non précisée';
      const convName = convoyeur_nom || 'un convoyeur';

      // Email au client
      const clientEmail = client_email || directEmail;
      if (clientEmail) {
        const clientHtml = wrapEmailLayout("Un convoyeur a été assigné à votre mission",
          `<p>Bonjour,</p><p>Votre mission <strong>${missionRef}</strong> a été assignée à <strong>${convName}</strong>.</p>
           <ul class="meta-list"><li><span>Trajet</span><strong>${missionDepart} → ${missionArrivee}</strong></li><li><span>Date</span><strong>${missionDate}</strong></li></ul>
           <p style="text-align:center"><a href="https://bathily-convoyage.fr/dashboard-client.html" class="btn">Suivre ma mission</a></p>`);
        await sendEmail({ to: clientEmail, subject: "Bathily Convoyage - Un convoyeur a été assigné à votre mission", html: clientHtml });
      }

      // Email au convoyeur
      if (convoyeur_email) {
        const convoyeurHtml = wrapEmailLayout("Nouvelle mission assignée 🚗",
          `<p>Bonjour ${convoyeur_nom || ''},</p><p>Une nouvelle mission vous a été assignée.</p>
           <ul class="meta-list"><li><span>Référence</span><strong>${missionRef}</strong></li><li><span>Trajet</span><strong>${missionDepart} → ${missionArrivee}</strong></li><li><span>Date</span><strong>${missionDate}</strong></li></ul>
           <p style="text-align:center"><a href="https://bathily-convoyage.fr/dashboard-convoyeur.html" class="btn">Voir ma mission</a></p>`);
        await sendEmail({ to: convoyeur_email, subject: "Bathily Convoyage - Nouvelle mission assignée", html: convoyeurHtml });
      }

      resultData = { success: true, message: 'Emails mission assignée envoyés.' };
    }
    else if (trigger === 'support_reply') {
      const { data: ticket, error: ticketErr } = await supabase.from('support_tickets')
        .select('id, sujet, message, reponse, client_email, client_nom').eq('id', id).single();
      if (ticketErr || !ticket) throw new Error(`Ticket introuvable: ${ticketErr?.message}`);
      const replyEmail = client_email || ticket.client_email;
      if (!replyEmail) {
        resultData = { success: false, message: 'Pas d\'email client pour répondre.' };
      } else {
        const replyHtml = wrapEmailLayout("Réponse à votre demande de support",
          `<p>Bonjour ${ticket.client_nom || ''},</p><p>Votre demande de support a reçu une réponse :</p>
           <div class="highlight-box"><strong>Sujet :</strong> ${ticket.sujet}<br><strong>Votre message :</strong> ${ticket.message}</div>
           <p><strong>Réponse :</strong> ${ticket.reponse}</p>`);
        await sendEmail({ to: replyEmail, subject: "Bathily Convoyage - Réponse à votre demande", html: replyHtml });
        resultData = { success: true, message: 'Email support envoyé.' };
      }
    }

    return jsonResponse(resultData, 200, getCorsHeaders(request));

  } catch (error) {
    console.error('Erreur send-email:', error);
    return jsonResponse({ error: error.message || 'Erreur interne' }, 500, getCorsHeaders(request));
  }
}
