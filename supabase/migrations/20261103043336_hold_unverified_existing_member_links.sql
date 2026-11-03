-- Temporarily fence publication while registration provenance is installed.
-- Ordinary new HQ-created membership and branch delivery remain independent.
REVOKE EXECUTE ON FUNCTION ada_history.resolve_existing_member(uuid,text,text,text) FROM sccrm_hq_live_sync;
