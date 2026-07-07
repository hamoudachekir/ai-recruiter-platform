const assert = require('assert');
const Application = require('../models/Application');
const { requireCandidate } = require('../middleware/auth');

// Schema paths exist
const paths = Application.schema.paths;
assert.ok(paths['tailoredCvPath'], 'tailoredCvPath missing');
assert.ok(paths['tailoredCvChanges'], 'tailoredCvChanges missing');
assert.ok(paths['tailoredCvGeneratedAt'], 'tailoredCvGeneratedAt missing');
assert.ok(Application.schema.path('tailoredCvJson'), 'tailoredCvJson missing');

// requireCandidate allows CANDIDATE
let nextCalled = false;
requireCandidate({ user: { role: 'CANDIDATE', _id: 'x' } }, { status: () => ({ json: () => {} }) }, () => { nextCalled = true; });
assert.strictEqual(nextCalled, true, 'CANDIDATE should pass');

// requireCandidate blocks ENTERPRISE without _id fallback
let blocked = 0;
requireCandidate({ user: { role: 'ENTERPRISE' } }, { status: (c) => { blocked = c; return { json: () => {} }; } }, () => {});
assert.strictEqual(blocked, 403, 'ENTERPRISE should be blocked');

console.log('cvTailoring.model.test OK');
