/**
 * Autocomplétion adresses & villes — API BAN (api-adresse.data.gouv.fr)
 * Util partagé utilisable sur toutes les pages du site.
 *
 * Usage :
 *   AddressAutocomplete.setupCity(inputId, suggestId, onSelectCallback?)
 *   AddressAutocomplete.setupAddress(inputId, suggestId, onSelectCallback?)
 *   AddressAutocomplete.setupAddressWithCity(addrInputId, addrSuggestId, cpInputId, villeInputId)
 */
window.AddressAutocomplete = (function () {
  var _timers = {};

  function _debounce(key, fn, ms) {
    clearTimeout(_timers[key]);
    _timers[key] = setTimeout(fn, ms || 300);
  }

  async function _fetchSuggestions(query, limit) {
    if (!query || query.length < 2) return [];
    try {
      var url =
        'https://api-adresse.data.gouv.fr/search/?q=' +
        encodeURIComponent(query) +
        '&limit=' +
        (limit || 5);
      var res = await fetch(url);
      if (!res.ok) return [];
      var data = await res.json();
      if (!data.features) return [];
      return data.features.map(function (f) {
        return {
          label: f.properties.label,
          name: f.properties.name || f.properties.label,
          city: f.properties.city || '',
          postcode: f.properties.postcode || '',
          context: f.properties.context || ''
        };
      });
    } catch (e) {
      console.warn('AddressAutocomplete: erreur fetch', e);
      return [];
    }
  }

  function _hideBox(boxId) {
    var box = document.getElementById(boxId);
    if (box) box.style.display = 'none';
  }

  function _showBox(boxId, items, inputId, onSelect) {
    var box = document.getElementById(boxId);
    if (!box) return;
    box.innerHTML = '';
    if (!items.length) {
      box.style.display = 'none';
      return;
    }
    items.forEach(function (item) {
      var div = document.createElement('div');
      div.className = 'suggest-item';
      div.textContent = item.label;
      div.addEventListener('mousedown', function (e) {
        e.preventDefault();
        var input = document.getElementById(inputId);
        if (input) input.value = item.name;
        box.style.display = 'none';
        if (typeof onSelect === 'function') onSelect(item);
      });
      box.appendChild(div);
    });
    box.style.display = 'block';
  }

  /**
   * Autocomplétion ville uniquement (retourne ville + code postal)
   */
  function setupCity(inputId, suggestId, onSelect) {
    var input = document.getElementById(inputId);
    var box = document.getElementById(suggestId);
    if (!input || !box) return;

    input.setAttribute('autocomplete', 'off');

    input.addEventListener('input', function () {
      var q = this.value.trim();
      if (q.length < 2) {
        _hideBox(suggestId);
        return;
      }
      _debounce(inputId, async function () {
        var items = await _fetchSuggestions(q, 6);
        _showBox(suggestId, items, inputId, onSelect);
      });
    });

    input.addEventListener('blur', function () {
      setTimeout(function () {
        _hideBox(suggestId);
      }, 200);
    });
  }

  /**
   * Autocomplétion adresse complète (n° + rue + ville + CP)
   */
  function setupAddress(inputId, suggestId, onSelect) {
    var input = document.getElementById(inputId);
    var box = document.getElementById(suggestId);
    if (!input || !box) return;

    input.setAttribute('autocomplete', 'off');

    input.addEventListener('input', function () {
      var q = this.value.trim();
      if (q.length < 3) {
        _hideBox(suggestId);
        return;
      }
      _debounce(inputId, async function () {
        var items = await _fetchSuggestions(q, 5);
        _showBox(suggestId, items, inputId, onSelect);
      });
    });

    input.addEventListener('blur', function () {
      setTimeout(function () {
        _hideBox(suggestId);
      }, 200);
    });
  }

  /**
   * Autocomplétion adresse avec remplissage auto du CP et de la ville
   */
  function setupAddressWithCity(addrInputId, addrSuggestId, cpInputId, villeInputId) {
    setupAddress(addrInputId, addrSuggestId, function (item) {
      if (cpInputId) {
        var cp = document.getElementById(cpInputId);
        if (cp) cp.value = item.postcode;
      }
      if (villeInputId) {
        var ville = document.getElementById(villeInputId);
        if (ville) ville.value = item.city;
      }
    });
  }

  /**
   * Ferme toutes les suggest-box quand on clique en dehors
   */
  document.addEventListener('click', function (e) {
    if (!e.target.closest('.f-grp') && !e.target.closest('.search-wrapper')) {
      document.querySelectorAll('.suggest-box').forEach(function (b) {
        b.style.display = 'none';
      });
    }
  });

  return {
    setupCity: setupCity,
    setupAddress: setupAddress,
    setupAddressWithCity: setupAddressWithCity
  };
})();
