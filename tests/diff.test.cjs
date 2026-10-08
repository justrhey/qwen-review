const {test} = require('node:test');
const assert = require('node:assert/strict');
const {parse, align} = require('../workspace/diff.js');
const patch = (body) => 'diff --git a/app.js b/app.js\n--- a/app.js\n+++ b/app.js\n' + body;
test('replacement aligns old/new lines and pads unequal blocks', () => {
  const [file] = parse(patch('@@ -7,4 +7,3 @@ function\n context\n-old\n-extra\n+new\n tail\n'));
  assert.equal(file.path, 'app.js'); assert.equal(file.added, 1); assert.equal(file.removed, 2);
  const pairs = align(file.hunks[0].rows);
  assert.deepEqual(pairs.map(p => p.map(r => r && [r.old, r.new, r.text])), [[[7,7,'context'],[7,7,'context']],[[8,null,'old'],[null,8,'new']],[[9,null,'extra'],null],[[10,9,'tail'],[10,9,'tail']]]);
});
test('new/deleted files, one-line hunks and no-newline marker', () => {
  const files = parse('diff --git a/new b/new\n--- /dev/null\n+++ b/new\n@@ -0,0 +1 @@\n+hello\n\\ No newline at end of file\ndiff --git a/old b/old\n--- a/old\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n');
  assert.equal(files[0].hunks[0].rows[0].new, 1); assert.equal(files[0].hunks[0].rows[0].old, null); assert.equal(files[0].hunks[0].rows[0].noNewline, true); assert.equal(files[1].path, 'old'); assert.equal(files[1].removed,1);
});
test('headers inside code remain changed source, quoted UTF-8 paths decode', () => {
  const [file] = parse('diff --git "a/caf\\303\\251.js" "b/caf\\303\\251.js"\n--- "a/caf\\303\\251.js"\n+++ "b/caf\\303\\251.js"\n@@ -1 +1 @@\n--- old code\n+++ new code\n');
  assert.equal(file.path,'café.js'); assert.equal(file.hunks[0].rows[1].text,'++ new code');
});
test('multiple hunks reset numbers and preserve potentially unsafe source as text', () => {
  const [file] = parse(patch('@@ -1 +1 @@\n-a\n+b\n@@ -20 +25 @@\n-<script>alert(1)</script>\n+x\n'));
  assert.equal(file.hunks[1].rows[0].old,20); assert.equal(file.hunks[1].rows[1].new,25); assert.equal(file.hunks[1].rows[0].text,'<script>alert(1)</script>');
});
test('binary and rename metadata survive without fabricated source rows', () => {
  const [file] = parse('diff --git a/a b/b\nsimilarity index 100%\nrename from a\nrename to b\nBinary files a/a and b/b differ\n');
  assert.equal(file.path,'b'); assert.equal(file.hunks.length,0); assert.equal(file.metadata.length,4);
});
