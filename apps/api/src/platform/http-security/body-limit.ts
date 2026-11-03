import { bodyLimit } from 'hono/body-limit';
import { HttpProblem } from '#/platform/errors/problem.ts';

/** Request bodies above 16 KB are rejected before parsing (lead-capture §3, API4). */
export const MAX_BODY_BYTES = 16 * 1024;

export const bodyLimit16k = bodyLimit({
  maxSize: MAX_BODY_BYTES,
  onError: () => {
    throw new HttpProblem(413, 'payload_too_large');
  },
});
