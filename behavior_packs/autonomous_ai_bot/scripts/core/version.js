/**
 * Single source of truth for the pack's script version. It lives in its own
 * module so chat/UI code can read it without importing main.js, which would
 * create a circular import that the Bedrock module loader can resolve as
 * `undefined` during first evaluation.
 */
export const SCRIPT_VERSION = "1.3.1";
