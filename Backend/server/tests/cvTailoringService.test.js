const assert = require('assert');
const path = require('path');
const svc = require('../services/cvTailoringService');

// resolveCvFilePath maps a stored /uploads path to disk under uploadDir
const uploadDir = path.join(__dirname, '..', 'uploads');
const abs = svc.resolveCvFilePath({ profile: { resume: '/uploads/cvs/123.pdf' } }, uploadDir);
assert.ok(abs.endsWith(path.join('uploads', 'cvs', '123.pdf')), 'should resolve under uploadDir: ' + abs);

// null when no resume
assert.strictEqual(svc.resolveCvFilePath({ profile: {} }, uploadDir), null);

// buildApplicationUpdate shapes the $set
const upd = svc.buildApplicationUpdate({
  pdf_path: '/uploads/tailored-cvs/x.pdf',
  tailored_cv_json: { summary: 's' },
  changes_applied: ['a', 'b'],
});
assert.strictEqual(upd.tailoredCvPath, '/uploads/tailored-cvs/x.pdf');
assert.deepStrictEqual(upd.tailoredCvChanges, ['a', 'b']);
assert.ok(upd.tailoredCvGeneratedAt instanceof Date);

console.log('cvTailoringService.test OK');

// buildCvJsonFromProfile (parser fallback)
const cvj = svc.buildCvJsonFromProfile({ name: 'Ada', email: 'a@x.io', profile: { phone: '123', skills: ['Python', 'SQL'], languages: ['English'], domain: 'Soft', shortDescription: 'sum', experience: [{ title: 'Dev', company: 'ACME', duration: '2020', description: 'd' }] } });
assert.strictEqual(cvj.name, 'Ada');
assert.strictEqual(cvj.role, 'CANDIDATE');
assert.strictEqual(cvj.profile.skills.length, 2);
assert.strictEqual(cvj.profile.experience[0].company, 'ACME');
assert.deepStrictEqual(cvj.education, []);
assert.deepStrictEqual(svc.buildCvJsonFromProfile({}).profile.skills, []);
console.log('buildCvJsonFromProfile OK');
