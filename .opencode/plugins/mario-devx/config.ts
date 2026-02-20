/**
 * Mario DevX Configuration
 * 
 * All hardcoded timeouts, limits, and constants centralized here.
 * Modify these values to tune the plugin behavior.
 */

// Timeouts (in milliseconds)
export const TIMEOUTS = {
  // Maximum time to spend repairing a single task (25 minutes)
  MAX_TASK_REPAIR_MS: 25 * 60 * 1000,
  
  // Short idle settle before a final gate reconciliation pass (15 seconds)
  GATE_SETTLE_IDLE_MS: 15 * 1000,
  
  // Window to prevent duplicate runs (8 seconds)
  RUN_DUPLICATE_WINDOW_MS: 8000,
  
  // Stale lock timeout (12 hours)
  STALE_LOCK_TIMEOUT_MS: 12 * 60 * 60 * 1000,
  
  // UI verification wait time (60 seconds)
  UI_VERIFY_WAIT_MS: 60000,

  // Max wait for session prompt dispatch RPC before blocking run (45 seconds)
  PROMPT_DISPATCH_TIMEOUT_MS: 45 * 1000,

  // Max wait for work-session reset/revert RPC before blocking run (30 seconds)
  WORK_SESSION_RESET_TIMEOUT_MS: 30 * 1000,
} as const;

// Retry and attempt limits
export const LIMITS = {
  // Maximum consecutive repair attempts with no progress
  MAX_NO_PROGRESS_STREAK: 3,

  // Maximum verifier-driven semantic repair attempts per task/run
  MAX_VERIFIER_REPAIR_ATTEMPTS: 2,

  // Maximum combined repair turns (gate-repair + semantic-repair) per task/run
  MAX_TOTAL_REPAIR_ATTEMPTS: 5,
  
  // Maximum tasks to generate from a single feature
  MAX_FEATURE_TASKS: 5,
  
  // Minimum tasks for LLM-driven generation
  MIN_LLM_TASKS: 5,
  
  // Maximum tasks for LLM-driven generation
  MAX_LLM_TASKS: 15,
} as const;

// PRD Wizard requirements
export const WIZARD_REQUIREMENTS = {
  // Minimum number of must-have features
  MIN_FEATURES: 3,
  
  // Minimum number of quality gates
  MIN_QUALITY_GATES: 2,
  
  // Total wizard steps (for display)
  TOTAL_STEPS: 17,
} as const;
