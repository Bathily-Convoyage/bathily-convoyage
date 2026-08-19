/**
 * Autocomplétion adresses & villes — GéoPlateforme (data.geopf.fr)
 * Util partagé utilisable sur toutes les pages du site.
 *
 * Provider : https://data.geopf.fr/geocodage/completion/
 * - type=StreetAddress pour adresses complètes
 * - type=PositionOfInterest,StreetAddress pour villes/lieux
 *
 * Usage (API étendue) :
 *   AddressAutocomplete.initAddressAutocomplete(inputEl, suggestEl, opts)
 *
 * Usage (API historique — backward compatible) :
 *   AddressAutocomplete.setupCity(inputId, suggestId, onSelectCallback?)
 *   AddressAutocomplete.setupAddress(inputId, suggestId, onSelectCallback?)
 *   AddressAutocomplete.setupAddressWithCity(addrInputId, addrSuggestId, cpInputId, villeInputId)
 *
 * Caractéristiques :
 * - MIN_CHARS = 3
 * - DEBOUNCE = 300 ms
 * - MAX_SUGGESTIONS = 6
 * - AbortController : chaque nouvelle requête annule la précédente
 * - Clavier : ArrowDown, ArrowUp, Enter, Escape
 * - ARIA : role=listbox, role=option, aria-expanded, aria-activedescendant
 * - Souris + tactile (mousedown avec preventDefault)
 * - Click outside ferme la liste
 * - Blur différé pour permettre le clic sur suggestion
 * - Échec provider non bloquant (saisie manuelle toujours possible)
 * - Aucune fausse adresse / aucun fallback synthétique
 */
window.AddressAutocomplete = (function () {
  var MIN_CHARS = 3;
  var DEBOUNCE_MS = 300;
  var MAX_SUGGESTIONS = 6;
  var PROVIDER_URL = 'https://data.geopf.fr/geocodage/completion/';

  // Per-input state registry (avoids duplicate handlers)
  var _registry = {};

  function _getState(key) {
    if (!_registry[key]) {
      _registry[key] = {
        timer: null,
        abortController: null,
        activeIndex: -1,
        currentItems: [],
        requestId: 0
      };
    }
    return _registry[key];
  }


  // ── Provider fetch with AbortController ──
  async function _fetchCompletion(query, opts) {
    opts = opts || {};
    var stateKey = opts._stateKey || query;
    var state = _getState(stateKey);

    // Abort previous request and increment request ID for stale-response guard
    if (state.abortController) {
      try { state.abortController.abort(); } catch (e) {}
    }
    state.requestId++;
    var myRequestId = state.requestId;
    state.abortController = (typeof AbortController !== 'undefined') ? new AbortController() : null;

    var type = opts.type || 'StreetAddress';
    var limit = opts.limit || MAX_SUGGESTIONS;
    var url = PROVIDER_URL + '?text=' + encodeURIComponent(query) +
      '&type=' + encodeURIComponent(type) +
      '&maximumResponses=' + limit;

    try {
      var res = await fetch(url, {
        signal: state.abortController ? state.abortController.signal : undefined
      });
      if (!res.ok) return [];
      var data = await res.json();
      if (!data || data.status !== 'OK' || !Array.isArray(data.results)) return [];
      return data.results.map(function (r) {
        var city = r.city || (r.names && r.names[0]) || '';
        return {
          label: r.fulltext || '',
          name: r.fulltext || (r.street ? r.street + ', ' + city : city),
          city: city,
          postcode: r.zipcode || '',
          context: r.kind || r.country || '',
          latitude: (typeof r.y === 'number') ? r.y : null,
          longitude: (typeof r.x === 'number') ? r.x : null
        };
      }).filter(function (r) { return r.label; });
    } catch (e) {
      // AbortError is expected when a newer request supersedes — not an error
      if (e && e.name === 'AbortError') return null;
      console.warn('AddressAutocomplete: provider error', e);
      return null;
    }
  }

  // ── Render suggestions with ARIA ──
  function _renderSuggestions(box, items, input, stateKey, onSelect) {
    box.innerHTML = '';
    var state = _getState(stateKey);
    state.currentItems = items;
    state.activeIndex = -1;

    if (!items.length) {
      box.style.display = 'none';
      input.removeAttribute('aria-expanded');
      return;
    }

    box.setAttribute('role', 'listbox');
    box.setAttribute('aria-label', 'Suggestions d\'adresse');

    items.forEach(function (item, idx) {
      var div = document.createElement('div');
      div.className = 'suggest-item';
      div.setAttribute('role', 'option');
      div.setAttribute('id', stateKey + '-opt-' + idx);
      div.setAttribute('aria-label', item.label);
      div.textContent = item.label;
      // mousedown with preventDefault so the input doesn't lose focus before click registers
      div.addEventListener('mousedown', function (e) {
        e.preventDefault();
        _selectItem(input, box, item, stateKey, onSelect);
      });
      // touch support
      div.addEventListener('touchstart', function (e) {
        e.preventDefault();
        _selectItem(input, box, item, stateKey, onSelect);
      }, { passive: false });
      box.appendChild(div);
    });

    box.style.display = 'block';
    input.setAttribute('aria-expanded', 'true');
  }

  function _selectItem(input, box, item, stateKey, onSelect) {
    input.value = item.name || item.label;
    box.style.display = 'none';
    input.removeAttribute('aria-expanded');
    var state = _getState(stateKey);
    state.activeIndex = -1;
    if (typeof onSelect === 'function') onSelect(item);
  }

  function _hideBox(box, input) {
    if (box) box.style.display = 'none';
    if (input) input.removeAttribute('aria-expanded');
  }

  function _highlightActive(box, stateKey) {
    var state = _getState(stateKey);
    var opts = box.querySelectorAll('.suggest-item');
    opts.forEach(function (el, idx) {
      if (idx === state.activeIndex) {
        el.classList.add('active');
        el.setAttribute('aria-selected', 'true');
      } else {
        el.classList.remove('active');
        el.removeAttribute('aria-selected');
      }
    });
    var input = box.getAttribute('data-input-id');
    if (input && state.activeIndex >= 0) {
      var inputEl = document.getElementById(input);
      if (inputEl) {
        var activeOpt = document.getElementById(stateKey + '-opt-' + state.activeIndex);
        if (activeOpt) inputEl.setAttribute('aria-activedescendant', activeOpt.id);
      }
    }
  }

  // ── Keyboard navigation ──
  function _handleKeyDown(e, input, box, stateKey, onSelect) {
    var state = _getState(stateKey);
    var items = state.currentItems;
    if (!items.length || box.style.display === 'none') {
      if (e.key === 'Escape') { _hideBox(box, input); }
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      state.activeIndex = (state.activeIndex + 1) % items.length;
      _highlightActive(box, stateKey);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      state.activeIndex = (state.activeIndex - 1 + items.length) % items.length;
      _highlightActive(box, stateKey);
    } else if (e.key === 'Enter') {
      if (state.activeIndex >= 0 && state.activeIndex < items.length) {
        e.preventDefault();
        _selectItem(input, box, items[state.activeIndex], stateKey, onSelect);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      _hideBox(box, input);
    }
  }

  // ── Core init (extended API) ──
  // opts: { type, limit, onSelect, isCityOnly }
  function initAddressAutocomplete(inputEl, suggestEl, opts) {
    if (!inputEl || !suggestEl) return;
    opts = opts || {};
    var stateKey = inputEl.id || ('addr-' + Math.random().toString(36).substr(2, 9));
    var type = opts.isCityOnly ? 'StreetAddress,PositionOfInterest' : (opts.type || 'StreetAddress');
    var limit = opts.limit || MAX_SUGGESTIONS;
    var onSelect = opts.onSelect || null;

    // Prevent double initialization
    if (inputEl.getAttribute('data-aa-init') === stateKey) return;
    inputEl.setAttribute('data-aa-init', stateKey);
    inputEl.setAttribute('autocomplete', 'off');
    inputEl.setAttribute('aria-autocomplete', 'list');
    suggestEl.setAttribute('data-input-id', inputEl.id || stateKey);

    inputEl.addEventListener('input', function () {
      var q = this.value.trim();
      if (q.length < MIN_CHARS) {
        _hideBox(suggestEl, inputEl);
        return;
      }
      var self = this;
      var state = _getState(stateKey);
      clearTimeout(state.timer);
      state.timer = setTimeout(async function () {
        // Capture request ID before fetch — _fetchCompletion increments it
        var expectedRequestId = state.requestId + 1;
        var items = await _fetchCompletion(q, { type: type, limit: limit, _stateKey: stateKey });
        // items is null if aborted or errored — hide box and return
        if (items === null) {
          _hideBox(suggestEl, inputEl);
          return;
        }
        // Discard stale responses (a newer request was made while waiting)
        if (state.requestId !== expectedRequestId) return;
        // Only render if the input still has a query (not cleared while waiting)
        if (self.value.trim().length >= MIN_CHARS) {
          _renderSuggestions(suggestEl, items, inputEl, stateKey, onSelect);
        }
      }, DEBOUNCE_MS);
    });

    inputEl.addEventListener('keydown', function (e) {
      _handleKeyDown(e, inputEl, suggestEl, stateKey, onSelect);
    });

    // Delayed blur so mousedown on suggestion can fire first
    inputEl.addEventListener('blur', function () {
      setTimeout(function () { _hideBox(suggestEl, inputEl); }, 200);
    });
  }

  // ── Backward-compatible wrappers ──

  // setupCity: city/location suggestions (ville, depart, arrivee)
  function setupCity(inputId, suggestId, onSelect) {
    var input = document.getElementById(inputId);
    var box = document.getElementById(suggestId);
    if (!input || !box) return;
    initAddressAutocomplete(input, box, {
      isCityOnly: true,
      onSelect: onSelect
    });
  }

  // setupAddress: full address suggestions
  function setupAddress(inputId, suggestId, onSelect) {
    var input = document.getElementById(inputId);
    var box = document.getElementById(suggestId);
    if (!input || !box) return;
    initAddressAutocomplete(input, box, {
      type: 'StreetAddress',
      onSelect: onSelect
    });
  }

  // setupAddressWithCity: full address + auto-fill CP and ville
  function setupAddressWithCity(addrInputId, addrSuggestId, cpInputId, villeInputId) {
    var input = document.getElementById(addrInputId);
    var box = document.getElementById(addrSuggestId);
    if (!input || !box) return;
    initAddressAutocomplete(input, box, {
      type: 'StreetAddress',
      onSelect: function (item) {
        if (cpInputId) {
          var cp = document.getElementById(cpInputId);
          if (cp) cp.value = item.postcode;
        }
        if (villeInputId) {
          var ville = document.getElementById(villeInputId);
          if (ville) ville.value = item.city;
        }
      }
    });
  }

  // ── Click outside: close all suggestion boxes ──
  document.addEventListener('click', function (e) {
    if (!e.target.closest('.f-grp') && !e.target.closest('.search-wrapper') && !e.target.closest('.suggest-box')) {
      document.querySelectorAll('.suggest-box').forEach(function (b) {
        b.style.display = 'none';
      });
      document.querySelectorAll('[aria-expanded="true"]').forEach(function (el) {
        el.removeAttribute('aria-expanded');
      });
    }
  });

  return {
    initAddressAutocomplete: initAddressAutocomplete,
    setupCity: setupCity,
    setupAddress: setupAddress,
    setupAddressWithCity: setupAddressWithCity,
    // Exposed for testing
    _fetchCompletion: _fetchCompletion,
    _MIN_CHARS: MIN_CHARS,
    _DEBOUNCE_MS: DEBOUNCE_MS,
    _MAX_SUGGESTIONS: MAX_SUGGESTIONS,
    _PROVIDER_URL: PROVIDER_URL
  };
})();
