const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event, context) => {
  // CORS Headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
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
    const { trigger, id, notes } = JSON.parse(event.body);

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

    // Sender config (Use verified domain or Resend onboarding email)
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
          .header { background-color: #7A2E1A; padding: 30px; text-align: center; color: #ffffff; }
          .header h1 { margin: 0; font-size: 24px; font-weight: 800; letter-spacing: -0.02em; }
          .content { padding: 40px 30px; line-height: 1.6; font-size: 15px; }
          .footer { background-color: #F9F6F0; padding: 20px; text-align: center; font-size: 12px; color: #6B625A; border-top: 1px solid #E8E1D9; }
          .btn { display: inline-block; background-color: #7A2E1A; color: #ffffff !important; text-decoration: none; padding: 12px 28px; border-radius: 40px; font-weight: 700; margin-top: 20px; font-size: 14px; }
          .highlight-box { background-color: #F3E8E4; border-left: 4px solid #7A2E1A; padding: 15px; border-radius: 8px; margin: 20px 0; }
          .meta-list { margin: 0; padding: 0; list-style: none; }
          .meta-list li { padding: 8px 0; border-bottom: 1px solid #F3F4F6; display: flex; justify-content: space-between; }
          .meta-list li strong { color: #7A2E1A; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Bathily Convoyage.</h1>
          </div>
          <div class="content">
            <h2 style="color: #7A2E1A; margin-top: 0;">${contentTitle}</h2>
            ${contentBody}
          </div>
          <div class="footer">
            © 2025 Bathily Convoyage — Convoyage automobile & moto en France.<br>
            Besoin d'aide ? <a href="mailto:${ADMIN_EMAIL}" style="color:#7A2E1A;">Contactez-nous</a>
          </div>
        </div>
      </body>
      </html>`;
    }

    let resultData = {};

    // ==========================================
    // 1. ÉVÉNEMENT : DEVIS CRÉÉ
    // ==========================================
    if (trigger === 'devis_created') {
      const { data: devis, error } = await supabase
        .from('devis')
        .select('*')
        .eq('id', id)
        .single();

      if (error || !devis) throw new Error(`Devis introuvable: ${error?.message}`);

      const details = devis.details || {};
      const devisURL = `https://bathily-convoyage.netlify.app/dashboard-client.html`;

      // Email client
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

      // Email Admin
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
           <a href="https://bathily-convoyage.netlify.app/dashboard-admin.html" class="btn">Accéder au panel Admin</a>
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
      const { data: candidat, error } = await supabase
        .from('convoyeurs_candidats')
        .select('*')
        .eq('id', id)
        .single();

      if (error || !candidat) throw new Error(`Candidat introuvable: ${error?.message}`);

      // Email candidat
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

      // Email admin
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
           <a href="https://bathily-convoyage.netlify.app/dashboard-admin.html" class="btn">Voir la candidature</a>
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
             <strong>Lien de connexion :</strong> <a href="https://bathily-convoyage.netlify.app/dashboard-convoyeur.html">dashboard-convoyeur.html</a><br>
             <strong>Votre identifiant :</strong> Sélectionnez votre nom dans la liste au démarrage.
           </div>
           <h3>Conseils pour débuter :</h3>
           <ul>
             <li>Vérifiez régulièrement l'onglet "Marché des missions" pour postuler.</li>
             <li>Assurez-vous d'avoir l'application GPS active lors de chaque prise en charge.</li>
             <li>Effectuez toujours les 20 photos obligatoires lors de l'état des lieux.</li>
           </ul>
           <p style="text-align: center;">
             <a href="https://bathily-convoyage.netlify.app/dashboard-convoyeur.html" class="btn">Accéder à mon Espace Convoyeur</a>
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
