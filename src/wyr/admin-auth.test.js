import test from 'node:test';
import assert from 'node:assert/strict';
import { extractBearerToken, isAdminRequestAuthorized, isAdminTokenValid } from './admin-auth.js';

test('isAdminTokenValid accepts an exact match and rejects a wrong or empty token', () => {
  assert.equal(isAdminTokenValid('correct-token', 'correct-token'), true);
  assert.equal(isAdminTokenValid('wrong-token', 'correct-token'), false);
  assert.equal(isAdminTokenValid('', 'correct-token'), false);
  assert.equal(isAdminTokenValid('correct-token', ''), false);
  assert.equal(isAdminTokenValid('', ''), false);
});

test('isAdminTokenValid rejects tokens of a different length without throwing', () => {
  assert.equal(isAdminTokenValid('short', 'a-much-longer-correct-token'), false);
  assert.equal(isAdminTokenValid('a-much-longer-guess-than-the-real-token', 'short'), false);
});

test('extractBearerToken parses a well-formed Authorization header and trims whitespace', () => {
  assert.equal(extractBearerToken('Bearer abc123'), 'abc123');
  assert.equal(extractBearerToken('bearer abc123'), 'abc123');
  assert.equal(extractBearerToken('Bearer   abc123  '), 'abc123');
});

test('extractBearerToken returns an empty string for missing, malformed, or non-Bearer headers', () => {
  assert.equal(extractBearerToken(undefined), '');
  assert.equal(extractBearerToken(''), '');
  assert.equal(extractBearerToken('abc123'), '');
  assert.equal(extractBearerToken('Basic abc123'), '');
});

test('isAdminRequestAuthorized refuses every request when config.adminToken is not configured, even with a matching header', () => {
  const config = { adminToken: '' };
  assert.equal(isAdminRequestAuthorized({ authorization: 'Bearer anything' }, config), false);
});

test('isAdminRequestAuthorized authorizes only a request bearing the exact configured admin token', () => {
  const config = { adminToken: 'railway-admin-secret' };
  assert.equal(isAdminRequestAuthorized({ authorization: 'Bearer railway-admin-secret' }, config), true);
  assert.equal(isAdminRequestAuthorized({ authorization: 'Bearer wrong-secret' }, config), false);
  assert.equal(isAdminRequestAuthorized({}, config), false);
});

test('isAdminRequestAuthorized accepts the capitalized Authorization header form too', () => {
  const config = { adminToken: 'railway-admin-secret' };
  assert.equal(isAdminRequestAuthorized({ Authorization: 'Bearer railway-admin-secret' }, config), true);
});
