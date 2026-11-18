-- Pegar en Supabase > SQL Editor > Run
create table entregas (
  id bigint generated always as identity primary key,
  pedido text not null,
  cliente text,
  destino_lat double precision not null,
  destino_lng double precision not null,
  estado text not null default 'Pendiente',   -- Pendiente / En camino / Entregado
  chofer text,
  lat double precision,                        -- posición actual del chofer
  lng double precision,
  actualizado timestamptz default now()
);

-- Permisos abiertos (solo para la PoC)
alter table entregas enable row level security;
create policy "todo abierto" on entregas for all using (true) with check (true);

-- Activar tiempo real
alter publication supabase_realtime add table entregas;

-- Datos de ejemplo (zona CABA / GBA norte, cambiá a gusto)
insert into entregas (pedido, cliente, destino_lat, destino_lng) values
('P-001','Kiosco Norte',-34.5875,-58.4300),
('P-002','Ferretería Sur',-34.6350,-58.3900),
('P-003','Farmacia Centro',-34.6037,-58.3816),
('P-004','Almacén Oeste',-34.6100,-58.4600),
('P-005','Librería Palermo',-34.5880,-58.4200),
('P-006','Super Belgrano',-34.5630,-58.4560),
('P-007','Bazar Caballito',-34.6180,-58.4400),
('P-008','Panadería Boedo',-34.6300,-58.4150);
