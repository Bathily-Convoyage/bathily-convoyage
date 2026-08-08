-- Enforce bucket-level upload MIME + size limits
-- Does NOT modify public flags, RLS policies, or existing objects.
-- UPDATEs only existing buckets (all 3 are present in production).

UPDATE storage.buckets
SET
  file_size_limit = 5242880,
  allowed_mime_types = ARRAY[
    'application/pdf',
    'image/jpeg',
    'image/png'
  ]::text[]
WHERE id = 'documents';

UPDATE storage.buckets
SET
  file_size_limit = 5242880,
  allowed_mime_types = ARRAY[
    'application/pdf',
    'image/jpeg',
    'image/png'
  ]::text[]
WHERE id = 'convoyeur-documents';

UPDATE storage.buckets
SET
  file_size_limit = 31457280,
  allowed_mime_types = ARRAY[
    'image/jpeg',
    'image/png',
    'video/mp4',
    'video/quicktime'
  ]::text[]
WHERE id = 'convoyeur-media';
