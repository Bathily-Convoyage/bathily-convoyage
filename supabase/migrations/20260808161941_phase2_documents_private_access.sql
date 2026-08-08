-- Drop legacy public/authenticated documents policies
DROP POLICY IF EXISTS "Documents lecture publique" ON storage.objects;
DROP POLICY IF EXISTS "Documents upload authentifie" ON storage.objects;
DROP POLICY IF EXISTS "Documents update bloque anon" ON storage.objects;
DROP POLICY IF EXISTS "Documents delete bloque" ON storage.objects;

CREATE POLICY "documents_select_owner"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'documents'
    AND (
      (
        split_part(name, '/', 1) = 'clients'
        AND split_part(name, '/', 2) = auth.uid()::text
        AND EXISTS (SELECT 1 FROM public.clients c WHERE c.auth_user_id = auth.uid())
      )
      OR
      (
        split_part(name, '/', 1) = 'convoyeurs'
        AND split_part(name, '/', 2) = auth.uid()::text
        AND EXISTS (SELECT 1 FROM public.convoyeurs cv WHERE cv.auth_user_id = auth.uid())
      )
    )
  );

CREATE POLICY "documents_select_admin"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'documents'
    AND public.is_admin()
  );

CREATE POLICY "documents_insert_owner"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'documents'
    AND name ~ '^(clients|convoyeurs)/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[^/]+$'
    AND (
      (
        split_part(name, '/', 1) = 'clients'
        AND split_part(name, '/', 2) = auth.uid()::text
        AND EXISTS (SELECT 1 FROM public.clients c WHERE c.auth_user_id = auth.uid())
      )
      OR
      (
        split_part(name, '/', 1) = 'convoyeurs'
        AND split_part(name, '/', 2) = auth.uid()::text
        AND EXISTS (SELECT 1 FROM public.convoyeurs cv WHERE cv.auth_user_id = auth.uid())
      )
    )
  );

CREATE POLICY "documents_delete_admin"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'documents'
    AND public.is_admin()
  );
