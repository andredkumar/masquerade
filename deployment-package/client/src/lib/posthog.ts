import posthog from 'posthog-js';

export function initPostHog() {
  if (typeof window !== 'undefined') {
    posthog.init('phc_KglrAXQ0Iq7Mve8IGNL6vQo1MekaN4VqN26v7wlVODs', {
      api_host: 'https://us.i.posthog.com',
      person_profiles: 'identified_only',
    });
  }
}

export { posthog };
