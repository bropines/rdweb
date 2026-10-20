// Set by app/vite.config.ts at build time.
declare const __RDWEB_BUILD__: { version: string; commit: string; date: string; id: string };

export const BUILD = __RDWEB_BUILD__;
export const SHORT_COMMIT = BUILD.commit.slice(0, 7);
export const COMMIT_URL = BUILD.commit ? `https://github.com/bropines/rdweb/commit/${BUILD.commit}` : "";
