/**
 * Mission Phase Resolver — CONVOYEUR_MISSION_FLOW_V2_1B
 *
 * Canonical frontend phase derivation from server state.
 * Principle: SERVER_STATE_IS_SOURCE_OF_TRUTH.
 *
 * The resolver is a PURE function — no DOM, no Supabase, no side effects.
 * It takes server-verified inputs and returns a canonical UX phase.
 *
 * Inputs:
 *   status            — missions.status from backend (string)
 *   edlDepartExists   — boolean: an edls row with type='depart' exists for this mission
 *   edlArriveeExists  — boolean: an edls row with type='arrivee' exists for this mission
 *
 * Output:
 *   A phase string from UX_PHASES.
 *
 * The phase determines which screen to show and which actions are allowed.
 * The frontend must NEVER override the phase based on URL, localStorage, or memory.
 */

;(function (global) {
  'use strict';

  // =====================================================
  // Canonical mission statuses (DB CHECK constraint — do not change)
  // =====================================================
  var MISSION_STATUSES = {
    AVAILABLE: 'available',
    ASSIGNED: 'assigned',
    ACCEPTED: 'accepted',
    IN_PROGRESS: 'in_progress',
    DELIVERED: 'delivered',
    COMPLETED: 'completed',
    ARCHIVED: 'archived',
    CANCELLED: 'cancelled'
  };

  // =====================================================
  // UX phases derived from server state
  // =====================================================
  var UX_PHASES = {
    AVAILABLE: 'AVAILABLE',
    ASSIGNED: 'ASSIGNED',
    EDL_DEPART: 'EDL_DEPART',
    MISSION_READY_TO_START: 'MISSION_READY_TO_START',
    IN_PROGRESS: 'IN_PROGRESS',
    READY_TO_DELIVER: 'READY_TO_DELIVER',
    DELIVERED: 'DELIVERED',
    COMPLETED: 'COMPLETED',
    ARCHIVED: 'ARCHIVED',
    CANCELLED: 'CANCELLED',
    UNKNOWN: 'UNKNOWN'
  };

  // =====================================================
  // Primary action per phase (for UI single-action principle)
  // =====================================================
  var PRIMARY_ACTIONS = {};
  PRIMARY_ACTIONS[UX_PHASES.AVAILABLE] = null;
  PRIMARY_ACTIONS[UX_PHASES.ASSIGNED] = 'ACCEPTER';
  PRIMARY_ACTIONS[UX_PHASES.EDL_DEPART] = 'FAIRE_L_EDL_DEPART';
  PRIMARY_ACTIONS[UX_PHASES.MISSION_READY_TO_START] = 'DEMARRER_LA_MISSION';
  PRIMARY_ACTIONS[UX_PHASES.IN_PROGRESS] = 'MISSION_EN_COURS';
  PRIMARY_ACTIONS[UX_PHASES.READY_TO_DELIVER] = 'LIVRER';
  PRIMARY_ACTIONS[UX_PHASES.DELIVERED] = 'RECAPITULATIF';
  PRIMARY_ACTIONS[UX_PHASES.COMPLETED] = 'RECAPITULATIF';
  PRIMARY_ACTIONS[UX_PHASES.ARCHIVED] = null;
  PRIMARY_ACTIONS[UX_PHASES.CANCELLED] = null;
  PRIMARY_ACTIONS[UX_PHASES.UNKNOWN] = null;

  // =====================================================
  // Core resolver — pure function
  // =====================================================
  function resolveMissionPhase(status, edlDepartExists, edlArriveeExists) {
    if (typeof status !== 'string') return UX_PHASES.UNKNOWN;

    switch (status) {
      case MISSION_STATUSES.AVAILABLE:
        return UX_PHASES.AVAILABLE;

      case MISSION_STATUSES.ASSIGNED:
        return UX_PHASES.ASSIGNED;

      case MISSION_STATUSES.ACCEPTED:
        // EDL départ must be done before starting the mission.
        // If it exists → ready to start. If not → convoyeur must do EDL départ.
        return edlDepartExists ? UX_PHASES.MISSION_READY_TO_START : UX_PHASES.EDL_DEPART;

      case MISSION_STATUSES.IN_PROGRESS:
        // Mission is active. EDL départ replay is ALWAYS forbidden.
        // If EDL arrivée exists → ready to deliver. If not → mission in progress.
        return edlArriveeExists ? UX_PHASES.READY_TO_DELIVER : UX_PHASES.IN_PROGRESS;

      case MISSION_STATUSES.DELIVERED:
        return UX_PHASES.DELIVERED;

      case MISSION_STATUSES.COMPLETED:
        return UX_PHASES.COMPLETED;

      case MISSION_STATUSES.ARCHIVED:
        return UX_PHASES.ARCHIVED;

      case MISSION_STATUSES.CANCELLED:
        return UX_PHASES.CANCELLED;

      default:
        return UX_PHASES.UNKNOWN;
    }
  }

  // =====================================================
  // Phase predicates — gate helpers
  // =====================================================

  /** EDL départ can be created/edited only in EDL_DEPART phase. */
  function canEditEdlDepart(phase) {
    return phase === UX_PHASES.EDL_DEPART;
  }

  /** EDL départ replay (re-creation) is forbidden in any phase other than EDL_DEPART. */
  function isEdlDepartReplayBlocked(phase) {
    return phase !== UX_PHASES.EDL_DEPART;
  }

  /** EDL arrivée can be created only during IN_PROGRESS (mission active, no arrivée EDL yet). */
  function canEditEdlArrivee(phase) {
    return phase === UX_PHASES.IN_PROGRESS;
  }

  /** Mission can be started (transition accepted → in_progress) only after EDL départ validated. */
  function canStartMission(phase) {
    return phase === UX_PHASES.MISSION_READY_TO_START;
  }

  /** GPS tracking can be active only during IN_PROGRESS. */
  function canStartGps(phase) {
    return phase === UX_PHASES.IN_PROGRESS;
  }

  /** Mission can be delivered (transition in_progress → delivered) only after EDL arrivée. */
  function canDeliver(phase) {
    return phase === UX_PHASES.READY_TO_DELIVER;
  }

  /** Terminal states — no mutable EDL, no new actions. */
  function isTerminal(phase) {
    return phase === UX_PHASES.COMPLETED ||
           phase === UX_PHASES.ARCHIVED ||
           phase === UX_PHASES.CANCELLED;
  }

  /** Future steps are inaccessible — returns true if the requested action phase is ahead of current. */
  var PHASE_ORDER = [
    UX_PHASES.AVAILABLE,
    UX_PHASES.ASSIGNED,
    UX_PHASES.EDL_DEPART,
    UX_PHASES.MISSION_READY_TO_START,
    UX_PHASES.IN_PROGRESS,
    UX_PHASES.READY_TO_DELIVER,
    UX_PHASES.DELIVERED,
    UX_PHASES.COMPLETED,
    UX_PHASES.ARCHIVED
  ];

  function isFutureStep(currentPhase, requestedPhase) {
    var ci = PHASE_ORDER.indexOf(currentPhase);
    var ri = PHASE_ORDER.indexOf(requestedPhase);
    if (ci < 0 || ri < 0) return true; // unknown → treat as future (blocked)
    return ri > ci;
  }

  /** Past steps are consultable but not re-playable. */
  function isPastStep(currentPhase, requestedPhase) {
    var ci = PHASE_ORDER.indexOf(currentPhase);
    var ri = PHASE_ORDER.indexOf(requestedPhase);
    if (ci < 0 || ri < 0) return false;
    return ri < ci;
  }

  // =====================================================
  // Export
  // =====================================================
  var api = {
    MISSION_STATUSES: MISSION_STATUSES,
    UX_PHASES: UX_PHASES,
    PRIMARY_ACTIONS: PRIMARY_ACTIONS,
    resolveMissionPhase: resolveMissionPhase,
    canEditEdlDepart: canEditEdlDepart,
    isEdlDepartReplayBlocked: isEdlDepartReplayBlocked,
    canEditEdlArrivee: canEditEdlArrivee,
    canStartMission: canStartMission,
    canStartGps: canStartGps,
    canDeliver: canDeliver,
    isTerminal: isTerminal,
    isFutureStep: isFutureStep,
    isPastStep: isPastStep
  };

  // Browser global
  if (typeof window !== 'undefined') {
    window.MissionPhaseResolver = api;
  }
  // CommonJS (for Node tests)
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
