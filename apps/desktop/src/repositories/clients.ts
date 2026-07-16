import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Client } from "@mep/core";
import type { ClientInput } from "@mep/core";
import { execute, select, selectOne } from "../lib/db";

interface ClientRow {
  id: number;
  name: string;
  company: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  tax_number: string | null;
  contacts: string | null;
  notes: string | null;
  created_at: string;
  project_count?: number;
}

function mapClient(r: ClientRow): Client & { projectCount: number } {
  return {
    id: r.id,
    name: r.name,
    company: r.company,
    address: r.address,
    phone: r.phone,
    email: r.email,
    taxNumber: r.tax_number,
    contacts: r.contacts,
    notes: r.notes,
    createdAt: r.created_at,
    projectCount: r.project_count ?? 0,
  };
}

export async function listClients() {
  const rows = await select<ClientRow>(
    `SELECT c.*, (SELECT COUNT(*) FROM projects p WHERE p.client_id = c.id) AS project_count
     FROM clients c ORDER BY c.name COLLATE NOCASE`,
  );
  return rows.map(mapClient);
}

export async function getClient(id: number) {
  const row = await selectOne<ClientRow>("SELECT * FROM clients WHERE id = $1", [id]);
  return row ? mapClient(row) : null;
}

export async function createClient(input: ClientInput): Promise<number> {
  const r = await execute(
    `INSERT INTO clients (name, company, address, phone, email, tax_number, contacts, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [input.name, input.company ?? null, input.address ?? null, input.phone ?? null,
     input.email ?? null, input.taxNumber ?? null, input.contacts ?? null, input.notes ?? null],
  );
  return r.lastInsertId ?? 0;
}

export async function updateClient(id: number, input: ClientInput): Promise<void> {
  await execute(
    `UPDATE clients SET name=$1, company=$2, address=$3, phone=$4, email=$5, tax_number=$6, contacts=$7, notes=$8
     WHERE id=$9`,
    [input.name, input.company ?? null, input.address ?? null, input.phone ?? null,
     input.email ?? null, input.taxNumber ?? null, input.contacts ?? null, input.notes ?? null, id],
  );
}

/** What a cascade delete would remove — shown in the confirmation dialog. */
export async function clientCascadeInfo(id: number) {
  const row = await selectOne<{ projects: number; contracts: number; certificates: number; payments: number }>(
    `SELECT
       (SELECT COUNT(*) FROM projects WHERE client_id=$1) AS projects,
       (SELECT COUNT(*) FROM contracts WHERE project_id IN (SELECT id FROM projects WHERE client_id=$1)) AS contracts,
       (SELECT COUNT(*) FROM payment_certificates WHERE contract_id IN
          (SELECT id FROM contracts WHERE project_id IN (SELECT id FROM projects WHERE client_id=$1))) AS certificates,
       (SELECT COUNT(*) FROM payments WHERE contract_id IN
          (SELECT id FROM contracts WHERE project_id IN (SELECT id FROM projects WHERE client_id=$1))) AS payments`,
    [id],
  );
  return row ?? { projects: 0, contracts: 0, certificates: 0, payments: 0 };
}

export async function deleteClient(id: number): Promise<void> {
  await execute("DELETE FROM clients WHERE id = $1", [id]);
}

export function useClients() {
  return useQuery({ queryKey: ["clients"], queryFn: listClients });
}

export function useClient(id: number) {
  return useQuery({ queryKey: ["clients", id], queryFn: () => getClient(id) });
}

export function useClientMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["clients"] });
    void qc.invalidateQueries({ queryKey: ["projects"] });
    void qc.invalidateQueries({ queryKey: ["financials"] });
  };
  return {
    create: useMutation({ mutationFn: createClient, onSuccess: invalidate }),
    update: useMutation({
      mutationFn: (v: { id: number; input: ClientInput }) => updateClient(v.id, v.input),
      onSuccess: invalidate,
    }),
    remove: useMutation({ mutationFn: deleteClient, onSuccess: invalidate }),
  };
}
