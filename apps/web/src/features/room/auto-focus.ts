import { createContext } from "react";

/**
 * Whether a message box takes the focus when its room opens. The console turns it off: its keys
 * (J, K, A, Tab) are the owner's until they press C or click a box.
 */
export const ComposerAutoFocus = createContext(true);
