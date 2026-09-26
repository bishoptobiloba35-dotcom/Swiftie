-- Development-only identities used until the authentication module is connected.
INSERT INTO users (id, role, full_name, phone)
VALUES
  ('00000000-0000-4000-8000-000000000001', 'CUSTOMER', 'SwiftDrop Demo Customer', '+2340000000001'),
  ('00000000-0000-4000-8000-000000000002', 'DRIVER', 'SwiftDrop Demo Driver', '+2340000000002')
ON CONFLICT (id) DO NOTHING;

INSERT INTO drivers (id, user_id, status, online, vehicle_type)
VALUES
  ('00000000-0000-4000-8000-000000000003',
   '00000000-0000-4000-8000-000000000002',
   'APPROVED', true, 'Motorcycle')
ON CONFLICT (id) DO NOTHING;
