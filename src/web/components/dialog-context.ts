import { createContext } from 'react';

// Kept apart from Dialog.tsx so that hot updates of the component module in development do not
// create a second context: popovers would then miss their dialog and open beneath its backdrop.
/** The open native dialog, so popovers inside it render in its top layer instead of the page body. */
export const DialogElementContext = createContext<HTMLElement | null>(null);
