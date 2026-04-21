-- Execution log: anti-echo queries and activity stats
CREATE INDEX IF NOT EXISTS idx_exec_log_contact_action
  ON execution_log(location_id, contact_id, action_type, created_at DESC)
  WHERE success = true;

-- Execution log: activity dashboard
CREATE INDEX IF NOT EXISTS idx_exec_log_agent_activity
  ON execution_log(agent_id, location_id, action_type, created_at DESC)
  WHERE success = true;

-- Scheduled followups: processing queries
CREATE INDEX IF NOT EXISTS idx_followups_pending
  ON scheduled_followups(status, scheduled_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_followups_agent_contact
  ON scheduled_followups(agent_id, contact_id, status);
