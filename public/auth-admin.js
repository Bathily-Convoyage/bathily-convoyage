// Gestion de l'authentification admin
document.addEventListener('DOMContentLoaded', function() {
  console.log('🚀 Auth Admin script loaded');
  
  const loginBtn = document.getElementById('loginBtn');
  console.log('🔍 loginBtn found:', !!loginBtn);
  
  if (loginBtn) {
    console.log('✅ Attaching click listener to loginBtn');
    loginBtn.addEventListener('click', async function() {
      console.log('🖱️ Login button clicked!');
      
      const email = document.getElementById('adminEmailInput').value.trim();
      const password = document.getElementById('adminPasswordInput').value;
      
      if (!email || !password) {
        Swal.fire('Champs requis', 'Veuillez saisir email et mot de passe.', 'warning');
        return;
      }
      
      try {
        if (!window.SUPABASE_URL || !window.SUPABASE_ANON_KEY) {
          Swal.fire('Erreur', 'Configuration Supabase manquante.', 'error');
          return;
        }
        
        const sb = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
        const { data, error } = await sb.auth.signInWithPassword({ email, password });
        
        if (error) throw error;
        
        // Vérifier rôle admin
        const { data: profile, error: profileError } = await sb
          .from('clients')
          .select('role, prenom, nom')
          .eq('email', email)
          .maybeSingle();
          
        if (profileError || !profile || profile.role !== 'admin') {
          await sb.auth.signOut();
          throw new Error("Ce compte n'est pas administrateur.");
        }
        
        // Succès
        document.getElementById('authOverlay').classList.add('hidden');
        document.querySelector('.topbar').style.display = 'flex';
        document.querySelector('.dash-layout').style.display = 'flex';
        document.getElementById('adminName').textContent = (profile.prenom || 'Admin').toUpperCase();
        
        Swal.fire({
          title: 'Connexion réussie',
          text: 'Bienvenue ' + profile.prenom,
          icon: 'success',
          timer: 2000,
          showConfirmButton: false
        });
        
        // Charger les données si la fonction existe
        if (typeof loadAllData === 'function') {
          loadAllData();
        }
        
      } catch (err) {
        console.error(err);
        const errDiv = document.getElementById('authError');
        errDiv.style.display = 'block';
        errDiv.textContent = err.message || "Identifiants incorrects.";
        setTimeout(() => errDiv.style.display = 'none', 3000);
      }
    });
  }
  
  // Logout button
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async function() {
      const sb = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
      await sb.auth.signOut();
      document.getElementById('authOverlay').classList.remove('hidden');
      document.querySelector('.topbar').style.display = 'none';
      document.querySelector('.dash-layout').style.display = 'none';
    });
  }
});
