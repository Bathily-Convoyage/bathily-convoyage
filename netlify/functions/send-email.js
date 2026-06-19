const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event, context) => {
  // CORS Headers
  const allowedOrigins = ['https://www.bathily-convoyage.fr', 'https://bathily-convoyage.fr'];
  const origin = event.headers.origin || event.headers.Origin || '';
  const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  const headers = {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Méthode non autorisée. Utilisez POST.' })
    };
  }

  try {
    const parsedBody = JSON.parse(event.body);
    const { trigger, id, notes, payment_url, temp_password, prenom } = parsedBody;

    if (!trigger || !id) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Paramètres trigger et id requis.' })
      };
    }

    // Initialize Supabase
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("Variables de configuration Supabase manquantes dans l'environnement.");
    }
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    // Initialize Resend
    const resendApiKey = process.env.RESEND_API_KEY;
    if (!resendApiKey) {
      console.warn("Attention : RESEND_API_KEY manquante. Les e-mails seront loggés mais pas envoyés.");
    }

    // Sender config
    const FROM_EMAIL = process.env.EMAIL_FROM || 'onboarding@resend.dev';
    const ADMIN_EMAIL = process.env.EMAIL_ADMIN || 'contact@bathily-convoyage.fr';

    // Helper function to send email via Resend REST API
    async function sendEmail({ to, subject, html }) {
      if (!resendApiKey) {
        console.log(`[SIMULATION EMAIL]
A: ${to}
Sujet: ${subject}
Corps: ${html.substring(0, 300)}...`);
        return { simulated: true };
      }

      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: `Bathily Convoyage <${FROM_EMAIL}>`,
          to: Array.isArray(to) ? to : [to],
          subject: subject,
          html: html
        })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(`Erreur API Resend: ${data.message || response.statusText}`);
      }
      return data;
    }

    // Brand email layout wrapper
    function wrapEmailLayout(contentTitle, contentBody) {
      return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: 'Helvetica Neue', Arial, sans-serif; background-color: #FDFBF7; color: #2D2A24; margin: 0; padding: 20px; }
          .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 20px; border: 1px solid #E8E1D9; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.03); }
          .header { background-color: #0A4D68; padding: 30px; text-align: center; color: #ffffff; }
          .header h1 { margin: 0; font-size: 24px; font-weight: 800; letter-spacing: -0.02em; }
          .content { padding: 40px 30px; line-height: 1.6; font-size: 15px; }
          .footer { background-color: #F9F6F0; padding: 20px; text-align: center; font-size: 12px; color: #6B625A; border-top: 1px solid #E8E1D9; }
          .btn { display: inline-block; background-color: #0A4D68; color: #ffffff !important; text-decoration: none; padding: 12px 28px; border-radius: 40px; font-weight: 700; margin-top: 20px; font-size: 14px; }
          .highlight-box { background-color: #E6F0F4; border-left: 4px solid #0A4D68; padding: 15px; border-radius: 8px; margin: 20px 0; }
          .meta-list { margin: 0; padding: 0; list-style: none; }
          .meta-list li { padding: 8px 0; border-bottom: 1px solid #F3F4F6; display: flex; justify-content: space-between; }
          .meta-list li strong { color: #0A4D68; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Bathily Convoyage.</h1>
          </div>
          <div class="content">
            <h2 style="color: #0A4D68; margin-top: 0;">${contentTitle}</h2>
            ${contentBody}
          </div>
          <div class="footer">
            © 2025 Bathily Convoyage — Convoyage automobile & moto en France.<br>
            Besoin d'aide ? <a href="mailto:${ADMIN_EMAIL}" style="color:#0A4D68;">Contactez-nous</a>
          </div>
        </div>
      </body>
      </html>`;
    }

    let resultData = {};

    // ==========================================
    // 0. ÉVÉNEMENT : CONVOYEUR APPROUVÉ
    // ==========================================
    if (trigger === 'convoyeur_approved') {
      const email = id; // id est en fait l'email du convoyeur
      const convoyeurPrenom = prenom || 'Convoyeur';
      const tempPwd = temp_password;

      const welcomeHtml = wrapEmailLayout(
        "Votre compte convoyeur est activé ! 🚚",
        `<p>Bonjour ${convoyeurPrenom},</p>
         <p>Nous avons le plaisir de vous annoncer que votre compte convoyeur a été **activé** !</p>
         <p>Vous pouvez désormais vous connecter à votre espace convoyeur et postuler aux missions disponibles.</p>
         <div class="highlight-box">
           <strong>Vos identifiants de connexion :</strong><br>
           <strong>Email :</strong> ${email}<br>
           <strong>Mot de passe temporaire :</strong> <code style="background:#F9F6F0;padding:2px 8px;border-radius:4px;font-size:14px;font-weight:bold;">${tempPwd}</code>
           <br><br>
           <small>Nous vous recommandons de modifier ce mot de passe lors de votre première connexion.</small>
         </div>
         <p style="text-align: center;">
           <a href="https://bathily-convoyage.fr/dashboard-convoyeur.html" class="btn">Accéder à mon Espace Convoyeur</a>
         </p>
         <h3>Pour bien démarrer :</h3>
         <ul>
           <li>✅ Consultez les missions disponibles dans l'onglet "Marché"</li>
           <li>✅ Postulez aux missions qui vous correspondent</li>
           <li>✅ Activez votre GPS lors de chaque prise en charge</li>
           <li>✅ Réalisez les 20 photos d'état des lieux à chaque mission</li>
         </ul>`
      );

      await sendEmail({ to: email, subject: "Votre compte convoyeur Bathily est activé ! 🚚", html: welcomeHtml });
      resultData = { success: true, message: 'Email de bienvenue convoyeur envoyé.' };
    }

    // ==========================================
    // 1. ÉVÉNEMENT : DEVIS CRÉÉ
    // ==========================================
    else if (trigger === 'devis_created') {
      // ... (identique à l'original)
      const { data: devis, error } = await supabase
        .from('devis')
        .select('*')
        .eq('id', id)
        .single();

      if (error || !devis) throw new Error(`Devis introuvable: ${error?.message}`);

      const details = devis.details || {};
      const devisURL = `https://bathily-convoyage.fr/dashboard-client.html`;

      const clientHtml = wrapEmailLayout(
        "Votre demande de devis est bien reçue !",
        `<p>Bonjour ${devis.client_prenom || ''},</p>
         <p>Nous vous remercions pour votre demande de devis sur notre plateforme. Un conseiller étudie votre dossier. Vous recevrez une proposition de prix définitive sous 2h.</p>
         <div class="highlight-box">
           <strong>Référence du devis :</strong> ${devis.reference}<br>
           <strong>Montant estimatif :</strong> ${devis.total_ht} € HT
         </div>
         <h3>Récapitulatif de votre demande :</h3>
         <ul class="meta-list">
           <li><span>Véhicule :</span> <strong>${devis.vehicule}</strong></li>
           <li><span>Départ :</span> <strong>${devis.depart}</strong></li>
           <li><span>Arrivée :</span> <strong>${devis.arrivee}</strong></li>
           <li><span>Mode de transport :</span> <strong>${details.mode === 'plateau' ? 'Plateau' : 'Par la route'}</strong></li>
           <li><span>Pack choisi :</span> <strong>${details.pack || 'Starter'}</strong></li>
         </ul>
         <p style="text-align: center;">
           <a href="${devisURL}" class="btn">Accéder à mon Espace Client</a>
         </p>`
      );

      const adminHtml = wrapEmailLayout(
        "Nouvelle demande de devis à valider",
        `<p>Bonjour l'administrateur,</p>
         <p>Un nouveau devis vient d'être soumis sur la plateforme et attend votre validation.</p>
         <div class="highlight-box">
           <strong>Référence :</strong> ${devis.reference}<br>
           <strong>Client :</strong> ${devis.client_prenom} ${devis.client_nom} (${devis.client_email})
         </div>
         <p>Veuillez vous rendre sur le panel d'administration pour valider le tarif et assigner un convoyeur.</p>
         <p style="text-align: center;">
           <a href="https://bathily-convoyage.fr/dashboard-admin.html" class="btn">Accéder au panel Admin</a>
         </p>`
      );

      await sendEmail({ to: devis.client_email, subject: `Bathily Convoyage - Demande de devis ${devis.reference}`, html: clientHtml });
      await sendEmail({ to: ADMIN_EMAIL, subject: `[ADMIN] Nouveau devis à valider - ${devis.reference}`, html: adminHtml });
      resultData = { success: true, message: 'Emails devis envoyés.' };
    }

    // ==========================================
    // 2. ÉVÉNEMENT : CANDIDATURE SOUMISE
    // ==========================================
    else if (trigger === 'candidature_submitted') {
      // ... (identique à l'original)
      const { data: candidat, error } = await supabase
        .from('convoyeurs_candidats')
        .select('*')
        .eq('id', id)
        .single();

      if (error || !candidat) throw new Error(`Candidat introuvable: ${error?.message}`);

      const candidatHtml = wrapEmailLayout(
        "Félicitations pour votre réussite au quiz !",
        `<p>Bonjour ${candidat.prenom},</p>
         <p>Nous avons le plaisir de vous confirmer que votre candidature a bien été reçue. Vous avez obtenu un score de <strong>${candidat.score_quiz}/12</strong> au quiz de formation.</p>
         <p>Votre dossier est en attente de vérification par notre équipe administrative. Nous reviendrons vers vous sous 24h à 48h ouvrées.</p>
         <div class="highlight-box">
           <strong>Statut de votre dossier :</strong> En cours d'examen<br>
           <strong>Email de contact :</strong> ${candidat.email}
         </div>
         <p>Une fois votre compte validé, vous recevrez vos accès complets pour vous connecter à l'Espace Convoyeur.</p>`
      );

      const adminHtml = wrapEmailLayout(
        "Nouveau candidat convoyeur à valider",
        `<p>Bonjour l'administrateur,</p>
         <p>Un nouveau convoyeur vient de réussir le parcours de formation et son quiz.</p>
         <div class="highlight-box">
           <strong>Nom :</strong> ${candidat.prenom} ${candidat.nom}<br>
           <strong>Email :</strong> ${candidat.email}<br>
           <strong>Score Quiz :</strong> ${candidat.score_quiz}/12
         </div>
         <p>Veuillez examiner ses pièces et valider son profil dans l'onglet "Candidatures" du tableau de bord Admin.</p>
         <p style="text-align: center;">
           <a href="https://bathily-convoyage.fr/dashboard-admin.html" class="btn">Voir la candidature</a>
         </p>`
      );

      await sendEmail({ to: candidat.email, subject: "Bathily Convoyage - Candidature reçue avec succès", html: candidatHtml });
      await sendEmail({ to: ADMIN_EMAIL, subject: `[ADMIN] Nouveau candidat convoyeur - ${candidat.prenom} ${candidat.nom}`, html: adminHtml });
      resultData = { success: true, message: 'Emails candidature envoyés.' };
    }

    // ==========================================
    // 3. ÉVÉNEMENT : STATUT CANDIDATURE MODIFIÉ
    // ==========================================
    else if (trigger === 'candidature_status_changed') {
      // ... (identique à l'original)
      const { data: candidat, error } = await supabase
        .from('convoyeurs_candidats')
        .select('*')
        .eq('id', id)
        .single();

      if (error || !candidat) throw new Error(`Candidat introuvable: ${error?.message}`);

      if (candidat.statut === 'approved') {
        const welcomeHtml = wrapEmailLayout(
          "Bienvenue dans l'équipe Bathily Convoyage ! 🎉",
          `<p>Bonjour ${candidat.prenom},</p>
           <p>Nous avons le plaisir de vous annoncer que votre candidature de convoyeur a été **approuvée** par notre équipe !</p>
           <p>Votre profil est désormais actif. Vous pouvez vous connecter à votre Espace Convoyeur et commencer à proposer vos services sur le marché des missions.</p>
           <div class="highlight-box">
             <strong>Lien de connexion :</strong> <a href="https://bathily-convoyage.fr/dashboard-convoyeur.html">dashboard-convoyeur.html</a><br>
             <strong>Votre identifiant :</strong> Sélectionnez votre nom dans la liste au démarrage.
           </div>
           <h3>Conseils pour débuter :</h3>
           <ul>
             <li>Vérifiez régulièrement l'onglet "Marché des missions" pour postuler.</li>
             <li>Assurez-vous d'avoir l'application GPS active lors de chaque prise en charge.</li>
             <li>Effectuez toujours les 20 photos obligatoires lors de l'état des lieux.</li>
           </ul>
           <p style="text-align: center;">
             <a href="https://bathily-convoyage.fr/dashboard-convoyeur.html" class="btn">Accéder à mon Espace Convoyeur</a>
           </p>`
        );
        await sendEmail({ to: candidat.email, subject: "Votre compte convoyeur Bathily a été activé ! 🎉", html: welcomeHtml });
      } else if (candidat.statut === 'rejected') {
        const rejectionHtml = wrapEmailLayout(
          "Mise à jour concernant votre candidature",
          `<p>Bonjour ${candidat.prenom},</p>
           <p>Nous vous remercions pour l'intérêt que vous portez à Bathily Convoyage.</p>
           <p>Après étude de votre dossier, nous avons le regret de vous informer que nous ne pouvons pas valider votre candidature pour le moment.</p>
           ${notes ? `<div class="highlight-box"><strong>Motif de l'équipe :</strong> ${notes}</div>` : ''}
           <p>Nous vous souhaitons une excellente continuation dans vos projets professionnels.</p>`
        );
        await sendEmail({ to: candidat.email, subject: "Mise à jour concernant votre candidature - Bathily Convoyage", html: rejectionHtml });
      }
      resultData = { success: true, message: 'Email de notification candidat envoyé.' };
    }

    // ==========================================
    // 4. ÉVÉNEMENT : ÉTAT DES LIEUX VALIDÉ
    // ==========================================
    else if (trigger === 'edl_completed') {
      // ... (identique à l'original)
      const { data: edl, error } = await supabase
        .from('edls')
        .select('*, missions(*)')
        .eq('id', id)
        .single();

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
        signaturesHtml = `
          <h3>Signatures :</h3>
          <div style="display: flex; gap: 20px; flex-wrap: wrap;">
            ${edl.signatures.convoyeur ? `
              <div style="flex: 1; min-width: 200px; border: 1px solid #E8E1D9; border-radius: 12px; padding: 10px; background: #fff; text-align: center;">
                <div style="font-size: 11px; font-weight: bold; text-transform: uppercase; color: #0A4D68; margin-bottom: 5px;">Convoyeur</div>
                <img src="${edl.signatures.convoyeur}" style="max-height: 80px; max-width: 100%;" alt="Signature Convoyeur" />
              </div>
            ` : ''}
            ${edl.signatures.client ? `
              <div style="flex: 1; min-width: 200px; border: 1px solid #E8E1D9; border-radius: 12px; padding: 10px; background: #fff; text-align: center;">
                <div style="font-size: 11px; font-weight: bold; text-transform: uppercase; color: #0A4D68; margin-bottom: 5px;">Client</div>
                <img src="${edl.signatures.client}" style="max-height: 80px; max-width: 100%;" alt="Signature Client" />
              </div>
            ` : ''}
          </div>
        `;
      }

      const clientHtml = wrapEmailLayout(
        `Votre État des lieux d'${typeLabel} est disponible`,
        `<p>Bonjour,</p>
         <p>Nous vous confirmons la signature et la validation de l'état des lieux de <strong>${typeLabel.toLowerCase()}</strong> pour votre véhicule.</p>
         <div class="highlight-box">
           <strong>Référence EDL :</strong> ${edl.reference}<br>
           <strong>Mission :</strong> ${mission.reference || edl.reference.split('-').slice(1, -2).join('-') || '—'}<br>
           <strong>Type :</strong> État des lieux de ${typeLabel.toLowerCase()}
         </div>
         <h3>Informations véhicule & trajet :</h3>
         <ul class="meta-list">
           <li><span>Kilométrage relevé :</span> <strong>${edl.kilometrage} km</strong></li>
           <li><span>Niveau de carburant :</span> <strong>${edl.niveau_carburant}%</strong></li>
           <li><span>État général :</span> <strong>${edl.conforme ? 'Conforme (Aucun défaut bloquant)' : 'Non-conforme ou réserves signalées'}</strong></li>
         </ul>
         <h3>Dommages et anomalies signalés :</h3>
         ${damagesHtml}
         ${signaturesHtml}
         <p>Cet e-mail fait office de reçu contradictoire d'état des lieux. Le document complet au format PDF imprimable est disponible dans votre espace client.</p>
         <p style="text-align: center;">
           <a href="https://bathily-convoyage.fr/dashboard-client.html" class="btn">Accéder à mon Espace Client</a>
         </p>`
      );

      const adminHtml = wrapEmailLayout(
        `État des lieux d'${typeLabel} complété - ${edl.reference}`,
        `<p>Bonjour l'administrateur,</p>
         <p>Un état des lieux de <strong>${typeLabel.toLowerCase()}</strong> vient d'être validé et signé par le convoyeur <strong>${edl.convoyeur_nom}</strong> pour la mission <strong>${mission.reference || ''}</strong>.</p>
         <div class="highlight-box">
           <strong>Référence EDL :</strong> ${edl.reference}<br>
           <strong>Convoyeur :</strong> ${edl.convoyeur_nom}<br>
           <strong>Kilométrage :</strong> ${edl.kilometrage} km · <strong>Carburant :</strong> ${edl.niveau_carburant}%
         </div>
         <h3>Anomalies / Dommages :</h3>
         ${damagesHtml}
         ${signaturesHtml}
         <p style="text-align: center;">
           <a href="https://bathily-convoyage.fr/dashboard-admin.html" class="btn">Accéder au panel Admin</a>
         </p>`
      );

      await sendEmail({ to: emailTo, subject: `Bathily Convoyage - État des lieux ${typeLabel} - Réf: ${edl.reference}`, html: clientHtml });
      await sendEmail({ to: ADMIN_EMAIL, subject: `[ADMIN] EDL ${typeLabel} complété - Réf: ${edl.reference}`, html: adminHtml });
      resultData = { success: true, message: 'Emails état des lieux envoyés.' };
    }

    // ==========================================
    // 5. ÉVÉNEMENT : PAIEMENT VALIDÉ
    // ==========================================
    else if (trigger === 'payment_success') {
      // ... (identique à l'original)
      const { data: mission, error } = await supabase
        .from('missions')
        .select('*')
        .eq('id', id)
        .single();

      if (error || !mission) throw new Error(`Mission introuvable: ${error?.message}`);

      const emailTo = mission.client_email || 'client@email.fr';
      const priceHt = parseFloat(mission.montant_ht) || 0;
      const priceTtc = priceHt * 1.20;

      const clientHtml = wrapEmailLayout(
        "Votre paiement a été validé ! 🎉",
        `<p>Bonjour ${mission.client_nom.split(' ')[0] || ''},</p>
         <p>Nous vous remercions pour votre règlement. Votre paiement a bien été traité avec succès et votre mission est désormais confirmée.</p>
         ${temp_password ? `<div class="highlight-box"><strong>Vos identifiants de connexion :</strong><br>Email : ${mission.client_email}<br>Mot de passe temporaire : <strong>${temp_password}</strong><br><small>Modifiez-le depuis votre espace client.</small></div>` : ''}
         <div class="highlight-box">
           <strong>Référence Mission :</strong> ${mission.reference}<br>
           <strong>Montant payé :</strong> ${priceTtc.toFixed(2)} € TTC (TVA 20% incluse)
         </div>
         <h3>Récapitulatif de la mission :</h3>
         <ul class="meta-list">
           <li><span>Véhicule :</span> <strong>${mission.vehicule}</strong></li>
           <li><span>Départ :</span> <strong>${mission.depart}</strong></li>
           <li><span>Arrivée :</span> <strong>${mission.arrivee}</strong></li>
           <li><span>Mode de transport :</span> <strong>${mission.mode_transport === 'plateau' ? 'Plateau' : 'Par la route'}</strong></li>
           <li><span>Pack choisi :</span> <strong>${mission.pack || 'Starter'}</strong></li>
         </ul>
         <p>Le convoyeur affecté prendra en charge votre véhicule selon les modalités convenues. Vous pouvez suivre l'état de votre mission en temps réel sur votre tableau de bord client.</p>
         <p style="text-align: center;">
           <a href="https://bathily-convoyage.fr/dashboard-client.html" class="btn">Accéder à mon Espace Client</a>
         </p>`
      );

      const adminHtml = wrapEmailLayout(
        `Paiement reçu pour la mission ${mission.reference}`,
        `<p>Bonjour l'administrateur,</p>
         <p>Le paiement pour la mission <strong>${mission.reference}</strong> a été validé via Stripe.</p>
         <div class="highlight-box">
           <strong>Référence :</strong> ${mission.reference}<br>
           <strong>Client :</strong> ${mission.client_nom}<br>
           <strong>Montant :</strong> ${priceTtc.toFixed(2)} € TTC (${priceHt.toFixed(2)} € HT)<br>
           <strong>Convoyeur assigné :</strong> ${mission.convoyeur_nom || 'Non assigné'}
         </div>
         <p>Le paiement étant reçu, la mission peut démarrer en toute sécurité.</p>
         <p style="text-align: center;">
           <a href="https://bathily-convoyage.fr/dashboard-admin.html" class="btn">Accéder au panel Admin</a>
         </p>`
      );

      await sendEmail({ to: emailTo, subject: `Bathily Convoyage - Confirmation de paiement ${mission.reference}`, html: clientHtml });
      await sendEmail({ to: ADMIN_EMAIL, subject: `[ADMIN] Paiement reçu pour la mission ${mission.reference}`, html: adminHtml });
      resultData = { success: true, message: 'Emails paiement validé envoyés.' };
    }

    // ==========================================
    // 6. ÉVÉNEMENT : DEVIS CONFIRMÉ + LIEN PAIEMENT
    // ==========================================
    else if (trigger === 'devis_confirmed') {
      // ... (identique à l'original)
      const paymentUrl = payment_url;

      const { data: devis, error } = await supabase
        .from('devis')
        .select('*')
        .eq('id', id)
        .single();

      if (error || !devis) throw new Error(`Devis introuvable: ${error?.message}`);

      const clientEmail = devis.client_email;
      const clientPrenom = devis.client_prenom || 'Client';

      const clientHtml = wrapEmailLayout(
        "Votre devis a été validé — Procédez au paiement",
        `<p>Bonjour ${clientPrenom},</p>
         <p>Bonne nouvelle ! Votre devis de convoyage a été étudié et validé par notre équipe. Vous pouvez maintenant procéder au paiement sécurisé pour confirmer votre mission.</p>
         <div class="highlight-box">
           <strong>Référence :</strong> ${devis.reference}<br>
           <strong>Trajet :</strong> ${devis.depart} → ${devis.arrivee}<br>
           <strong>Montant HT :</strong> ${devis.total_ht} €
         </div>
         <p style="text-align: center;">
           <a href="${paymentUrl}" class="btn">Payer maintenant</a>
         </p>
         <p style="font-size:12px;color:#6B625A;text-align:center">Ce lien est sécurisé et expirera après utilisation.</p>`
      );

      await sendEmail({ to: clientEmail, subject: `Bathily Convoyage - Votre devis ${devis.reference} est prêt`, html: clientHtml });
      resultData = { success: true, message: 'Email lien paiement envoyé.' };
    }

    // ==========================================
    // 7. ÉVÉNEMENT : RÉINITIALISATION DE MOT DE PASSE
    // ==========================================
    else if (trigger === 'reset_password') {
      const email = id; // id est l'email
      const resetLink = `https://bathily-convoyage.fr/reset-password.html`;

      const resetHtml = wrapEmailLayout(
        "Réinitialisation de votre mot de passe",
        `<p>Bonjour,</p>
         <p>Vous avez demandé à réinitialiser votre mot de passe pour votre compte Bathily Convoyage.</p>
         <p>Cliquez sur le bouton ci-dessous pour définir un nouveau mot de passe :</p>
         <p style="text-align: center;">
           <a href="${resetLink}" class="btn">Réinitialiser mon mot de passe</a>
         </p>
         <p style="font-size:12px;color:#6B625A;text-align:center">Ce lien est valable 1 heure. Si vous n'êtes pas à l'origine de cette demande, ignorez simplement cet email.</p>`
      );

      await sendEmail({ to: email, subject: "Bathily Convoyage - Réinitialisation de votre mot de passe", html: resetHtml });
      resultData = { success: true, message: 'Email de réinitialisation envoyé.' };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(resultData)
    };

  } catch (error) {
    console.error("Erreur send-email handler :", error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message || 'Erreur interne du serveur.' })
    };
  }
};