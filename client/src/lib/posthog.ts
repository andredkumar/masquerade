import posthog from 'posthog-js';

export function initPostHog() {
  if (typeof window !== 'undefined') {
    // Local sandbox sessions (docs/refactor/AUTOMASK_SANDBOX_RECON.md §4) must not write
    // events into the production PostHog project. Skip init on localhost or when the
    // build/dev env sets VITE_POSTHOG_DISABLED=1; the `posthog.capture` calls elsewhere
    // then no-op (posthog-js logs "must initialize" and returns) — no other change.
    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || import.meta.env.VITE_POSTHOG_DISABLED === '1') {
      return;
    }
    posthog.init('phc_KglrAXQ0Iq7Mve8IGNL6vQo1MekaN4VqN26v7wlVODs', {
      api_host: 'https://us.i.posthog.com',
      person_profiles: 'identified_only',
    });
  }
}

export { posthog };
