import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merges Tailwind class names, letting later utilities win (shadcn/ui helper). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Class carried by every root element rdweb renders (the session shell and each
 * portal: dialogs, sheets, menus, selects, toasts). The prebuilt stylesheet
 * scopes its theme variables and base styles to it; with the host's own
 * Tailwind build it has no styles of its own.
 */
export const SCOPE = "rdweb";
