-- Make usage_adjustments.admin_user_id nullable and ON DELETE SET NULL
-- so deleting an admin who has made adjustments preserves the audit row
-- (just loses the admin attribution).
ALTER TABLE usage_adjustments
  ALTER COLUMN admin_user_id DROP NOT NULL;

ALTER TABLE usage_adjustments
  DROP CONSTRAINT IF EXISTS usage_adjustments_admin_user_id_users_id_fk;

ALTER TABLE usage_adjustments
  ADD CONSTRAINT usage_adjustments_admin_user_id_users_id_fk
    FOREIGN KEY (admin_user_id)
    REFERENCES users(id)
    ON DELETE SET NULL;
