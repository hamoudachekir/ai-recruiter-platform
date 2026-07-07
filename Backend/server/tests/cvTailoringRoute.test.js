const assert = require('assert');
const router = require('../routes/cvTailoringRoute');

// It exports an Express router (a function with a .stack of layers)
assert.strictEqual(typeof router, 'function', 'router should be a function');
const routePaths = router.stack.filter(l => l.route).map(l => l.route.path);
assert.ok(routePaths.includes('/tailor'), 'POST /tailor missing');
assert.ok(routePaths.includes('/tailor/export'), 'POST /tailor/export missing');
assert.ok(routePaths.includes('/tailored/:applicationId'), 'GET /tailored/:applicationId missing');

console.log('cvTailoringRoute.test OK');
