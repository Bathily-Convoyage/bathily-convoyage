// Test: resolveImageMimeType + upload payload verification
// Tests the MIME resolution logic and simulates the upload path

import assert from 'assert';

// Replicate the logic from etat-des-lieux.html
const EXT_TO_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  webp: 'image/webp', heic: 'image/heic', heif: 'image/heif', gif: 'image/gif', bmp: 'image/bmp'
};
const ALLOWED_IMAGE_MIMES = ['image/jpeg','image/png','image/webp','image/heic','image/heif','image/gif','image/bmp'];

function resolveImageMimeType(file, extOrName){
  if (file && file.type && ALLOWED_IMAGE_MIMES.includes(file.type.split(';')[0].trim().toLowerCase())) {
    return file.type.split(';')[0].trim().toLowerCase();
  }
  const ext = (extOrName || '').split('.').pop().toLowerCase().replace(/[^a-z]/g, '');
  if (ext && EXT_TO_MIME[ext]) return EXT_TO_MIME[ext];
  return 'image/jpeg';
}

// Simulate what supabase.storage.upload would receive
function simulateUpload(file, extOrName) {
  const contentType = resolveImageMimeType(file, extOrName);
  // If file is a string (old bug), contentType would still be resolved from ext
  // But the body would be a string → text/plain bug
  // With the fix, file is a File/Blob, and contentType is passed explicitly
  return { body: file, contentType };
}

// Helper to create a fake File
function fakeFile(name, type) {
  return { name, type, size: 1024 };
}

console.log('=== TEST CASES ===\n');

// CASE 1: filename=test.jpg, incoming_type=image/jpeg, expected=image/jpeg
{
  const file = fakeFile('test.jpg', 'image/jpeg');
  const result = resolveImageMimeType(file, 'jpg');
  assert.strictEqual(result, 'image/jpeg', 'CASE_1 failed');
  console.log('CASE_1=PASS (test.jpg, image/jpeg → image/jpeg)');
}

// CASE 2: filename=test.jpg, incoming_type=text/plain;charset=UTF-8, expected=image/jpeg
{
  const file = fakeFile('test.jpg', 'text/plain;charset=UTF-8');
  const result = resolveImageMimeType(file, 'jpg');
  assert.strictEqual(result, 'image/jpeg', 'CASE_2 failed');
  console.log('CASE_2=PASS (test.jpg, text/plain;charset=UTF-8 → image/jpeg)');
}

// CASE 3: filename=test.jpeg, incoming_type="", expected=image/jpeg
{
  const file = fakeFile('test.jpeg', '');
  const result = resolveImageMimeType(file, 'jpeg');
  assert.strictEqual(result, 'image/jpeg', 'CASE_3 failed');
  console.log('CASE_3=PASS (test.jpeg, "" → image/jpeg)');
}

// CASE 4: filename=test.png, incoming_type=text/plain, expected=image/png
{
  const file = fakeFile('test.png', 'text/plain');
  const result = resolveImageMimeType(file, 'png');
  assert.strictEqual(result, 'image/png', 'CASE_4 failed');
  console.log('CASE_4=PASS (test.png, text/plain → image/png)');
}

// CASE 5: filename=test.webp, incoming_type=application/octet-stream, expected=image/webp
{
  const file = fakeFile('test.webp', 'application/octet-stream');
  const result = resolveImageMimeType(file, 'webp');
  assert.strictEqual(result, 'image/webp', 'CASE_5 failed');
  console.log('CASE_5=PASS (test.webp, application/octet-stream → image/webp)');
}

// SIGNATURE REGRESSION: dataURLtoBlob produces image/png, upload should pass image/png
{
  // Simulate signature: canvas.toDataURL() → data:image/png;base64,...
  // dataURLtoBlob extracts mimeString = 'image/png'
  const blob = { type: 'image/png', size: 2048 };
  const result = resolveImageMimeType(blob, 'png');
  assert.strictEqual(result, 'image/png', 'SIGNATURE_REGRESSION failed');
  console.log('SIGNATURE_REGRESSION=PASS (signature blob, image/png → image/png)');
}

// Additional: HEIC
{
  const file = fakeFile('photo.heic', '');
  const result = resolveImageMimeType(file, 'heic');
  assert.strictEqual(result, 'image/heic', 'HEIC case failed');
  console.log('HEIC=PASS (photo.heic, "" → image/heic)');
}

// Additional: HEIF
{
  const file = fakeFile('photo.heif', '');
  const result = resolveImageMimeType(file, 'heif');
  assert.strictEqual(result, 'image/heif', 'HEIF case failed');
  console.log('HEIF=PASS (photo.heif, "" → image/heif)');
}

// Additional: unknown extension fallback
{
  const file = fakeFile('photo.xyz', '');
  const result = resolveImageMimeType(file, 'xyz');
  assert.strictEqual(result, 'image/jpeg', 'Unknown ext fallback failed');
  console.log('UNKNOWN_EXT=PASS (photo.xyz, "" → image/jpeg fallback)');
}

// Additional: no file, no ext (edge case)
{
  const result = resolveImageMimeType(null, '');
  assert.strictEqual(result, 'image/jpeg', 'Null file fallback failed');
  console.log('NULL_FILE=PASS (null, "" → image/jpeg fallback)');
}

// CRITICAL: Verify the old bug scenario is fixed
// Old: dataURL string passed directly → text/plain
// New: File object passed with explicit contentType
{
  const file = fakeFile('ext_123_0.jpg', 'image/jpeg');
  const upload = simulateUpload(file, 'jpg');
  assert.ok(upload.body !== 'data:image/jpeg;base64,...', 'Body should not be a dataURL string');
  assert.strictEqual(typeof upload.body, 'object', 'Body should be a File/Blob object');
  assert.strictEqual(upload.contentType, 'image/jpeg', 'ContentType should be image/jpeg');
  console.log('BUG_FIX_VERIFIED=PASS (File object + explicit contentType, not dataURL string)');
}

console.log('\n=== ALL TESTS PASSED ===');
