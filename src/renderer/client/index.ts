import { createBrowserClient } from "./browser-client";
import type { WikilotClient } from "./wikilot-client";

export type { WikilotClient } from "./wikilot-client";
export { createBrowserClient } from "./browser-client";

/** Default Desktop Shell client (Browser HTTP/SSE transport). */
export const client: WikilotClient = createBrowserClient();
