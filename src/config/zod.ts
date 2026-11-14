import { z } from 'zod';
/**
 * Zod probes `new Function` to decide whether it may compile fast validators. Under the page
 * Content Security Policy the probe is refused and reported as a violation on every load, even
 * though Zod catches it. This turns the probe off; validation is unchanged.
 * Imported for its side effect before any schema is built.
 */
z.config({ jitless: true });
