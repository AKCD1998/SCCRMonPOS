-- Customer INSERT/UPDATE evaluates the active-name expression index as the
-- invoker. The restricted inbound worker therefore needs this pure normalizer,
-- even though it never calls the name-matching registration functions itself.
-- Keep the function invoker-only and all data/registration privileges intact.
DO $$
BEGIN
 IF (SELECT count(*) FROM ada_history.meta) <> 1 OR NOT EXISTS (
  SELECT 1 FROM ada_history.meta WHERE marker='ef76cc14-1b6b-49c9-8da7-1bfaea3dd92b'
   AND scope='LIVE-HQ000-ADAACC'
 ) THEN RAISE EXCEPTION 'LIVE_MIRROR_MARKER_REQUIRED'; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid='ada_history.member_name_key(text)'::regprocedure
  AND NOT prosecdef AND provolatile='i' AND prorettype='text'::regtype
  AND proconfig=ARRAY['search_path=pg_catalog'])
 THEN RAISE EXCEPTION 'MEMBER_NAME_NORMALIZER_CONTRACT_REFUSED'; END IF;
END $$;
GRANT EXECUTE ON FUNCTION ada_history.member_name_key(text) TO sccrm_hq_live_sync;
