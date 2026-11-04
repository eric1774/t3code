/**
 * Set to "1" in the env of every Claude process T3 Code launches. Claude Code mods that offer their
 * own session brief (for example the user's global session-brief mod) read it to switch themselves
 * off, so T3's `t3_brief_add` tool is the only brief writer inside T3 Code.
 */
export const T3_SESSION_BRIEF_ENV = "T3CODE_SESSION_BRIEF";
