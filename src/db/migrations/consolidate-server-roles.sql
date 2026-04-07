-- Consolidate dead server_members role values to 'member'
-- 'admin' and 'viewer' are no longer used; the server's local role system
-- (server_roles + user_roles tables) manages granular permissions.
UPDATE server_members SET role = 'member' WHERE role IN ('admin', 'viewer');
