/**
 * Autocomplétion véhicules - Base locale JSON
 * S'utilise en complément de la recherche par plaque
 */

(function() {
  let vehiculesDB = null;

  // Charger la base de données
  async function loadVehiculesDB() {
    if (vehiculesDB) return vehiculesDB;
    try {
      const response = await fetch('data/vehicules-fr.json');
      vehiculesDB = await response.json();
      return vehiculesDB;
    } catch (err) {
      console.error('Erreur chargement base véhicules:', err);
      return null;
    }
  }

  // Remplir le select des marques
  async function populateMarques() {
    const db = await loadVehiculesDB();
    if (!db) return;

    const marqueSelect = document.getElementById('np-marque-select');
    if (!marqueSelect) return;

    // Garder l'option par défaut
    marqueSelect.innerHTML = '<option value="">Choisir une marque</option>';
    
    db.marques.forEach(marque => {
      const option = document.createElement('option');
      option.value = marque.nom;
      option.textContent = marque.nom;
      marqueSelect.appendChild(option);
    });
  }

  // Remplir les modèles selon la marque choisie
  async function populateModeles(marqueNom) {
    const db = await loadVehiculesDB();
    if (!db) return;

    const modeleSelect = document.getElementById('np-modele-select');
    if (!modeleSelect) return;

    // Réinitialiser
    modeleSelect.innerHTML = '<option value="">Choisir un modèle</option>';
    
    if (!marqueNom) {
      modeleSelect.disabled = true;
      return;
    }

    const marque = db.marques.find(m => m.nom === marqueNom);
    if (marque && marque.modeles) {
      marque.modeles.forEach(modele => {
        const option = document.createElement('option');
        option.value = modele;
        option.textContent = modele;
        modeleSelect.appendChild(option);
      });
      modeleSelect.disabled = false;
    }
  }

  // Initialiser les écouteurs d'événements
  function initVehiculeAutocomplete() {
    // Remplir les marques au chargement
    populateMarques();

    // Écouter le changement de marque
    const marqueSelect = document.getElementById('np-marque-select');
    if (marqueSelect) {
      marqueSelect.addEventListener('change', (e) => {
        populateModeles(e.target.value);
      });
    }

    // Synchroniser les selects avec les inputs texte (pour compatibilité)
    const marqueInput = document.getElementById('np-marque');
    const modeleInput = document.getElementById('np-modele');
    
    if (marqueSelect && marqueInput) {
      marqueSelect.addEventListener('change', () => {
        marqueInput.value = marqueSelect.value;
      });
    }
    
    const modeleSelect = document.getElementById('np-modele-select');
    if (modeleSelect && modeleInput) {
      modeleSelect.addEventListener('change', () => {
        modeleInput.value = modeleSelect.value;
      });
    }
  }

  // Attendre que le DOM soit prêt
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initVehiculeAutocomplete);
  } else {
    initVehiculeAutocomplete();
  }

  // Exposer la fonction pour usage externe
  window.reloadVehiculesDB = loadVehiculesDB;
  window.populateModeles = populateModeles;
})();
