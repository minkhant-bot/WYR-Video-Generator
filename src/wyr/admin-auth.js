import { createHash, timingSafeEqual } from 'node:crypto';

const BEARER_PATTERN = /^Bearer\s+(.+)$/i;

// Hashing both sides to a fixed-length digest before comparing means a mismatched length can
// never short-circuit the comparison and leak timing information about how much of the token was
// guessed correctly -- unlike a direct string/Buffer compare of two different-length values.
const hash = value => createHash('sha256').update(String(value)).digest();

export const isAdminTokenValid = (provided, expected) => {
  if (!expected || !provided) return false;
  return timingSafeEqual(hash(provided), hash(expected));
};

export const extractBearerToken = authorizationHeader => {
  const match = typeof authorizationHeader === 'string' ? authorizationHeader.match(BEARER_PATTERN) : null;
  return match ? match[1].trim() : '';
};

// Reuses the project's existing Bearer-token convention (see content.js's Groq calls) with
// config.adminToken sourced the same way DATABASE_URL is: a Railway/production env var
// (WYR_ADMIN_TOKEN), never a request body or query string. A missing/blank config.adminToken
// means "admin endpoints are disabled on this deployment", never "open to anyone" -- there is no
// insecure default.
export const isAdminRequestAuthorized = (headers, config) => {
  if (!config.adminToken) return false;
  const provided = extractBearerToken(headers?.authorization ?? headers?.Authorization);
  return isAdminTokenValid(provided, config.adminToken);
};
