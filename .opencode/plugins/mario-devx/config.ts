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
  
  // Maximum time to wait for a session to become idle (20 minutes)
  SESSION_IDLE_TIMEOUT_MS: 20 * 60 * 1000,
  
  // Window to prevent duplicate runs (8 seconds)
  RUN_DUPLICATE_WINDOW_MS: 8000,
  
  // Stale lock timeout (12 hours)
  STALE_LOCK_TIMEOUT_MS: 12 * 60 * 60 * 1000,
  
  // UI verification wait time (60 seconds)
  UI_VERIFY_WAIT_MS: 60000,
} as const;

// Retry and attempt limits
export const LIMITS = {
  // Maximum consecutive repair attempts with no progress
  MAX_NO_PROGRESS_STREAK: 3,
  
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

// Task statuses
export const TASK_STATUS = {
  OPEN: "open",
  IN_PROGRESS: "in_progress",
  BLOCKED: "blocked",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
} as const;

// Run phases and statuses
export const RUN_STATE = {
  PHASE: "run" as const,
  STATUS: {
    NONE: "NONE",
    DOING: "DOING",
    DONE: "DONE",
    BLOCKED: "BLOCKED",
  } as const,
};

// Verification results
export const VERIFICATION = {
  PASS: "PASS",
  FAIL: "FAIL",
} as const;

// LLM Response tags
export const LLM_TAGS = {
  PRD_INTERVIEW_JSON: "MARIO_JSON",
  PRD_INTERVIEW_QUESTION: "MARIO_QUESTION",
  FEATURE_JSON: "FEATURE_JSON",
  REPLAN_JSON: "REPLAN_JSON",
  VERIFIER_JSON: "VERIFIER_JSON",
} as const;
